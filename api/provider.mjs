import { createHash, createHmac, createPublicKey, randomUUID, timingSafeEqual, verify as verifySignature } from "node:crypto";
import sharp from "sharp";
import {
  ARK_BASE_URL,
  assembleArkContentFromDraft,
  buildArkDraftTextRequest,
  buildArkImageRequest,
  buildArkPageCandidatePrompt,
  buildArkPagePlanRequest,
  decodeArkImage,
  extractArkPagePlan,
  extractArkTextDraft,
  inspectImageBytes,
  isThreeByFourImage,
  pagePlanRetryGuidance,
  sha256Bytes,
  textQualityRetryGuidance,
} from "../src/ark-provider-core.mjs";
import { parseContentPackage } from "../src/content-engine.mjs";
import {
  buildAssetMapFromMotherSheets,
  buildIllustrationUnits,
  buildMotherSheetPrompt,
  groupIllustrationUnits,
  motherSheetRegionForUnit,
} from "../src/mother-sheet.mjs";
import {
  admitPublicImageJob,
  appendPublicImageJobs,
  completeCoveredNarrativePublicImageRun,
  completePublicImageRun,
  createPublicImageRun,
  exhaustPublicImageRun,
  failPublicImageJob,
  markPublicImageBudgetExhausted,
  parsePublicImageRun,
  publicImageRunProgress,
  startPublicImageJob,
  unresolvedPublicImageUnitIds,
} from "../src/public-image-run.mjs";
import { inspectMotherSheetTileStats } from "../src/mother-sheet-tile-quality.mjs";
import { inspectMotherSheetTilePixels } from "../src/mother-sheet-tile-quality.mjs";
import { detectKvTemplateRegions } from "../src/mother-sheet-adaptive-regions.mjs";
import { cleanupGeneratedGridArtifacts } from "../src/mother-sheet-artifact-cleanup.mjs";
import { detectUniformEdgeInsets, exactThreeByFourCrop } from "../src/mother-sheet-trim.mjs";
import { assertXhsPublishQuality } from "../src/xhs-publish-quality.mjs";
import {
  IMAGE_GENERATION_RESPONSE_SCHEMA,
  IMAGE_MEDIA_MANIFEST_SCHEMA,
  PAGE_CANDIDATE_RESPONSE_SCHEMA,
  TEXT_DRAFT_RESPONSE_SCHEMA,
  canonicalImageGenerationInputPreimage,
  parseImageGenerationRequest,
  parseImageGenerationResponse,
  parsePageCandidateRequest,
  parseTextDraftRequest,
} from "../src/provider-contract.mjs";
import { XIAOSHIMEI_AVATAR_DATA_URL } from "./xiaoshimei-avatar-data.mjs";

export const config = { maxDuration: 300 };

const IMAGE_PRICE_CNY = 0.22;
const DEFAULT_TEXT_MODEL = "doubao-seed-2-0-lite-260428";
const DEFAULT_IMAGE_MODEL = "doubao-seedream-5-0-lite-260128";
export const PUBLIC_GENERATION_RESPONSE_MAX_BYTES = 4_000_000;
// Leave enough headroom for base64 expansion, checkpoint metadata, the HMAC
// wrapper and Vercel's 4 MB response limit. A checkpoint that only fits before
// wrapping is not resumable in production.
const PUBLIC_TILE_PAYLOAD_BUDGET_BYTES = 2_300_000;
const PUBLIC_IMAGE_STEP_RESPONSE_SCHEMA = "xiaoshimei.public-image-step-response.v1";
export const ACCESS_SESSION_COOKIE = "__Host-xiaoshimei_session_";
export const ACCESS_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const ACCESS_COOKIE_HEADER_MAX_BYTES = 8_192;
export const ACCESS_SESSION_MAX_PAIRS = 16;
export const ACCESS_SESSION_PAID_MIN_REMAINING_MS = 270_000;
export const IMAGE_LEDGER_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const IMAGE_LEDGER_PHYSICAL_TTL_MS = 8 * 24 * 60 * 60 * 1000;
export const IMAGE_LEDGER_IN_FLIGHT_LEASE_MS = 360_000;
export const IMAGE_PLANNER_LEASE_MS = 240_000;
export const IMAGE_LEDGER_COMMIT_MARGIN_MS = 30_000;
export const IMAGE_TRANSACTION_RESPONSE_MAX_BYTES = 1_250_000;
export const IMAGE_ASSET_SHA256_HEADER = "x-content-sha256";
export const IMAGE_LEDGER_ATTESTATION_SCHEMA = "xiaoshimei.image-ledger-attestation.v1";
export const IMAGE_LEDGER_ATTESTATION_ENVELOPE_SCHEMA = "xiaoshimei.image-ledger-attestation-envelope.v1";
export const IMAGE_LEDGER_AUDIT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const IMAGE_LEDGER_RENEW_MAX_MS = 6 * 24 * 60 * 60 * 1000;
export const IMAGE_LEDGER_HARD_EXPIRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const SERVER_MANAGED_PROVIDER_ROUTES = new Set(["text-draft", "generate-images", "page-candidates"]);
const IMAGE_LEDGER_MAX_CACHE_BYTES = PUBLIC_GENERATION_RESPONSE_MAX_BYTES + 64_000;
const ACCESS_SESSION_COOKIE_PATTERN = /^__Host-xiaoshimei_session_([0-9a-f]{32})$/;
const ACCESS_SESSION_HMAC_DOMAIN = Buffer.from("xiaoshimei-access-session-v1\0", "utf8");

export function publicTileBudgetForResponse(unitCount) {
  const count = Math.max(1, Number(unitCount) || 1);
  return Math.max(56_000, Math.min(160_000, Math.floor(PUBLIC_TILE_PAYLOAD_BUDGET_BYTES / count)));
}

async function encodeTileForPublicTransport(baseTile, preferredAspect, maxBytes) {
  const ratio = preferredAspect === "9:8" ? 9 / 8 : 3 / 4;
  const profiles = [
    { width: 720, quality: 82 },
    { width: 640, quality: 76 },
    { width: 560, quality: 70 },
    { width: 480, quality: 64 },
    { width: 420, quality: 56 },
  ];
  let last = null;
  for (const profile of profiles) {
    const height = Math.round(profile.width / ratio);
    const bytes = await sharp(baseTile)
      .resize({ width: profile.width, height, fit: "cover", position: "centre" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: profile.quality, chromaSubsampling: "4:2:0", mozjpeg: true })
      .toBuffer();
    last = { bytes, width: profile.width, height };
    if (bytes.length <= maxBytes) return last;
  }
  if (last?.bytes.length <= maxBytes) return last;
  throw new Error(`PUBLIC_TILE_BUDGET_EXCEEDED:${last?.bytes.length || 0}:${maxBytes}`);
}

export function assertPublicGenerationResponseBudget(content) {
  const sizeBytes = Buffer.byteLength(JSON.stringify(content));
  if (sizeBytes > PUBLIC_GENERATION_RESPONSE_MAX_BYTES) {
    throw new Error(`PUBLIC_RESPONSE_BUDGET_EXCEEDED:${sizeBytes}:${PUBLIC_GENERATION_RESPONSE_MAX_BYTES}`);
  }
  return sizeBytes;
}

function cleanModel(value, fallback) {
  const model = String(value || fallback).trim();
  if (!/^[A-Za-z0-9_.:-]{3,120}$/.test(model)) throw new TypeError("MODEL_ID_INVALID");
  return model;
}

function serverApiKeyFromEnv(env = process.env) {
  return String(env?.ARK_API_KEY || "").trim();
}

function configuredServerManaged(env = process.env) {
  return serverApiKeyFromEnv(env).length >= 8;
}

function configuredOrigin(value) {
  const raw = String(value || "").trim().replace(/\/$/, "");
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.origin !== raw || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function configuredPreviewOrigin(env = process.env) {
  if (String(env?.VERCEL_ENV || "").trim() !== "preview") return "";
  const hostname = String(env?.VERCEL_URL || "").trim().toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.vercel\.app$/.test(hostname)) return "";
  return configuredOrigin(`https://${hostname}`);
}

export function inspectServerAccessConfig(env = process.env) {
  const accessCodeSha256 = String(env?.XIAOSHIMEI_ACCESS_CODE_SHA256 || "").trim().toLowerCase();
  const sessionSecret = String(env?.XIAOSHIMEI_SESSION_SECRET || "").trim();
  const appOrigin = configuredPreviewOrigin(env) || configuredOrigin(env?.XIAOSHIMEI_APP_ORIGIN);
  const ready = /^[0-9a-f]{64}$/.test(accessCodeSha256) && sessionSecret.length >= 32 && Boolean(appOrigin);
  const appScope = appOrigin ? `xiaoshimei-studio:${createHash("sha256").update(appOrigin).digest("hex").slice(0, 32)}` : "";
  return { ready, accessCodeSha256, sessionSecret, appOrigin, appScope };
}

function imageLedgerEnv(env = process.env) {
  const url = String(env?.UPSTASH_REDIS_REST_URL || env?.KV_REST_API_URL || "").trim().replace(/\/$/, "");
  const token = String(env?.UPSTASH_REDIS_REST_TOKEN || env?.KV_REST_API_TOKEN || "").trim();
  let validUrl = false;
  try { validUrl = new URL(url).protocol === "https:"; } catch { validUrl = false; }
  return { url, token, ready: validUrl && token.length >= 16 };
}

function imageLedgerRuntimeBinding(env = process.env, appScopeId = "", restUrl = "") {
  let restOrigin = "";
  try { restOrigin = new URL(restUrl).origin; } catch { restOrigin = ""; }
  const publicKey = String(env?.XIAOSHIMEI_LEDGER_ATTESTATION_PUBLIC_KEY || "").trim();
  const databaseIdSha256 = String(env?.XIAOSHIMEI_UPSTASH_DATABASE_ID_SHA256 || "").trim().toLowerCase();
  const vercelProjectId = String(env?.XIAOSHIMEI_VERCEL_PROJECT_ID || env?.VERCEL_PROJECT_ID || "").trim();
  const vercelEnvironment = String(env?.VERCEL_ENV || "").trim();
  const candidateCommit = String(env?.XIAOSHIMEI_CANDIDATE_COMMIT || env?.VERCEL_GIT_COMMIT_SHA || "").trim().toLowerCase();
  return {
    ready: Boolean(publicKey)
      && /^[0-9a-f]{64}$/.test(databaseIdSha256)
      && Boolean(restOrigin && appScopeId && vercelProjectId && vercelEnvironment)
      && /^[0-9a-f]{40}$/.test(candidateCommit),
    publicKey,
    expected: {
      database_id_sha256: databaseIdSha256,
      rest_origin: restOrigin,
      app_scope: appScopeId,
      vercel_project_id: vercelProjectId,
      vercel_environment: vercelEnvironment,
      candidate_commit: candidateCommit,
    },
  };
}

function requestHeader(request, name) {
  const value = request?.headers?.[name] ?? request?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? "" : String(value || "");
}

function requestHasExactSameOriginWriteGate(request, expectedOrigin) {
  if (!expectedOrigin || requestHeader(request, "origin") !== expectedOrigin) return false;
  let expected;
  try { expected = new URL(expectedOrigin); } catch { return false; }
  return requestHeader(request, "sec-fetch-site") === "same-origin"
    && requestHeader(request, "host") === expected.host
    && requestHeader(request, "x-forwarded-host") === expected.host
    && requestHeader(request, "x-forwarded-proto") === "https";
}

function requestHasExactSameOriginReadGate(request, expectedOrigin) {
  if (!expectedOrigin) return false;
  let expected;
  try { expected = new URL(expectedOrigin); } catch { return false; }
  const origin = requestHeader(request, "origin");
  return (origin === "" || origin === expectedOrigin)
    && requestHeader(request, "sec-fetch-site") === "same-origin"
    && requestHeader(request, "host") === expected.host
    && requestHeader(request, "x-forwarded-host") === expected.host
    && requestHeader(request, "x-forwarded-proto") === "https";
}

function safeEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && timingSafeEqual(left, right);
}

export function mintAccessSession(configValue, { nowMs = Date.now(), sessionId = randomUUID() } = {}) {
  if (!configValue?.ready) throw new TypeError("ACCESS_CONFIGURATION_REQUIRED");
  const issuedAt = Math.floor(nowMs / 1000);
  const claims = {
    v: 1,
    app_scope: configValue.appScope,
    origin: configValue.appOrigin,
    sid: String(sessionId),
    iat: issuedAt,
    exp: issuedAt + ACCESS_SESSION_TTL_SECONDS,
  };
  const payload = Buffer.from(canonicalJson(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", configValue.sessionSecret).update(ACCESS_SESSION_HMAC_DOMAIN).update(payload).digest("base64url");
  const token = `${payload}.${signature}`;
  const tokenSha256 = createHash("sha256").update(token, "utf8").digest("hex");
  return {
    token,
    cookieName: `${ACCESS_SESSION_COOKIE}${tokenSha256.slice(0, 32)}`,
    tokenSha256,
    claims,
    expiresAt: new Date(claims.exp * 1000),
  };
}

function decodeCanonicalBase64Url(value, { exactBytes = null } = {}) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.includes("=")) return null;
  let bytes;
  try { bytes = Buffer.from(value, "base64url"); } catch { return null; }
  if (!bytes.length || bytes.toString("base64url") !== value) return null;
  if (exactBytes != null && bytes.length !== exactBytes) return null;
  return bytes;
}

function parseAccessSession(token, configValue, { nowMs = Date.now() } = {}) {
  if (!configValue?.ready || typeof token !== "string" || token.length > 2_048) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].length !== 43) return null;
  const payloadBytes = decodeCanonicalBase64Url(parts[0]);
  const actualSignature = decodeCanonicalBase64Url(parts[1], { exactBytes: 32 });
  if (!payloadBytes || !actualSignature) return null;
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const exactKeys = ["app_scope", "exp", "iat", "origin", "sid", "v"];
  if (Object.keys(payload).sort().join("\0") !== exactKeys.join("\0")) return null;
  if (canonicalJson(payload) !== payloadBytes.toString("utf8")) return null;
  const expectedSignature = createHmac("sha256", configValue.sessionSecret).update(ACCESS_SESSION_HMAC_DOMAIN).update(parts[0]).digest();
  if (!safeEqual(actualSignature, expectedSignature)) return null;
  const now = Math.floor(nowMs / 1000);
  const valid = payload.v === 1
    && payload.app_scope === configValue.appScope
    && payload.origin === configValue.appOrigin
    && typeof payload.sid === "string" && payload.sid.length >= 8 && payload.sid.length <= 160
    && Number.isInteger(payload.iat) && Number.isInteger(payload.exp)
    && payload.iat <= now + 60 && payload.exp > now && payload.exp - payload.iat === ACCESS_SESSION_TTL_SECONDS;
  return valid ? payload : null;
}

export function verifyAccessSession(token, configValue, { nowMs = Date.now() } = {}) {
  return Boolean(parseAccessSession(token, configValue, { nowMs }));
}

function parseCookiePairs(header) {
  const pairs = [];
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    pairs.push({ name, value: part.slice(separator + 1).trim() });
  }
  return pairs;
}

export function inspectAccessSessionCandidates(cookieHeader, accessConfig, { nowMs = Date.now(), allowFamilyOverflow = false } = {}) {
  const header = String(cookieHeader || "");
  const rawBytes = Buffer.byteLength(header, "utf8");
  const pairs = parseCookiePairs(header);
  const familyPairs = pairs.filter((pair) => ACCESS_SESSION_COOKIE_PATTERN.test(pair.name));
  const headerTooLarge = rawBytes > ACCESS_COOKIE_HEADER_MAX_BYTES;
  const familyOverflow = familyPairs.length > ACCESS_SESSION_MAX_PAIRS;
  const valid = [];
  if (!headerTooLarge && (!familyOverflow || allowFamilyOverflow)) {
    for (const pair of familyPairs) {
      const claims = parseAccessSession(pair.value, accessConfig, { nowMs });
      if (!claims) continue;
      const tokenSha256 = createHash("sha256").update(pair.value, "utf8").digest("hex");
      if (pair.name !== `${ACCESS_SESSION_COOKIE}${tokenSha256.slice(0, 32)}`) continue;
      valid.push({
        cookieName: pair.name,
        token: pair.value,
        tokenSha256,
        claims,
      });
    }
  }
  valid.sort((left, right) => {
    const leftKey = [left.claims.iat, left.claims.exp, left.tokenSha256, left.cookieName];
    const rightKey = [right.claims.iat, right.claims.exp, right.tokenSha256, right.cookieName];
    for (let index = 0; index < leftKey.length; index += 1) {
      if (leftKey[index] < rightKey[index]) return -1;
      if (leftKey[index] > rightKey[index]) return 1;
    }
    return 0;
  });
  const preferred = valid.at(-1) || null;
  const capabilityExpiresAtMs = valid.length ? Math.max(...valid.map((item) => item.claims.exp * 1_000)) : 0;
  return {
    rawBytes,
    headerTooLarge,
    familyPairCount: familyPairs.length,
    familyOverflow,
    familyPairs,
    valid,
    preferred,
    capabilityExpiresAtMs,
    authenticated: !headerTooLarge && !familyOverflow && Boolean(preferred),
  };
}

function boundedAccessCode(body) {
  let serialized;
  try { serialized = JSON.stringify(body ?? null); } catch { throw new TypeError("ACCESS_CODE_INVALID"); }
  if (Buffer.byteLength(serialized) > 1024 || !body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("ACCESS_CODE_INVALID");
  const code = body.code;
  if (typeof code !== "string" || code.length < 1 || code.length > 256) throw new TypeError("ACCESS_CODE_INVALID");
  return code;
}

function accessCodeMatches(code, accessConfig) {
  if (!accessConfig?.ready) return false;
  const actual = createHash("sha256").update(code, "utf8").digest();
  const expected = Buffer.from(accessConfig.accessCodeSha256, "hex");
  return safeEqual(actual, expected);
}

function accessSessionCookie(session) {
  return `${session.cookieName}=${session.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ACCESS_SESSION_TTL_SECONDS}`;
}

function deleteAccessSessionCookie(cookieName) {
  return `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function requestConfig(request, env = process.env) {
  const serverApiKey = serverApiKeyFromEnv(env);
  const authorization = requestHeader(request, "authorization");
  const browserApiKey = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const apiKey = serverApiKey || browserApiKey;
  if (apiKey.length < 8) throw new TypeError("ARK_API_KEY_REQUIRED");
  const serverManaged = serverApiKey.length >= 8;
  return {
    apiKey,
    credentialMode: serverManaged ? "SERVER_MANAGED" : "BROWSER_BYOK",
    textModel: cleanModel(serverManaged ? env?.ARK_TEXT_MODEL : requestHeader(request, "x-xiaoshimei-text-model"), DEFAULT_TEXT_MODEL),
    imageModel: cleanModel(serverManaged ? env?.ARK_IMAGE_MODEL : requestHeader(request, "x-xiaoshimei-image-model"), DEFAULT_IMAGE_MODEL),
  };
}

function publicProviderConfig(request, { env = process.env, nowMs = Date.now() } = {}) {
  const configured = configuredServerManaged(env);
  const access = inspectServerAccessConfig(env);
  const ledger = imageLedgerEnv(env);
  const candidates = configured && access.ready
    ? inspectAccessSessionCandidates(requestHeader(request, "cookie"), access, { nowMs })
    : { authenticated: false };
  const authenticated = Boolean(candidates.authenticated);
  return {
    status: configured ? access.ready ? authenticated ? "CONFIGURED_UNVERIFIED" : "ACCESS_SESSION_REQUIRED" : "ACCESS_CONFIGURATION_REQUIRED" : "AWAITING_BYOK",
    configured,
    access_required: configured,
    access_configured: configured && access.ready,
    authenticated,
    image_ledger_configured: ledger.ready,
    provider: "volcengine-ark",
    provider_label: "火山方舟",
    base_url: ARK_BASE_URL,
    text_model: cleanModel(env?.ARK_TEXT_MODEL, DEFAULT_TEXT_MODEL),
    image_model: cleanModel(env?.ARK_IMAGE_MODEL, DEFAULT_IMAGE_MODEL),
    credential_mode: configured ? "SERVER_MANAGED" : "BROWSER_BYOK",
    key_store: configured ? "Vercel Sensitive Environment Variable" : "当前标签页 sessionStorage",
  };
}

function routeName(request) {
  const value = Array.isArray(request.query?.route) ? request.query.route[0] : request.query?.route;
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function send(response, status, body) {
  response.status(status).setHeader("cache-control", "no-store").json(body);
}

async function arkPost(path, apiKey, body, stage) {
  let upstream;
  try {
    upstream = await fetch(`${ARK_BASE_URL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(210_000),
    });
  } catch (error) {
    throw new Error(`${stage}:NETWORK_FETCH_FAILED:${String(error?.name || "UNKNOWN")}`);
  }
  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const providerError = payload?.error || payload || {};
    const code = String(providerError.code || `HTTP_${upstream.status}`).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
    const message = String(providerError.message || "").replace(/[\r\n\t]+/g, " ").slice(0, 220);
    throw new Error(`${stage}:${code}${message ? `:${message}` : ""}`);
  }
  return payload;
}

async function imagePayload(payload) {
  const decoded = decodeArkImage(payload);
  let bytes;
  if (decoded.kind === "base64") bytes = Buffer.from(decoded.value, "base64");
  else {
    const response = await fetch(decoded.value, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`IMAGE_ASSET_DOWNLOAD_${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length < 1024) throw new Error("ARK_IMAGE_TOO_SMALL");
  const info = inspectImageBytes(bytes);
  if (!isThreeByFourImage(info)) throw new Error(`ARK_IMAGE_ASPECT_RATIO_INVALID:${info.width}x${info.height}`);
  return {
    bytes,
    info,
    dataUrl: `data:${info.mime};base64,${bytes.toString("base64")}`,
    sha256: sha256Bytes(bytes),
  };
}

async function generateTextDraft(input, settings) {
  let draft;
  let finalError;
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const qualityFeedback = finalError ? textQualityRetryGuidance(finalError) : "";
    const result = await arkPost("/responses", settings.apiKey, buildArkDraftTextRequest({ ...input, quality_feedback: qualityFeedback }, settings.textModel), "TEXT_DRAFT_MODEL_CALL_FAILED");
    try {
      draft = extractArkTextDraft(result, { topic: input.topic, pillar: input.pillar, goal: input.goal });
      attempts.push({ attempt, status: "PASS" });
      break;
    } catch (error) {
      finalError = error;
      attempts.push({ attempt, status: "REJECTED", rejection_code: String(error?.message || error).slice(0, 180) });
    }
  }
  if (!draft) throw finalError || new Error("TEXT_DRAFT_REJECTED");
  const runId = `text-web-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return {
    schema: TEXT_DRAFT_RESPONSE_SCHEMA,
    draft_id: runId,
    created_at: new Date().toISOString(),
    source_input: input.topic,
    content_type: draft.contentType,
    ...(input.profile_contract.style_lock ? { style_lock: input.profile_contract.style_lock } : {}),
    text_requirements: input.text_requirements || "",
    prompt_context: input.prompt_context,
    pillar: input.pillar,
    goal: input.goal,
    titles: draft.titles,
    selected_title: draft.selectedTitle,
    body: draft.body,
    tags: draft.tags,
    recommended_image_count: draft.recommendedImageCount,
    facts: draft.facts,
    risks: draft.risks,
    quality_repairs: draft.qualityRepairs || [],
    generation: { provider: "volcengine-ark", text_model: settings.textModel, status: "TEXT_READY_FOR_USER_CONFIRMATION", attempts },
  };
}

export async function splitMotherSheetForUnits(bytes, jobOrUnits, options = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1024) throw new TypeError("MOTHER_SHEET_BYTES_INVALID");
  const job = Array.isArray(jobOrUnits) ? { template: "grid-3x3", units: jobOrUnits } : jobOrUnits;
  const units = job?.units;
  if (!Array.isArray(units) || units.length < 1 || units.length > 9) throw new TypeError("MOTHER_SHEET_UNITS_INVALID");
  const maxBytes = Math.max(32_000, Number(options.maxBytes) || 160_000);
  const allowMissing = options.allowMissing === true;
  const metadata = await sharp(bytes).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height || Math.abs(width / height - .75) > .01) {
    throw new Error(`MOTHER_SHEET_ASPECT_RATIO_INVALID:${width}x${height}`);
  }
  let adaptiveKv = null;
  if (job?.template === "kv-top-3x2") {
    const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    adaptiveKv = detectKvTemplateRegions({ data: new Uint8Array(raw.data), width: raw.info.width, height: raw.info.height, channels: raw.info.channels });
    if (!adaptiveKv) {
      if (!allowMissing) throw new Error("MOTHER_SHEET_KV_BOUNDARY_NOT_FOUND");
      return units.map((unit, index) => ({
        unit_id: unit.unit_id,
        page_index: unit.page_index,
        panel_index: unit.panel_index,
        missing: true,
        mother_sheet_slot: index === 0 ? 1 : index + 6,
        mother_sheet_region_role: index === 0 ? "kv-top-adaptive-9:8" : "illustration-adaptive-3:4",
        presence_gate: { hasVisibleSubject: false, reason: "KV_BOUNDARY_NOT_FOUND" },
      }));
    }
  }
  return Promise.all(units.map(async (unit, index) => {
    const adaptiveRegion = adaptiveKv?.regions[index];
    const region = adaptiveRegion
      ? { ...adaptiveRegion, slotIndex: index === 0 ? 0 : index + 5, regionRole: index === 0 ? "kv-top-adaptive-9:8" : "illustration-adaptive-3:4" }
      : motherSheetRegionForUnit(width, height, job, index);
    const { slotIndex, regionRole, ...cropRegion } = region;
    const preferredAspect = regionRole.includes("kv-top") ? "9:8" : "3:4";
    let baseTile = await sharp(bytes).extract(cropRegion).png().toBuffer();
    const rawTile = await sharp(baseTile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const cleaned = cleanupGeneratedGridArtifacts(
      { data: new Uint8Array(rawTile.data), width: rawTile.info.width, height: rawTile.info.height, channels: rawTile.info.channels },
      { kv: regionRole === "kv-2x2-3:4", enforceWhitePaper: preferredAspect === "3:4" },
    );
    let cleanedPipeline = sharp(Buffer.from(cleaned.data), { raw: { width: cleaned.width, height: cleaned.height, channels: cleaned.channels } });
    if (preferredAspect === "3:4") {
      const insets = detectUniformEdgeInsets(cleaned);
      const exact = exactThreeByFourCrop(cleaned.width, cleaned.height, insets);
      cleanedPipeline = cleanedPipeline.extract(exact);
    }
    baseTile = await cleanedPipeline.png().toBuffer();
    const quality = inspectMotherSheetTileStats(await sharp(baseTile).stats());
    if (!quality.hasVisibleSubject) {
      if (!allowMissing) throw new Error(`MOTHER_SHEET_UNIT_MISSING:${unit.unit_id}`);
      return {
        unit_id: unit.unit_id,
        page_index: unit.page_index,
        panel_index: unit.panel_index,
        missing: true,
        mother_sheet_slot: slotIndex + 1,
        mother_sheet_region_role: regionRole,
        presence_gate: quality,
      };
    }
    const tile = await encodeTileForPublicTransport(baseTile, preferredAspect, maxBytes);
    const tileBytes = tile.bytes;
    const finalRaw = await sharp(tileBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixelGate = inspectMotherSheetTilePixels({ data: new Uint8Array(finalRaw.data), width: finalRaw.info.width, height: finalRaw.info.height, channels: finalRaw.info.channels }, { expectedAspect: preferredAspect });
    if (!pixelGate.hasCleanEdges) {
      if (!allowMissing) throw new Error(`MOTHER_SHEET_TILE_CONTAMINATED:${unit.unit_id}:${pixelGate.contaminatedSides.join("+") || "ASPECT"}`);
      return {
        unit_id: unit.unit_id, page_index: unit.page_index, panel_index: unit.panel_index, missing: true,
        mother_sheet_slot: slotIndex + 1, mother_sheet_region_role: regionRole,
        presence_gate: quality, pixel_gate: pixelGate,
      };
    }
    return {
      unit_id: unit.unit_id,
      page_index: unit.page_index,
      panel_index: unit.panel_index,
      src: `data:image/jpeg;base64,${tileBytes.toString("base64")}`,
      sha256: sha256Bytes(tileBytes),
      size_bytes: tileBytes.length,
      width: tile.width,
      height: tile.height,
      media_role: unit.media_role,
      preferred_aspect: preferredAspect,
      fit_policy: unit.fit_policy,
      edge_trim: { left: 0, right: 0, top: 0, bottom: 0 },
      aspect_crop: { left: 0, top: 0, width: tile.width, height: tile.height },
      mother_sheet_slot: slotIndex + 1,
      mother_sheet_region_role: regionRole,
      presence_gate: quality,
      pixel_gate: pixelGate,
      ...(adaptiveKv ? { adaptive_boundary: adaptiveKv.boundary } : {}),
    };
  }));
}

export function buildMissingUnitRepairJobs(units, startIndex = 0) {
  if (!Array.isArray(units) || units.length < 1) return [];
  const jobs = [];
  const kvUnits = units.filter((unit) => unit?.page_index === 0 && unit?.panel_index == null && unit?.preferred_aspect === "9:8");
  const regularUnits = units.filter((unit) => !kvUnits.includes(unit));
  kvUnits.forEach((unit) => jobs.push({
    sheet_index: startIndex + jobs.length,
    sheet_id: `mother-sheet-repair-${startIndex + jobs.length + 1}`,
    template: "kv-top-3x2",
    kv_unit_index: 0,
    unit_labels: ["KV"],
    units: [structuredClone(unit)],
    repair: true,
  }));
  for (let index = 0; index < regularUnits.length; index += 3) {
    const batch = regularUnits.slice(index, index + 3);
    jobs.push({
      sheet_index: startIndex + jobs.length,
      sheet_id: `mother-sheet-repair-${startIndex + jobs.length + 1}`,
      template: "grid-3x3",
      kv_unit_index: null,
      unit_labels: batch.map((_unit, offset) => `补${offset + 1}`),
      units: structuredClone(batch),
      repair: true,
    });
  }
  return jobs;
}

export function buildStandaloneRepairPrompt(unit, { styleLock = null, imageContext = null } = {}) {
  if (!unit || typeof unit !== "object" || Array.isArray(unit) || !String(unit.unit_id || "").trim()) throw new TypeError("STANDALONE_REPAIR_UNIT_INVALID");
  const action = String(unit.visual_action || "").trim() || "小师妹完成与本页主题一致的清楚动作";
  const detail = String(unit.image_prompt || "").trim() || "东方生活场景，人物动作清楚，构图简洁";
  const preferredAspect = unit.preferred_aspect === "9:8" ? "9:8" : "3:4";
  const composition = preferredAspect === "9:8"
    ? "把完整主视觉放在整张3:4画布中央的9:8安全区内，上下只留纯白背景；人物、双手、脚和关键器物必须完整，后续会直接裁出中央9:8区域"
    : "让人物与关键器物完整占据3:4画布中央约58%–72%，头顶、发髻、双手、脚和动作器物都不得出框";
  return [
    "生成一张严格3:4竖幅的单张补图。这不是母图、不是拼图、不是网格，也没有其他待填区域；整张画布只表现下面这一个动作。",
    `${composition}。背景必须为视觉上接近#FFFFFF的连续纯白，不出现相框式白边、彩色底、阴影卡片、分隔线或空白占位格。`,
    "画面只出现同一位小师妹：黑色高发髻、红色长发带、米白盘扣上衣、红色灯笼裤、米白布鞋；不得出现标题、正文、数字、字母、标志、水印、UI或对话框。",
    `唯一动作合同｜${unit.unit_id}｜${action}｜${detail}`,
    styleLock ? `人物与线条风格锁：${JSON.stringify(styleLock)}` : "保持干净线条、东方生活质感和少量朱红暖色点缀。",
    imageContext ? `用户画面要求：${JSON.stringify(imageContext)}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function sliceStandaloneRepairForUnit(bytes, unit, options = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1024) throw new TypeError("STANDALONE_REPAIR_BYTES_INVALID");
  if (!unit || typeof unit !== "object" || Array.isArray(unit) || !String(unit.unit_id || "").trim()) throw new TypeError("STANDALONE_REPAIR_UNIT_INVALID");
  const maxBytes = Math.max(32_000, Number(options.maxBytes) || 160_000);
  const allowMissing = options.allowMissing === true;
  const metadata = await sharp(bytes).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height || Math.abs(width / height - .75) > .01) throw new Error(`STANDALONE_REPAIR_ASPECT_RATIO_INVALID:${width}x${height}`);
  const preferredAspect = unit.preferred_aspect === "9:8" ? "9:8" : "3:4";
  const crop = preferredAspect === "9:8"
    ? { left: 0, top: Math.max(0, Math.floor((height - Math.round(width / (9 / 8))) / 2)), width, height: Math.min(height, Math.round(width / (9 / 8))) }
    : { left: 0, top: 0, width, height };
  let baseTile = await sharp(bytes).flatten({ background: "#ffffff" }).extract(crop).png().toBuffer();
  const rawTile = await sharp(baseTile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cleaned = cleanupGeneratedGridArtifacts(
    { data: new Uint8Array(rawTile.data), width: rawTile.info.width, height: rawTile.info.height, channels: rawTile.info.channels },
    { enforceWhitePaper: preferredAspect === "3:4" },
  );
  baseTile = await sharp(Buffer.from(cleaned.data), { raw: { width: cleaned.width, height: cleaned.height, channels: cleaned.channels } }).png().toBuffer();
  const quality = inspectMotherSheetTileStats(await sharp(baseTile).stats());
  const missing = (reason, pixelGate = null) => ({
    unit_id: unit.unit_id, page_index: unit.page_index, panel_index: unit.panel_index, missing: true,
    mother_sheet_slot: 1, mother_sheet_region_role: `standalone-repair-${preferredAspect}`, presence_gate: quality,
    ...(pixelGate ? { pixel_gate: pixelGate } : {}), repair_failure_reason: reason,
  });
  if (!quality.hasVisibleSubject) {
    if (allowMissing) return missing("VISUAL_SUBJECT_MISSING");
    throw new Error(`STANDALONE_REPAIR_UNIT_MISSING:${unit.unit_id}`);
  }
  const tile = await encodeTileForPublicTransport(baseTile, preferredAspect, maxBytes);
  const finalRaw = await sharp(tile.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelGate = inspectMotherSheetTilePixels({ data: new Uint8Array(finalRaw.data), width: finalRaw.info.width, height: finalRaw.info.height, channels: finalRaw.info.channels }, { expectedAspect: preferredAspect });
  if (!pixelGate.hasCleanEdges) {
    if (allowMissing) return missing(`CONTAMINATED:${pixelGate.contaminatedSides.join("+") || "ASPECT"}`, pixelGate);
    throw new Error(`STANDALONE_REPAIR_TILE_CONTAMINATED:${unit.unit_id}:${pixelGate.contaminatedSides.join("+") || "ASPECT"}`);
  }
  return {
    unit_id: unit.unit_id, page_index: unit.page_index, panel_index: unit.panel_index,
    src: `data:image/jpeg;base64,${tile.bytes.toString("base64")}`,
    sha256: sha256Bytes(tile.bytes), size_bytes: tile.bytes.length, width: tile.width, height: tile.height,
    media_role: unit.media_role, preferred_aspect: preferredAspect, fit_policy: unit.fit_policy,
    edge_trim: { left: 0, right: 0, top: 0, bottom: 0 },
    aspect_crop: { left: crop.left, top: crop.top, width: crop.width, height: crop.height },
    mother_sheet_slot: 1, mother_sheet_region_role: `standalone-repair-${preferredAspect}`,
    presence_gate: quality, pixel_gate: pixelGate, repair_source: "standalone-image",
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256Json(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function exactObjectKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(code);
  return value;
}

function exactFiniteInteger(value, minimum, code) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(code);
  return value;
}

function importEd25519PublicKey(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("IMAGE_LEDGER_ATTESTATION_PUBLIC_KEY_REQUIRED");
  try {
    if (raw.startsWith("-----BEGIN PUBLIC KEY-----")) return createPublicKey(raw);
    const der = Buffer.from(raw, "base64");
    if (!der.length || der.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) throw new Error("bad-base64");
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("IMAGE_LEDGER_ATTESTATION_PUBLIC_KEY_INVALID");
  }
}

export function verifyImageLedgerAttestationEnvelope(envelope, { publicKey, expected = {}, nowMs = Date.now() } = {}) {
  exactObjectKeys(envelope, ["schema", "payload", "signature"], "IMAGE_LEDGER_ATTESTATION_ENVELOPE_INVALID");
  if (envelope.schema !== IMAGE_LEDGER_ATTESTATION_ENVELOPE_SCHEMA) throw new Error("IMAGE_LEDGER_ATTESTATION_ENVELOPE_INVALID");
  const payloadKeys = [
    "schema", "database_id_sha256", "rest_origin", "app_scope", "vercel_project_id", "vercel_environment",
    "candidate_commit", "database_state", "database_modifying", "tls", "eviction", "db_eviction", "auto_upgrade",
    "storage_threshold_bytes", "current_storage_bytes", "control_config_hash", "relevant_audit_set_hash",
    "audit_high_water", "audit_fetch_at_ms", "audit_retention_seconds", "calibration_sha256", "calibration_bytes",
    "worst_case_run_bytes", "headroom_bytes", "capacity_limit_bytes", "attestation_generation", "capacity_generation",
    "signed_at_ms", "renew_at_ms", "hard_expiry_ms",
  ];
  const payload = exactObjectKeys(envelope.payload, payloadKeys, "IMAGE_LEDGER_ATTESTATION_PAYLOAD_INVALID");
  if (payload.schema !== IMAGE_LEDGER_ATTESTATION_SCHEMA) throw new Error("IMAGE_LEDGER_ATTESTATION_PAYLOAD_INVALID");
  const signature = Buffer.from(String(envelope.signature || ""), "base64");
  if (signature.length !== 64 || !verifySignature(null, Buffer.from(canonicalJson(payload), "utf8"), importEd25519PublicKey(publicKey), signature)) {
    throw new Error("IMAGE_LEDGER_ATTESTATION_SIGNATURE_INVALID");
  }
  for (const [key, expectedValue] of Object.entries(expected || {})) {
    if (payload[key] !== expectedValue) throw new Error(`IMAGE_LEDGER_ATTESTATION_BINDING_MISMATCH:${key}`);
  }
  for (const field of ["database_id_sha256", "control_config_hash", "relevant_audit_set_hash", "calibration_sha256", "attestation_generation", "capacity_generation"]) {
    if (!/^[0-9a-f]{64}$/.test(String(payload[field] || ""))) throw new Error(`IMAGE_LEDGER_ATTESTATION_FIELD_INVALID:${field}`);
  }
  if (!/^https:\/\//.test(payload.rest_origin) || new URL(payload.rest_origin).origin !== payload.rest_origin) throw new Error("IMAGE_LEDGER_ATTESTATION_FIELD_INVALID:rest_origin");
  if (!/^[0-9a-f]{40}$/.test(payload.candidate_commit) || !payload.app_scope || !payload.vercel_project_id || !payload.vercel_environment) {
    throw new Error("IMAGE_LEDGER_ATTESTATION_BINDING_INVALID");
  }
  if (payload.database_state !== "active" || payload.database_modifying !== false || payload.tls !== true
    || payload.eviction !== false || payload.db_eviction !== false || payload.auto_upgrade !== false) {
    throw new Error("IMAGE_LEDGER_ATTESTATION_CONTROL_DRIFT");
  }
  const auditHighWater = exactObjectKeys(payload.audit_high_water, ["timestamp_ms", "log_id"], "IMAGE_LEDGER_ATTESTATION_AUDIT_INVALID");
  exactFiniteInteger(auditHighWater.timestamp_ms, 0, "IMAGE_LEDGER_ATTESTATION_AUDIT_INVALID");
  if (!String(auditHighWater.log_id || "")) throw new Error("IMAGE_LEDGER_ATTESTATION_AUDIT_INVALID");
  const auditFetchAtMs = exactFiniteInteger(payload.audit_fetch_at_ms, 0, "IMAGE_LEDGER_ATTESTATION_AUDIT_INVALID");
  if (payload.audit_retention_seconds !== IMAGE_LEDGER_AUDIT_RETENTION_SECONDS
    || auditHighWater.timestamp_ms > auditFetchAtMs
    || auditFetchAtMs > nowMs
    || nowMs - auditFetchAtMs > IMAGE_LEDGER_HARD_EXPIRY_MAX_MS) {
    throw new Error("IMAGE_LEDGER_ATTESTATION_AUDIT_INVALID");
  }
  const signedAtMs = exactFiniteInteger(payload.signed_at_ms, 0, "IMAGE_LEDGER_ATTESTATION_TIME_INVALID");
  const renewAtMs = exactFiniteInteger(payload.renew_at_ms, signedAtMs, "IMAGE_LEDGER_ATTESTATION_TIME_INVALID");
  const hardExpiryMs = exactFiniteInteger(payload.hard_expiry_ms, renewAtMs, "IMAGE_LEDGER_ATTESTATION_TIME_INVALID");
  if (signedAtMs > nowMs || hardExpiryMs <= nowMs
    || renewAtMs - signedAtMs > IMAGE_LEDGER_RENEW_MAX_MS
    || hardExpiryMs - signedAtMs > IMAGE_LEDGER_HARD_EXPIRY_MAX_MS) {
    throw new Error("IMAGE_LEDGER_ATTESTATION_TIME_INVALID");
  }
  const storageThreshold = exactFiniteInteger(payload.storage_threshold_bytes, 1, "IMAGE_LEDGER_ATTESTATION_CAPACITY_INVALID");
  const currentStorage = exactFiniteInteger(payload.current_storage_bytes, 0, "IMAGE_LEDGER_ATTESTATION_CAPACITY_INVALID");
  const calibrationBytes = exactFiniteInteger(payload.calibration_bytes, 1, "IMAGE_LEDGER_ATTESTATION_CAPACITY_INVALID");
  const worstCaseRunBytes = exactFiniteInteger(payload.worst_case_run_bytes, 1, "IMAGE_LEDGER_ATTESTATION_CAPACITY_INVALID");
  const headroomBytes = exactFiniteInteger(payload.headroom_bytes, 1, "IMAGE_LEDGER_ATTESTATION_CAPACITY_INVALID");
  const capacityLimitBytes = exactFiniteInteger(payload.capacity_limit_bytes, 1, "IMAGE_LEDGER_ATTESTATION_CAPACITY_INVALID");
  if (capacityLimitBytes > storageThreshold || currentStorage > capacityLimitBytes
    || calibrationBytes < worstCaseRunBytes
    || headroomBytes < Math.max(Math.ceil(storageThreshold * 0.2), worstCaseRunBytes * 2)
    || currentStorage + worstCaseRunBytes + headroomBytes > capacityLimitBytes) {
    throw new Error("IMAGE_LEDGER_ATTESTATION_CAPACITY_INVALID");
  }
  return structuredClone(payload);
}

const D37_PRODUCT_ROOT = "xiaoshimei:image-d37:{xiaoshimei-studio-v2}";

function d36ScopeTag(appScopeId) {
  const value = String(appScopeId || "");
  if (!/^xiaoshimei-studio:[0-9a-f]{32}$/.test(value) && value !== "xiaoshimei-test-scope") throw new TypeError("IMAGE_LEDGER_APP_SCOPE_REQUIRED");
  return sha256Bytes(Buffer.from(value, "utf8")).slice(0, 32);
}

function d36AppRoot(appScopeId) {
  return `${D37_PRODUCT_ROOT}:scope:${d36ScopeTag(appScopeId)}`;
}

function d36LegacyAppRoot(appScopeId) {
  return `xiaoshimei:image-d36:{${d36ScopeTag(appScopeId)}}`;
}

function d36ReadinessKey(appScopeId) {
  return `${d36AppRoot(appScopeId)}:readiness`;
}

function d36CapacityKey() {
  return `${D37_PRODUCT_ROOT}:capacity`;
}

function d36ExpiryIndexKey(appScopeId) {
  return `${d36AppRoot(appScopeId)}:expiry`;
}

function d36RunId(appScopeId, bootstrapNonce) {
  const digest = sha256Bytes(Buffer.from(`xiaoshimei-image-run-v1\0${appScopeId}\0${bootstrapNonce}`, "utf8"));
  return `images-${BigInt(`0x${digest}`).toString(10)}-${digest.slice(0, 8)}`;
}

function d36RunRoot(runId, appScopeId) {
  if (!/^images-[0-9TZ-]+-[0-9a-f]{8}$/.test(String(runId || ""))) throw new TypeError("IMAGE_LEDGER_RUN_ID_INVALID");
  if (!appScopeId) return `xiaoshimei:image-d36:{${runId}}`;
  return `${d36AppRoot(appScopeId)}:run:${runId}`;
}

function d36AssetKey(runId, sha256, appScopeId) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ""))) throw new TypeError("IMAGE_ASSET_SHA_INVALID");
  return `${d36RunRoot(runId, appScopeId)}:asset:${sha256}`;
}

function d36InventoryKey(runId, appScopeId) {
  return `${d36RunRoot(runId, appScopeId)}:inventory`;
}

function d36StepActionId(runId, checkpointSha256, logicalStepId) {
  return sha256Bytes(Buffer.from(`xiaoshimei-image-step-v1\0${runId}\0${checkpointSha256}\0${logicalStepId}`, "utf8"));
}

function d36CheckpointPreimage(compactRun, apiKey) {
  const base = {
    schema: "xiaoshimei.image-checkpoint.v1",
    run_id: compactRun.run_id,
    run_state_sha256: sha256Json(compactRun),
    status: compactRun.status,
    phase: compactRun.phase,
    next_job_index: compactRun.next_job_index,
    actual_image_calls: compactRun.actual_image_calls,
  };
  return {
    ...base,
    signature: createHmac("sha256", apiKey)
      .update("xiaoshimei-image-checkpoint-v1\0", "utf8")
      .update(canonicalJson(base), "utf8")
      .digest("hex"),
  };
}

export function createImageTransactionCheckpoint(compactRun, apiKey) {
  return d36CheckpointPreimage(compactRun, apiKey);
}

export function imageTransactionCheckpointSha256(checkpointPreimage) {
  return sha256Json(checkpointPreimage);
}

function verifyD36CheckpointPreimage(value, apiKey, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("IMAGE_CHECKPOINT_INVALID");
  const keys = Object.keys(value).sort();
  const exact = ["actual_image_calls", "next_job_index", "phase", "run_id", "run_state_sha256", "schema", "signature", "status"].sort();
  if (keys.length !== exact.length || keys.some((key, index) => key !== exact[index])) throw new TypeError("IMAGE_CHECKPOINT_INVALID");
  if (value.schema !== "xiaoshimei.image-checkpoint.v1"
    || !/^images-[0-9TZ-]+-[0-9a-f]{8}$/.test(value.run_id)
    || !/^[0-9a-f]{64}$/.test(value.run_state_sha256)
    || !/^[0-9a-f]{64}$/.test(value.signature)
    || !Number.isInteger(value.next_job_index) || value.next_job_index < 0
    || !Number.isInteger(value.actual_image_calls) || value.actual_image_calls < 0) throw new TypeError("IMAGE_CHECKPOINT_INVALID");
  const base = { ...value };
  delete base.signature;
  const signature = createHmac("sha256", apiKey)
    .update("xiaoshimei-image-checkpoint-v1\0", "utf8")
    .update(canonicalJson(base), "utf8")
    .digest("hex");
  if (!safeEqual(Buffer.from(signature, "hex"), Buffer.from(value.signature, "hex"))) throw new TypeError("IMAGE_CHECKPOINT_SIGNATURE_INVALID");
  if (expected.runId && value.run_id !== expected.runId) throw new TypeError("IMAGE_CHECKPOINT_RUN_MISMATCH");
  if (expected.checkpointSha256 && sha256Json(value) !== expected.checkpointSha256) throw new TypeError("IMAGE_CHECKPOINT_HASH_MISMATCH");
  return structuredClone(value);
}

function d36LogicalStepId(compactRun) {
  if (compactRun.status === "COMPLETE") return "complete";
  return `render-job-${String(compactRun.next_job_index + 1).padStart(2, "0")}`;
}

function d36RecoverableUntil(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : "";
}

function d36ManifestFromAsset(asset, runId) {
  const sha256 = String(asset.sha256 || "");
  return {
    schema: IMAGE_MEDIA_MANIFEST_SCHEMA,
    media_ref: `xiaoshimei-media://sha256/${sha256}`,
    sha256,
    size_bytes: Number(asset.size_bytes),
    mime: "image/jpeg",
    name: String(asset.name || asset.unit_id || `配图-${sha256.slice(0, 8)}`).slice(0, 100),
    width: Number(asset.width),
    height: Number(asset.height),
    asset_url: `/api/provider/assets/${runId}/${sha256}`,
  };
}

function stripAssetUrl(manifest) {
  const value = structuredClone(manifest);
  delete value.asset_url;
  return value;
}

function assertExactJpegAsset(bytes, manifest) {
  const value = Buffer.from(bytes);
  if (sha256Bytes(value) !== manifest.sha256) throw new TypeError("IMAGE_ASSET_HASH_MISMATCH");
  if (value.length !== manifest.size_bytes) throw new TypeError("IMAGE_ASSET_SIZE_MISMATCH");
  const info = inspectImageBytes(value);
  if (info.mime !== "image/jpeg" || manifest.mime !== "image/jpeg") throw new TypeError("IMAGE_ASSET_MIME_MISMATCH");
  if (Number(manifest.width) !== info.width || Number(manifest.height) !== info.height) throw new TypeError("IMAGE_ASSET_DIMENSIONS_MISMATCH");
  return value;
}

function compactPublicImageRun(run) {
  const compact = structuredClone(run);
  compact.assets = compact.assets.map((asset) => ({
    ...asset,
    src: `xiaoshimei-media://sha256/${asset.sha256}`,
  }));
  return compact;
}

async function hydrateCompactPublicImageRun(compactRun, imageLedger, appScopeId) {
  const hydrated = structuredClone(compactRun);
  hydrated.assets = [];
  for (const asset of compactRun.assets || []) {
    const stored = await imageLedger.readRunAsset({ runId: compactRun.run_id, appScopeId, sha256: asset.sha256 });
    if (!stored || stored.status === "MISSING") throw new Error("IMAGE_ASSET_MISSING");
    const bytes = Buffer.from(stored.bytes);
    if (bytes.length !== asset.size_bytes || sha256Bytes(bytes) !== asset.sha256) throw new Error("IMAGE_ASSET_CORRUPT");
    hydrated.assets.push({ ...asset, src: `data:image/jpeg;base64,${bytes.toString("base64")}` });
  }
  return parsePublicImageRun(hydrated);
}

function replaceInlineMediaWithRefs(value, manifests) {
  const bySha = new Map(manifests.map((item) => [item.sha256, item.media_ref]));
  const visit = (current) => {
    if (typeof current === "string" && /^data:image\/jpeg;base64,/.test(current)) {
      const comma = current.indexOf(",");
      const sha256 = sha256Bytes(Buffer.from(current.slice(comma + 1), "base64"));
      const mediaRef = bySha.get(sha256);
      if (!mediaRef) throw new Error("IMAGE_CONTENT_MEDIA_REF_MISSING");
      return mediaRef;
    }
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, visit(child)]));
  };
  return visit(value);
}

const IMAGE_LEDGER_INIT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('HGET', KEYS[1], 'checkpoint_sha') == ARGV[1]
    and redis.call('HGET', KEYS[1], 'nonce') == ARGV[2]
    and redis.call('HGET', KEYS[1], 'attempt_index') == ARGV[3]
    and redis.call('HGET', KEYS[1], 'job_index') == ARGV[4] then
    return {'EXISTING'}
  end
  return {'CONFLICT'}
end
redis.call('HSET', KEYS[1],
  'status', 'READY',
  'checkpoint_sha', ARGV[1],
  'nonce', ARGV[2],
  'attempt_index', ARGV[3],
  'job_index', ARGV[4],
  'reservation_count', ARGV[3],
  'max_calls', ARGV[5],
  'expires_at_ms', ARGV[6])
redis.call('PEXPIREAT', KEYS[1], ARGV[6])
return {'INITIALIZED'}
`;

const IMAGE_LEDGER_RESERVE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'RUN_MISSING'} end
if redis.call('EXISTS', KEYS[2]) == 1 then
  if redis.call('HGET', KEYS[2], 'nonce') ~= ARGV[2]
    or redis.call('HGET', KEYS[2], 'checkpoint_sha') ~= ARGV[1] then
    return {'NONCE_CONFLICT'}
  end
  local attempt_status = redis.call('HGET', KEYS[2], 'status')
  if attempt_status == 'COMMITTED' then return {'CACHED'} end
  if attempt_status == 'UNKNOWN' then return {'UNKNOWN'} end
  if attempt_status == 'IN_FLIGHT' then
    local reserved_at = tonumber(redis.call('HGET', KEYS[2], 'reserved_at_ms') or '0')
    if tonumber(ARGV[5]) - reserved_at > tonumber(ARGV[6]) then
      redis.call('HSET', KEYS[2], 'status', 'UNKNOWN')
      redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
      return {'UNKNOWN'}
    end
    return {'IN_FLIGHT'}
  end
end
local run_status = redis.call('HGET', KEYS[1], 'status')
if redis.call('HGET', KEYS[1], 'checkpoint_sha') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'nonce') ~= ARGV[2]
  or redis.call('HGET', KEYS[1], 'attempt_index') ~= ARGV[3]
  or redis.call('HGET', KEYS[1], 'job_index') ~= ARGV[4] then
  return {'CHECKPOINT_CONFLICT'}
end
if run_status == 'UNKNOWN' then return {'UNKNOWN'} end
if run_status == 'COMPLETE' then return {'COMPLETE'} end
if run_status == 'EXHAUSTED' then return {'BUDGET_EXHAUSTED'} end
if run_status ~= 'READY' then return {'IN_FLIGHT'} end
local count = tonumber(redis.call('HGET', KEYS[1], 'reservation_count') or '0')
local max_calls = tonumber(redis.call('HGET', KEYS[1], 'max_calls') or ARGV[7])
if count >= max_calls then
  redis.call('HSET', KEYS[1], 'status', 'EXHAUSTED')
  return {'BUDGET_EXHAUSTED'}
end
redis.call('HSET', KEYS[2],
  'status', 'IN_FLIGHT',
  'nonce', ARGV[2],
  'checkpoint_sha', ARGV[1],
  'reserved_at_ms', ARGV[5])
redis.call('PEXPIREAT', KEYS[2], ARGV[8])
redis.call('HSET', KEYS[1], 'status', 'IN_FLIGHT', 'reservation_count', count + 1)
redis.call('PEXPIREAT', KEYS[1], ARGV[8])
return {'RESERVED', tostring(count + 1)}
`;

const IMAGE_LEDGER_COMMIT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then return {'RUN_MISSING'} end
if redis.call('HGET', KEYS[2], 'nonce') ~= ARGV[2]
  or redis.call('HGET', KEYS[2], 'checkpoint_sha') ~= ARGV[1] then
  return {'NONCE_CONFLICT'}
end
local attempt_status = redis.call('HGET', KEYS[2], 'status')
if attempt_status == 'COMMITTED' then
  if redis.call('HGET', KEYS[2], 'result_sha') == ARGV[3] then return {'COMMITTED'} end
  return {'COMMIT_CONFLICT'}
end
if attempt_status ~= 'IN_FLIGHT' or redis.call('HGET', KEYS[1], 'status') ~= 'IN_FLIGHT' then
  return {attempt_status or 'UNKNOWN'}
end
redis.call('HSET', KEYS[2],
  'status', 'COMMITTED',
  'result_sha', ARGV[3],
  'http_status', ARGV[4],
  'cache_body', ARGV[5])
redis.call('PEXPIREAT', KEYS[2], ARGV[11])
redis.call('HSET', KEYS[1],
  'status', ARGV[10],
  'checkpoint_sha', ARGV[6],
  'nonce', ARGV[7],
  'attempt_index', ARGV[8],
  'job_index', ARGV[9],
  'expires_at_ms', ARGV[11])
redis.call('PEXPIREAT', KEYS[1], ARGV[11])
return {'COMMITTED'}
`;

const IMAGE_LEDGER_UNKNOWN_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then return {'RUN_MISSING'} end
if redis.call('HGET', KEYS[2], 'nonce') ~= ARGV[2]
  or redis.call('HGET', KEYS[2], 'checkpoint_sha') ~= ARGV[1] then
  return {'NONCE_CONFLICT'}
end
local attempt_status = redis.call('HGET', KEYS[2], 'status')
if attempt_status == 'COMMITTED' then return {'COMMITTED'} end
redis.call('HSET', KEYS[2], 'status', 'UNKNOWN')
redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
return {'UNKNOWN'}
`;

const D36_CLAIM_START_LUA = `
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if tonumber(ARGV[8]) - now_ms < tonumber(ARGV[9]) then return {'EXPIRY_WINDOW_TOO_SHORT'} end
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('HGET', KEYS[1], 'app_scope') ~= ARGV[1]
    or redis.call('HGET', KEYS[1], 'bootstrap_nonce') ~= ARGV[2]
    or redis.call('HGET', KEYS[1], 'input_sha') ~= ARGV[3]
    or redis.call('HGET', KEYS[1], 'snapshot_sha') ~= ARGV[4]
    or redis.call('HGET', KEYS[1], 'manifest_sha') ~= ARGV[5]
    or (#KEYS >= 4 and (redis.call('HGET', KEYS[1], 'capacity_generation') ~= ARGV[12]
      or redis.call('HGET', KEYS[1], 'capacity_reservation_bytes') ~= ARGV[13])) then
    return {'CONFLICT'}
  end
  if redis.call('EXISTS', KEYS[2]) == 0
    or redis.call('HGET', KEYS[1], 'inventory_schema') ~= 'xiaoshimei.d36-key-inventory.v1'
    or redis.call('SISMEMBER', KEYS[2], KEYS[1]) ~= 1
    or redis.call('SISMEMBER', KEYS[2], KEYS[2]) ~= 1 then return {'INVENTORY_INCOMPLETE'} end
  local status = redis.call('HGET', KEYS[1], 'status') or 'UNKNOWN'
  if status == 'PLANNING' then
    local lease_until = tonumber(redis.call('HGET', KEYS[1], 'planner_lease_until_ms') or '0')
    if now_ms > lease_until then
      redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
      status = 'UNKNOWN'
    end
  end
  return {status, redis.call('HGET', KEYS[1], 'planner_owner') or '', redis.call('HGET', KEYS[1], 'planner_fence') or '0', redis.call('HGET', KEYS[1], 'recoverable_until_ms') or '0'}
end
local runtime_attested = #KEYS >= 4
local reservation = 0
if runtime_attested then
  if redis.call('HGET', KEYS[3], 'schema') ~= 'xiaoshimei.image-ledger-capacity.v2'
    or redis.call('HGET', KEYS[3], 'capacity_generation') ~= ARGV[12] then return {'CAPACITY_GENERATION_DRIFT'} end
  local reserved = tonumber(redis.call('HGET', KEYS[3], 'reserved_bytes') or '-1')
  local capacity_limit = tonumber(redis.call('HGET', KEYS[3], 'capacity_limit_bytes') or '-1')
  local headroom = tonumber(redis.call('HGET', KEYS[3], 'headroom_bytes') or '-1')
  reservation = tonumber(ARGV[13])
  if reserved < 0 or capacity_limit <= 0 or headroom <= 0 or reservation <= 0
    or reserved + reservation + headroom > capacity_limit then return {'CAPACITY_EXHAUSTED'} end
end
local recoverable_until = now_ms + tonumber(ARGV[10])
local physical_ttl = runtime_attested and tonumber(ARGV[14]) or tonumber(ARGV[10])
local physical_expire_at = now_ms + physical_ttl
redis.call('SADD', KEYS[2], KEYS[1], KEYS[2])
redis.call('HSET', KEYS[1],
  'status', 'MATERIALIZING',
  'app_scope', ARGV[1],
  'bootstrap_nonce', ARGV[2],
  'input_sha', ARGV[3],
  'snapshot_sha', ARGV[4],
  'manifest_sha', ARGV[5],
  'snapshot_json', ARGV[6],
  'manifest_json', ARGV[7],
  'reservation_count', '0',
  'inventory_schema', 'xiaoshimei.d36-key-inventory.v1',
  'inventory_count', '2',
  'recoverable_until_ms', tostring(recoverable_until),
  'physical_expire_at_ms', tostring(physical_expire_at))
if runtime_attested then
  redis.call('HSET', KEYS[1], 'capacity_generation', ARGV[12], 'capacity_reservation_bytes', ARGV[13], 'capacity_released', '0')
  redis.call('HINCRBY', KEYS[3], 'reserved_bytes', reservation)
  redis.call('HINCRBY', KEYS[3], 'live_reservations', 1)
  redis.call('HINCRBY', KEYS[3], 'unfinalized_inventory', 1)
  redis.call('ZADD', KEYS[4], recoverable_until, KEYS[1] .. '|' .. ARGV[12] .. '|' .. ARGV[13])
end
redis.call('PEXPIRE', KEYS[1], physical_ttl)
redis.call('PEXPIRE', KEYS[2], physical_ttl)
return {'MATERIALIZING', '', '0', tostring(recoverable_until)}
`;

const D36_DISCOVER_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'NOT_FOUND'} end
if redis.call('HGET', KEYS[1], 'app_scope') ~= ARGV[1] then return {'CONFLICT'} end
if ARGV[4] == '1' and (redis.call('HGET', KEYS[1], 'bootstrap_nonce') ~= ARGV[2]
  or redis.call('HGET', KEYS[1], 'input_sha') ~= ARGV[3]) then return {'CONFLICT'} end
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local status = redis.call('HGET', KEYS[1], 'status') or 'UNKNOWN'
if status == 'PLANNING' then
  local lease_until = tonumber(redis.call('HGET', KEYS[1], 'planner_lease_until_ms') or '0')
  if now_ms > lease_until then
    redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
    status = 'UNKNOWN'
  end
end
if status == 'UNKNOWN'
  and redis.call('HEXISTS', KEYS[1], 'run_json') == 0
  and redis.call('HEXISTS', KEYS[1], 'checkpoint_sha') == 0
  and tonumber(redis.call('HGET', KEYS[1], 'reservation_count') or '0') == 0 then
  redis.call('HSET', KEYS[1],
    'status', 'PLANNER_FAILED',
    'planner_failure_code', 'IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS')
  status = 'PLANNER_FAILED'
end
local record = redis.call('HGETALL', KEYS[1])
local reply = {'FOUND'}
for index = 1, #record do reply[#reply + 1] = record[index] end
return reply
`;

const D36_PUT_ASSET_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'RUN_MISSING'} end
if redis.call('EXISTS', KEYS[2]) == 0
  or redis.call('HGET', KEYS[1], 'inventory_schema') ~= 'xiaoshimei.d36-key-inventory.v1'
  or redis.call('SISMEMBER', KEYS[2], KEYS[1]) ~= 1
  or redis.call('SISMEMBER', KEYS[2], KEYS[2]) ~= 1 then return {'INVENTORY_INCOMPLETE'} end
local status = redis.call('HGET', KEYS[1], 'status') or 'UNKNOWN'
if status == 'CLEANUP_FROZEN' or status == 'UNKNOWN' or status == 'COMPLETE' then return {'RUN_FROZEN'} end
if redis.call('EXISTS', KEYS[3]) == 1 then
  if redis.call('SISMEMBER', KEYS[2], KEYS[3]) ~= 1 then return {'INVENTORY_INCOMPLETE'} end
  if redis.call('GET', KEYS[3]) ~= ARGV[1] then return {'CAS_CONFLICT'} end
  return {'EXISTING'}
end
local recoverable_until = tonumber(redis.call('HGET', KEYS[1], 'recoverable_until_ms') or '0')
local physical_expire_at = tonumber(redis.call('HGET', KEYS[1], 'physical_expire_at_ms') or '0')
if recoverable_until <= 0 or physical_expire_at <= recoverable_until then return {'RECOVERY_DEADLINE_MISSING'} end
redis.call('SET', KEYS[3], ARGV[1])
local added = redis.call('SADD', KEYS[2], KEYS[3])
if added == 1 then redis.call('HINCRBY', KEYS[1], 'inventory_count', 1) end
redis.call('PEXPIREAT', KEYS[3], physical_expire_at)
redis.call('PEXPIREAT', KEYS[2], physical_expire_at)
return {'STORED'}
`;

const D36_CLAIM_PLANNER_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'RUN_MISSING'} end
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if tonumber(ARGV[4]) - now_ms < tonumber(ARGV[5]) then return {'EXPIRY_WINDOW_TOO_SHORT'} end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'PLANNING' then
  local lease_until = tonumber(redis.call('HGET', KEYS[1], 'planner_lease_until_ms') or '0')
  if now_ms > lease_until then
    redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
    return {'UNKNOWN'}
  end
  return {'IN_FLIGHT'}
end
if status == 'READY' or status == 'PARTIAL' or status == 'COMPLETE' then return {status} end
if status == 'UNKNOWN' then return {'UNKNOWN'} end
if status ~= 'MATERIALIZING' then return {'CONFLICT'} end
local fence = tonumber(redis.call('HGET', KEYS[1], 'planner_fence') or '0') + 1
redis.call('HSET', KEYS[1],
  'status', 'PLANNING',
  'planner_owner', ARGV[1],
  'planner_fence', tostring(fence),
  'planner_lease_until_ms', tostring(now_ms + tonumber(ARGV[2])),
  'materialized_manifest_sha', ARGV[3])
return {'PLANNING', ARGV[1], tostring(fence)}
`;

const D36_COMMIT_PLANNER_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'RUN_MISSING'} end
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if redis.call('HGET', KEYS[1], 'status') ~= 'PLANNING'
  or redis.call('HGET', KEYS[1], 'planner_owner') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'planner_fence') ~= ARGV[2] then return {'CONFLICT'} end
if now_ms > tonumber(redis.call('HGET', KEYS[1], 'planner_lease_until_ms') or '0') then
  redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
  return {'UNKNOWN'}
end
redis.call('HSET', KEYS[1],
  'status', 'READY',
  'run_json', ARGV[3],
  'run_state_sha', ARGV[4],
  'checkpoint_json', ARGV[5],
  'checkpoint_sha', ARGV[6],
  'logical_step_id', ARGV[7],
  'cached_response_json', ARGV[8])
return {'COMMITTED'}
`;

const D36_MARK_PLANNER_FAILED_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'RUN_MISSING'} end
if redis.call('HGET', KEYS[1], 'status') == 'READY' then return {'COMMITTED'} end
if redis.call('HGET', KEYS[1], 'status') == 'PLANNER_FAILED' then return {'COMMITTED'} end
if redis.call('HGET', KEYS[1], 'status') ~= 'PLANNING'
  or redis.call('HGET', KEYS[1], 'planner_owner') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'planner_fence') ~= ARGV[2] then return {'CONFLICT'} end
if redis.call('HEXISTS', KEYS[1], 'run_json') == 1
  or redis.call('HEXISTS', KEYS[1], 'checkpoint_sha') == 1
  or tonumber(redis.call('HGET', KEYS[1], 'reservation_count') or '0') ~= 0 then return {'CONFLICT'} end
redis.call('HSET', KEYS[1],
  'status', 'PLANNER_FAILED',
  'planner_failure_code', ARGV[3],
  'cached_response_json', ARGV[4])
return {'COMMITTED'}
`;

const D36_MARK_PLANNER_UNKNOWN_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'RUN_MISSING'} end
if redis.call('HGET', KEYS[1], 'status') == 'READY' then return {'COMMITTED'} end
if redis.call('HGET', KEYS[1], 'status') ~= 'PLANNING'
  or redis.call('HGET', KEYS[1], 'planner_owner') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'planner_fence') ~= ARGV[2] then return {'CONFLICT'} end
redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
return {'UNKNOWN'}
`;

const D36_RESERVE_STEP_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'RUN_MISSING'} end
if redis.call('EXISTS', KEYS[2]) == 0
  or redis.call('HGET', KEYS[1], 'inventory_schema') ~= 'xiaoshimei.d36-key-inventory.v1'
  or redis.call('SISMEMBER', KEYS[2], KEYS[1]) ~= 1
  or redis.call('SISMEMBER', KEYS[2], KEYS[2]) ~= 1 then return {'INVENTORY_INCOMPLETE'} end
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if redis.call('EXISTS', KEYS[3]) == 1 then
  if redis.call('SISMEMBER', KEYS[2], KEYS[3]) ~= 1 then return {'INVENTORY_INCOMPLETE'} end
  if redis.call('HGET', KEYS[3], 'checkpoint_sha') ~= ARGV[1]
    or redis.call('HGET', KEYS[3], 'logical_step_id') ~= ARGV[2] then return {'ACTION_ID_CONFLICT'} end
  if redis.call('HGET', KEYS[3], 'attempt_nonce') ~= ARGV[3] then return {'NONCE_CONFLICT'} end
  local action_status = redis.call('HGET', KEYS[3], 'status')
  if action_status == 'COMMITTED' or action_status == 'LATE_RESULT' then return {'CACHED', action_status} end
  if action_status == 'UNKNOWN' then return {'UNKNOWN'} end
  local lease_until = tonumber(redis.call('HGET', KEYS[3], 'lease_until_ms') or '0')
  if now_ms > lease_until then
    redis.call('HSET', KEYS[3], 'status', 'UNKNOWN')
    redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
    return {'UNKNOWN'}
  end
  return {'IN_FLIGHT'}
end
local required_remaining = tonumber(ARGV[5]) + tonumber(ARGV[6])
if tonumber(ARGV[8]) - now_ms < required_remaining then return {'EXPIRY_WINDOW_TOO_SHORT'} end
local recoverable_until = tonumber(redis.call('HGET', KEYS[1], 'recoverable_until_ms') or '0')
local physical_expire_at = tonumber(redis.call('HGET', KEYS[1], 'physical_expire_at_ms') or '0')
if recoverable_until - now_ms < required_remaining
  or physical_expire_at <= recoverable_until
  or redis.call('PTTL', KEYS[1]) < required_remaining
  or redis.call('PTTL', KEYS[2]) < required_remaining then return {'RUN_EXPIRY_WINDOW_TOO_SHORT'} end
local run_status = redis.call('HGET', KEYS[1], 'status')
if run_status == 'UNKNOWN' or run_status == 'CLEANUP_FROZEN' then return {'UNKNOWN'} end
if run_status == 'COMPLETE' then return {'COMPLETE'} end
if redis.call('HGET', KEYS[1], 'checkpoint_sha') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'logical_step_id') ~= ARGV[2] then return {'CHECKPOINT_CONFLICT'} end
local count = tonumber(redis.call('HGET', KEYS[1], 'reservation_count') or '0')
if count >= tonumber(ARGV[10]) then return {'BUDGET_EXHAUSTED'} end
local fence = count + 1
redis.call('HSET', KEYS[3],
  'status', 'IN_FLIGHT',
  'checkpoint_sha', ARGV[1],
  'logical_step_id', ARGV[2],
  'attempt_nonce', ARGV[3],
  'owner_token', ARGV[4],
  'fence', tostring(fence),
  'lease_until_ms', tostring(now_ms + tonumber(ARGV[5])))
local added = redis.call('SADD', KEYS[2], KEYS[3])
if added == 1 then redis.call('HINCRBY', KEYS[1], 'inventory_count', 1) end
redis.call('PEXPIREAT', KEYS[3], physical_expire_at)
redis.call('PEXPIREAT', KEYS[2], physical_expire_at)
redis.call('HSET', KEYS[1], 'status', 'IN_FLIGHT', 'reservation_count', tostring(fence))
return {'RESERVED', ARGV[4], tostring(fence)}
`;

const D36_COMMIT_STEP_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then return {'RUN_MISSING'} end
if redis.call('HGET', KEYS[2], 'status') == 'COMMITTED' then
  if redis.call('HGET', KEYS[2], 'result_sha') == ARGV[6] then return {'COMMITTED'} end
  return {'COMMIT_CONFLICT'}
end
if redis.call('HGET', KEYS[2], 'status') ~= 'IN_FLIGHT'
  or redis.call('HGET', KEYS[2], 'checkpoint_sha') ~= ARGV[1]
  or redis.call('HGET', KEYS[2], 'logical_step_id') ~= ARGV[2]
  or redis.call('HGET', KEYS[2], 'attempt_nonce') ~= ARGV[3]
  or redis.call('HGET', KEYS[2], 'owner_token') ~= ARGV[4]
  or redis.call('HGET', KEYS[2], 'fence') ~= ARGV[5] then return {'CONFLICT'} end
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if now_ms > tonumber(redis.call('HGET', KEYS[2], 'lease_until_ms') or '0') then
  redis.call('HSET', KEYS[2],
    'status', 'LATE_RESULT',
    'result_sha', ARGV[6],
    'result_json', ARGV[7],
    'recovery_only', '1')
  redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
  return {'LATE_RESULT'}
end
redis.call('HSET', KEYS[2], 'status', 'COMMITTED', 'result_sha', ARGV[6], 'result_json', ARGV[7])
redis.call('HSET', KEYS[1],
  'status', ARGV[8],
  'run_json', ARGV[9],
  'run_state_sha', ARGV[10],
  'checkpoint_json', ARGV[11],
  'checkpoint_sha', ARGV[12],
  'logical_step_id', ARGV[13],
  'cached_response_json', ARGV[7])
return {'COMMITTED'}
`;

const D36_MARK_STEP_UNKNOWN_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then return {'RUN_MISSING'} end
if redis.call('HGET', KEYS[2], 'status') == 'COMMITTED' then return {'COMMITTED'} end
if redis.call('HGET', KEYS[2], 'status') == 'LATE_RESULT' then return {'LATE_RESULT'} end
if redis.call('HGET', KEYS[2], 'attempt_nonce') ~= ARGV[1]
  or redis.call('HGET', KEYS[2], 'owner_token') ~= ARGV[2]
  or redis.call('HGET', KEYS[2], 'fence') ~= ARGV[3] then return {'CONFLICT'} end
redis.call('HSET', KEYS[2], 'status', 'UNKNOWN')
redis.call('HSET', KEYS[1], 'status', 'UNKNOWN')
return {'UNKNOWN'}
`;

const D36_FREEZE_CLEANUP_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'RUN_MISSING'} end
if redis.call('EXISTS', KEYS[2]) == 0 then return {'INVENTORY_MISSING'} end
if redis.call('HGET', KEYS[1], 'inventory_schema') ~= 'xiaoshimei.d36-key-inventory.v1'
  or redis.call('SISMEMBER', KEYS[2], KEYS[1]) ~= 1
  or redis.call('SISMEMBER', KEYS[2], KEYS[2]) ~= 1 then return {'INVENTORY_INCOMPLETE'} end
local status = redis.call('HGET', KEYS[1], 'status') or 'UNKNOWN'
if status ~= 'COMPLETE' and status ~= 'UNKNOWN' and status ~= 'CLEANUP_FROZEN' then return {'NON_TERMINAL'} end
if status == 'CLEANUP_FROZEN' then
  local prior = redis.call('HGET', KEYS[1], 'cleanup_from_status') or ''
  if prior ~= 'COMPLETE' and prior ~= 'UNKNOWN' then return {'INVENTORY_INCOMPLETE'} end
else
  redis.call('HSET', KEYS[1], 'cleanup_from_status', status, 'status', 'CLEANUP_FROZEN')
end
local members = redis.call('SMEMBERS', KEYS[2])
if #members ~= tonumber(redis.call('HGET', KEYS[1], 'inventory_count') or '-1') then return {'INVENTORY_INCOMPLETE'} end
for index = 1, #members do
  if redis.call('EXISTS', members[index]) ~= 1 then return {'INVENTORY_INCOMPLETE'} end
end
local reply = {'FROZEN'}
for index = 1, #members do reply[#reply + 1] = members[index] end
return reply
`;

const D36_RELEASE_CAPACITY_LUA = `
if redis.call('HGET', KEYS[1], 'schema') ~= 'xiaoshimei.image-ledger-capacity.v2'
  or redis.call('HGET', KEYS[1], 'capacity_generation') ~= ARGV[2] then return {'CAPACITY_GENERATION_DRIFT'} end
if redis.call('ZSCORE', KEYS[2], ARGV[1]) == false then return {'ALREADY_RELEASED'} end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved_bytes') or '-1')
local live = tonumber(redis.call('HGET', KEYS[1], 'live_reservations') or '-1')
local inventory = tonumber(redis.call('HGET', KEYS[1], 'unfinalized_inventory') or '-1')
local amount = tonumber(ARGV[3])
if reserved < amount or live < 1 or inventory < 1 or amount <= 0 then return {'CAPACITY_ACCOUNTING_INVALID'} end
redis.call('HINCRBY', KEYS[1], 'reserved_bytes', -amount)
redis.call('HINCRBY', KEYS[1], 'live_reservations', -1)
redis.call('HINCRBY', KEYS[1], 'unfinalized_inventory', -1)
redis.call('ZREM', KEYS[2], ARGV[1])
return {'RELEASED'}
`;

function imageLedgerKeys(runId, attemptIndex = null) {
  const normalized = String(runId || "");
  if (!/^images-[0-9TZ-]+-[0-9a-f]{8}$/.test(normalized)) throw new TypeError("IMAGE_LEDGER_RUN_ID_INVALID");
  const root = `xiaoshimei:image-run:{${normalized}}`;
  return { run: `${root}:meta`, attempt: attemptIndex == null ? null : `${root}:attempt:${Number(attemptIndex)}` };
}

function ledgerReplyStatus(value) {
  const result = Array.isArray(value) ? value : [value];
  return {
    status: String(result[0] || "IMAGE_LEDGER_INVALID_REPLY"),
    value: result[1] == null ? null : result[1],
    values: result.slice(1),
  };
}

function redisHashObject(value) {
  if (!Array.isArray(value) || value.length % 2 !== 0) throw new Error("IMAGE_LEDGER_INVALID_REPLY");
  const result = {};
  for (let index = 0; index < value.length; index += 2) result[String(value[index])] = value[index + 1];
  return result;
}

function assertProductionReadiness(value) {
  const ready = value && typeof value === "object"
    && value.dedicated === true
    && (value.eviction === false || value.eviction === "off" || value.eviction === "noeviction")
    && value.autoUpgrade === false
    && value.foreignKeyCount === 0
    && value.usageReadable === true
    && value.calibrated === true
    && value.capacityAvailable === true
    && /^[0-9a-f]{64}$/.test(String(value.calibrationSha256 || ""));
  if (!ready) throw new Error("IMAGE_LEDGER_READINESS_UNKNOWN");
  return structuredClone(value);
}

export function createUpstashImageLedger({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 5_000, productionReadiness = null, readinessProbe = null, runtimeBinding = null } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new TypeError("IMAGE_LEDGER_CONFIGURATION_REQUIRED"); }
  if (endpoint.protocol !== "https:" || typeof token !== "string" || token.length < 16 || typeof fetchImpl !== "function") throw new TypeError("IMAGE_LEDGER_CONFIGURATION_REQUIRED");
  const evalLua = async (script, keys, args) => {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(["EVAL", script, String(keys.length), ...keys, ...args.map((value) => String(value))]),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("IMAGE_LEDGER_UNAVAILABLE");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error || payload?.result == null) throw new Error("IMAGE_LEDGER_UNAVAILABLE");
    return ledgerReplyStatus(payload.result);
  };
  const command = async (args) => {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(args.map((value) => Buffer.isBuffer(value) ? value.toString("base64") : String(value))),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("IMAGE_LEDGER_UNAVAILABLE");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error || !payload || !Object.prototype.hasOwnProperty.call(payload, "result")) throw new Error("IMAGE_LEDGER_UNAVAILABLE");
    return payload.result;
  };
  const getCached = async (attemptKey) => {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(["HGET", attemptKey, "cache_body"]),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("IMAGE_LEDGER_UNAVAILABLE");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error || typeof payload?.result !== "string") throw new Error("IMAGE_LEDGER_CACHE_UNAVAILABLE");
    return payload.result;
  };
  const parseD36Discovery = (reply, runId) => {
    if (reply.status !== "FOUND") return { status: reply.status, runId };
    const record = redisHashObject(reply.values);
    return {
      status: String(record.status || "UNKNOWN"),
      runId,
      bootstrapNonce: record.bootstrap_nonce,
      inputSha256: record.input_sha,
      recoverableUntil: Number(record.recoverable_until_ms || 0),
      snapshot: record.snapshot_json ? JSON.parse(record.snapshot_json) : null,
      referenceManifest: record.manifest_json ? JSON.parse(record.manifest_json) : [],
      compactRun: record.run_json ? JSON.parse(record.run_json) : null,
      checkpointPreimage: record.checkpoint_json ? JSON.parse(record.checkpoint_json) : null,
      checkpointPreimageSha256: record.checkpoint_sha || null,
      logicalStepId: record.logical_step_id || null,
      cachedResponse: record.cached_response_json ? JSON.parse(record.cached_response_json) : null,
      plannerFailureCode: record.planner_failure_code || null,
    };
  };
  const discoverD36 = async ({ runId, appScopeId, bootstrapNonce = "", inputSha256 = "", requireExternalIdentity = false } = {}) => {
    const reply = await evalLua(
      D36_DISCOVER_LUA,
      [`${d36RunRoot(runId, appScopeId)}:meta`],
      [appScopeId, bootstrapNonce, inputSha256, requireExternalIdentity ? "1" : "0"],
    );
    return parseD36Discovery(reply, runId);
  };
  const scanPatternKeys = async (pattern) => {
    const result = [];
    let cursor = "0";
    do {
      const reply = await command(["SCAN", cursor, "MATCH", pattern, "COUNT", "1000"]);
      if (!Array.isArray(reply) || reply.length !== 2 || !Array.isArray(reply[1])) throw new Error("IMAGE_LEDGER_SCAN_INVALID_REPLY");
      cursor = String(reply[0]);
      for (const key of reply[1]) result.push(String(key));
    } while (cursor !== "0");
    return [...new Set(result)].sort();
  };
  const scanD36RootKeys = (root) => scanPatternKeys(`${root}:*`);
  const redisTimeMs = async () => {
    const value = await command(["TIME"]);
    if (!Array.isArray(value) || value.length !== 2 || !/^\d+$/.test(String(value[0])) || !/^\d+$/.test(String(value[1]))) {
      throw new Error("IMAGE_LEDGER_TIME_INVALID");
    }
    return Number(value[0]) * 1000 + Math.floor(Number(value[1]) / 1000);
  };
  const verifyRuntimeSentinel = async (context) => {
    if (!runtimeBinding?.ready) throw new Error("IMAGE_LEDGER_READINESS_UNKNOWN");
    const appScopeId = String(context?.appScopeId || "");
    if (appScopeId !== runtimeBinding.expected?.app_scope) throw new Error("IMAGE_LEDGER_ATTESTATION_BINDING_MISMATCH:app_scope");
    const nowMs = await redisTimeMs();
    const raw = await command(["GET", d36ReadinessKey(appScopeId)]);
    if (typeof raw !== "string") throw new Error("IMAGE_LEDGER_ATTESTATION_MISSING");
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw new Error("IMAGE_LEDGER_ATTESTATION_ENVELOPE_INVALID"); }
    return verifyImageLedgerAttestationEnvelope(envelope, {
      publicKey: runtimeBinding.publicKey,
      expected: runtimeBinding.expected,
      nowMs,
    });
  };
  const finalizeExpiredRunsWithAttestation = async (appScopeId, attestation, { limit = 8 } = {}) => {
    const nowMs = await redisTimeMs();
    const expiryKey = d36ExpiryIndexKey(appScopeId);
    const members = await command(["ZRANGEBYSCORE", expiryKey, "-inf", String(nowMs), "LIMIT", "0", String(limit)]);
    if (!Array.isArray(members)) throw new Error("IMAGE_LEDGER_EXPIRY_INDEX_INVALID");
    const results = [];
    for (const rawMember of members) {
      const member = String(rawMember);
      const match = /^(.*:meta)\|([0-9a-f]{64})\|(\d+)$/.exec(member);
      if (!match || !match[1].startsWith(`${d36AppRoot(appScopeId)}:run:`)) throw new Error("IMAGE_LEDGER_EXPIRY_INDEX_INVALID");
      const [, metaKey, capacityGeneration, reservationRaw] = match;
      const reservationBytes = Number(reservationRaw);
      if (capacityGeneration !== attestation.capacity_generation || !Number.isSafeInteger(reservationBytes) || reservationBytes <= 0) {
        throw new Error("IMAGE_LEDGER_CAPACITY_GENERATION_DRIFT");
      }
      const runRoot = metaKey.replace(/:meta$/, "");
      const inventoryKey = `${runRoot}:inventory`;
      if (Number(await command(["EXISTS", metaKey])) !== 0) {
        const frozen = await evalLua(D36_FREEZE_CLEANUP_LUA, [metaKey, inventoryKey], []);
        if (frozen.status !== "FROZEN") {
          results.push({ member, status: frozen.status, released: false });
          continue;
        }
        const exactKeys = [...new Set(frozen.values.map(String))].sort();
        const physicalKeys = await scanD36RootKeys(runRoot);
        if (!exactKeys.length || exactKeys.length !== physicalKeys.length || exactKeys.some((key, index) => key !== physicalKeys[index])) {
          results.push({ member, status: "INVENTORY_INCOMPLETE", released: false });
          continue;
        }
        await command(["DEL", ...exactKeys]);
        let remained = false;
        for (const key of exactKeys) if (Number(await command(["EXISTS", key])) !== 0) remained = true;
        if (remained || (await scanD36RootKeys(runRoot)).length !== 0) {
          results.push({ member, status: "PHYSICAL_KEYS_REMAIN", released: false });
          continue;
        }
      } else if ((await scanD36RootKeys(runRoot)).length !== 0) {
        results.push({ member, status: "PHYSICAL_KEYS_REMAIN", released: false });
        continue;
      }
      const released = await evalLua(D36_RELEASE_CAPACITY_LUA, [d36CapacityKey(appScopeId), expiryKey], [member, capacityGeneration, reservationBytes]);
      if (!new Set(["RELEASED", "ALREADY_RELEASED"]).has(released.status)) throw new Error(`IMAGE_LEDGER_${released.status}`);
      results.push({ member, status: released.status, released: true });
    }
    return results;
  };
  const verifyStartInventoryAndCapacity = async (context, attestation) => {
    const appScopeId = String(context?.appScopeId || "");
    await finalizeExpiredRunsWithAttestation(appScopeId, attestation);
    const dbSizeBefore = Number(await command(["DBSIZE"]));
    if (!Number.isSafeInteger(dbSizeBefore) || dbSizeBefore < 0) throw new Error("IMAGE_LEDGER_DBSIZE_INVALID");
    const keys = await scanPatternKeys("*");
    const dbSizeAfter = Number(await command(["DBSIZE"]));
    if (dbSizeBefore !== dbSizeAfter || keys.length !== dbSizeAfter) throw new Error("IMAGE_LEDGER_SCAN_NOT_STABLE");
    const isD37Key = (key) => key.startsWith(`${D37_PRODUCT_ROOT}:`);
    const isLegacyD36Key = (key) => /^xiaoshimei:image-d36:\{[0-9a-f]{32}\}:/.test(key);
    if (keys.some((key) => !isD37Key(key) && !isLegacyD36Key(key))) throw new Error("IMAGE_LEDGER_FOREIGN_KEYS_PRESENT");
    let physicalBytes = 0;
    for (const key of keys) {
      const usage = Number(await command(["MEMORY", "USAGE", key]));
      if (!Number.isSafeInteger(usage) || usage < 0) throw new Error("IMAGE_LEDGER_USAGE_UNKNOWN");
      physicalBytes += usage;
      if (!Number.isSafeInteger(physicalBytes)) throw new Error("IMAGE_LEDGER_USAGE_UNKNOWN");
    }
    const capacityRaw = await command(["HGETALL", d36CapacityKey(appScopeId)]);
    const capacity = redisHashObject(capacityRaw);
    if (capacity.schema !== "xiaoshimei.image-ledger-capacity.v2"
      || capacity.capacity_generation !== attestation.capacity_generation) {
      throw new Error("IMAGE_LEDGER_CAPACITY_GENERATION_DRIFT");
    }
    let reservedBytes = Number(capacity.reserved_bytes);
    let liveReservations = Number(capacity.live_reservations);
    let unfinalizedInventory = Number(capacity.unfinalized_inventory);
    if (![reservedBytes, liveReservations, unfinalizedInventory].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("IMAGE_LEDGER_CAPACITY_INVALID");
    }
    const legacyCapacityKeys = keys.filter((key) => /^xiaoshimei:image-d36:\{[0-9a-f]{32}\}:capacity$/.test(key));
    for (const key of legacyCapacityKeys) {
      const legacy = redisHashObject(await command(["HGETALL", key]));
      const values = [Number(legacy.reserved_bytes), Number(legacy.live_reservations), Number(legacy.unfinalized_inventory)];
      if (legacy.schema !== "xiaoshimei.image-ledger-capacity.v1" || !values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("IMAGE_LEDGER_LEGACY_CAPACITY_INVALID");
      }
      reservedBytes += values[0]; liveReservations += values[1]; unfinalizedInventory += values[2];
      if (![reservedBytes, liveReservations, unfinalizedInventory].every(Number.isSafeInteger)) throw new Error("IMAGE_LEDGER_CAPACITY_INVALID");
    }
    const runMetaKeys = keys.filter((key) => /:run:images-[^:]+:meta$/.test(key));
    const inventoryUnion = new Set(keys.filter((key) => key === d36CapacityKey(appScopeId)
      || /^xiaoshimei:image-d37:\{xiaoshimei-studio-v2\}:scope:[0-9a-f]{32}:(readiness|expiry)$/.test(key)
      || /^xiaoshimei:image-d36:\{[0-9a-f]{32}\}:(readiness|capacity|expiry)$/.test(key)));
    for (const metaKey of runMetaKeys) {
      const inventoryKey = metaKey.replace(/:meta$/, ":inventory");
      const members = await command(["SMEMBERS", inventoryKey]);
      if (!Array.isArray(members) || !members.includes(metaKey) || !members.includes(inventoryKey)) {
        throw new Error("IMAGE_LEDGER_INVENTORY_INCOMPLETE");
      }
      for (const member of members) inventoryUnion.add(String(member));
    }
    if (keys.some((key) => !inventoryUnion.has(key))) throw new Error("IMAGE_LEDGER_INVENTORY_UNION_MISMATCH");
    if (physicalBytes + reservedBytes + attestation.worst_case_run_bytes + attestation.headroom_bytes > attestation.capacity_limit_bytes) {
      throw new Error("IMAGE_LEDGER_CAPACITY_EXHAUSTED");
    }
    return { ...attestation, mode: "START", runtime_attested: true, physicalBytes, reservedBytes, liveReservations, unfinalizedInventory, legacyRootCount: legacyCapacityKeys.length };
  };
  const verifyStepReservation = async (context, attestation) => {
    const runId = String(context?.runId || "");
    const appScopeId = String(context?.appScopeId || "");
    const record = redisHashObject(await command(["HGETALL", `${d36RunRoot(runId, appScopeId)}:meta`]));
    if (record.app_scope !== appScopeId
      || record.capacity_generation !== attestation.capacity_generation
      || Number(record.capacity_reservation_bytes) !== attestation.worst_case_run_bytes
      || Number(record.capacity_released || 0) !== 0) {
      throw new Error("IMAGE_LEDGER_CAPACITY_RESERVATION_INVALID");
    }
    return { ...attestation, mode: "STEP", runtime_attested: true };
  };
  return {
    async assertReady() {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(["PING"]),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new Error("IMAGE_LEDGER_UNAVAILABLE");
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.error || payload?.result !== "PONG") throw new Error("IMAGE_LEDGER_UNAVAILABLE");
      return true;
    },
    async assertProductionReady(context = {}) {
      await this.assertReady();
      if (typeof readinessProbe === "function" || productionReadiness != null) {
        const observed = typeof readinessProbe === "function" ? await readinessProbe(structuredClone(context)) : productionReadiness;
        return assertProductionReadiness(observed);
      }
      const attestation = await verifyRuntimeSentinel(context);
      if (context.mode === "START") return verifyStartInventoryAndCapacity(context, attestation);
      if (context.mode === "STEP") return verifyStepReservation(context, attestation);
      throw new Error("IMAGE_LEDGER_READINESS_MODE_INVALID");
    },
    async finalizeExpiredRuns({ appScopeId, limit = 8 } = {}) {
      const attestation = await verifyRuntimeSentinel({ appScopeId });
      return finalizeExpiredRunsWithAttestation(String(appScopeId || ""), attestation, { limit });
    },
    async init(identity) {
      const keys = imageLedgerKeys(identity.runId);
      return evalLua(IMAGE_LEDGER_INIT_LUA, [keys.run], [identity.checkpointSha256, identity.attemptNonce, identity.attemptIndex, identity.jobIndex, identity.maxCalls, identity.expiresAtMs]);
    },
    async reserve(identity, { nowMs = Date.now(), leaseMs = IMAGE_LEDGER_IN_FLIGHT_LEASE_MS } = {}) {
      const keys = imageLedgerKeys(identity.runId, identity.attemptIndex);
      const reply = await evalLua(IMAGE_LEDGER_RESERVE_LUA, [keys.run, keys.attempt], [identity.checkpointSha256, identity.attemptNonce, identity.attemptIndex, identity.jobIndex, nowMs, leaseMs, identity.maxCalls, identity.expiresAtMs]);
      return reply.status === "CACHED" ? { ...reply, cachedBody: await getCached(keys.attempt) } : reply;
    },
    async commit(identity, { outcome, nextIdentity = null, status = "READY" } = {}) {
      const serialized = JSON.stringify(outcome);
      if (Buffer.byteLength(serialized) > IMAGE_LEDGER_MAX_CACHE_BYTES) throw new Error("IMAGE_LEDGER_CACHE_TOO_LARGE");
      const keys = imageLedgerKeys(identity.runId, identity.attemptIndex);
      const next = nextIdentity || { checkpointSha256: "", attemptNonce: "", attemptIndex: identity.attemptIndex + 1, jobIndex: identity.jobIndex };
      return evalLua(IMAGE_LEDGER_COMMIT_LUA, [keys.run, keys.attempt], [identity.checkpointSha256, identity.attemptNonce, sha256Bytes(Buffer.from(serialized)), outcome.kind === "SUCCESS" ? 200 : 422, serialized, next.checkpointSha256, next.attemptNonce, next.attemptIndex, next.jobIndex, status, identity.expiresAtMs]);
    },
    async markUnknown(identity) {
      const keys = imageLedgerKeys(identity.runId, identity.attemptIndex);
      return evalLua(IMAGE_LEDGER_UNKNOWN_LUA, [keys.run, keys.attempt], [identity.checkpointSha256, identity.attemptNonce]);
    },
    async claimStart({ runId, appScopeId, bootstrapNonce, inputSha256, snapshot, referenceManifest, accessExpiresAtMs, readiness, minRemainingMs = ACCESS_SESSION_PAID_MIN_REMAINING_MS, ttlMs = IMAGE_LEDGER_RUN_TTL_MS, physicalTtlMs = IMAGE_LEDGER_PHYSICAL_TTL_MS } = {}) {
      const root = d36RunRoot(runId, appScopeId);
      const snapshotJson = canonicalJson(snapshot);
      const manifestJson = canonicalJson(referenceManifest);
      const runtimeAttested = readiness?.runtime_attested === true;
      const reply = await evalLua(
        D36_CLAIM_START_LUA,
        runtimeAttested
          ? [`${root}:meta`, `${root}:inventory`, d36CapacityKey(appScopeId), d36ExpiryIndexKey(appScopeId)]
          : [`${root}:meta`, `${root}:inventory`],
        runtimeAttested
          ? [appScopeId, bootstrapNonce, inputSha256, sha256Bytes(Buffer.from(snapshotJson)), sha256Bytes(Buffer.from(manifestJson)), snapshotJson, manifestJson, accessExpiresAtMs, minRemainingMs, ttlMs, readiness.attestation_generation, readiness.capacity_generation, readiness.worst_case_run_bytes, physicalTtlMs]
          : [appScopeId, bootstrapNonce, inputSha256, sha256Bytes(Buffer.from(snapshotJson)), sha256Bytes(Buffer.from(manifestJson)), snapshotJson, manifestJson, accessExpiresAtMs, minRemainingMs, ttlMs],
      );
      return {
        status: reply.status,
        runId,
        ownerToken: reply.values[0] || null,
        fence: Number(reply.values[1] || 0),
        recoverableUntil: Number(reply.values[2] || 0),
      };
    },
    async putRunAsset({ runId, appScopeId, manifest, bytes } = {}) {
      const value = assertExactJpegAsset(bytes, manifest);
      const root = d36RunRoot(runId, appScopeId);
      const key = d36AssetKey(runId, manifest.sha256, appScopeId);
      const encoded = value.toString("base64");
      const stored = await evalLua(D36_PUT_ASSET_LUA, [`${root}:meta`, `${root}:inventory`, key], [encoded]);
      if (stored.status === "CAS_CONFLICT") throw new Error("IMAGE_ASSET_CAS_CONFLICT");
      if (!new Set(["STORED", "EXISTING"]).has(stored.status)) throw new Error(`IMAGE_ASSET_STORE_${stored.status}`);
      const readback = await command(["GET", key]);
      if (typeof readback !== "string" || !Buffer.from(readback, "base64").equals(value)) throw new Error("IMAGE_ASSET_READBACK_FAILED");
      return { status: stored.status, manifest: structuredClone(manifest) };
    },
    async readRunAsset({ runId, appScopeId, sha256 } = {}) {
      const value = await command(["GET", d36AssetKey(runId, sha256, appScopeId)]);
      if (value == null) return { status: "MISSING" };
      const bytes = Buffer.from(String(value), "base64");
      if (sha256Bytes(bytes) !== sha256) return { status: "CORRUPT" };
      return { status: "FOUND", bytes };
    },
    async claimPlanner({ runId, appScopeId, ownerToken = randomUUID(), materializedManifestSha256, accessExpiresAtMs, minRemainingMs = ACCESS_SESSION_PAID_MIN_REMAINING_MS, leaseMs = IMAGE_PLANNER_LEASE_MS } = {}) {
      const reply = await evalLua(D36_CLAIM_PLANNER_LUA, [`${d36RunRoot(runId, appScopeId)}:meta`], [ownerToken, leaseMs, materializedManifestSha256, accessExpiresAtMs, minRemainingMs]);
      return { status: reply.status, ownerToken: reply.values[0] || (reply.status === "PLANNING" ? ownerToken : null), fence: Number(reply.values[1] || 0) };
    },
    async commitPlanner({ runId, appScopeId, ownerToken, fence, compactRun, checkpointPreimage, checkpointPreimageSha256, logicalStepId, response } = {}) {
      const root = d36RunRoot(runId, appScopeId);
      const runJson = canonicalJson(compactRun);
      const responseJson = canonicalJson(response);
      const reply = await evalLua(D36_COMMIT_PLANNER_LUA, [`${root}:meta`], [ownerToken, fence, runJson, sha256Bytes(Buffer.from(runJson)), canonicalJson(checkpointPreimage), checkpointPreimageSha256, logicalStepId, responseJson]);
      return { status: reply.status };
    },
    async markPlannerUnknown({ runId, appScopeId, ownerToken, fence } = {}) {
      const reply = await evalLua(D36_MARK_PLANNER_UNKNOWN_LUA, [`${d36RunRoot(runId, appScopeId)}:meta`], [ownerToken, fence]);
      return { status: reply.status };
    },
    async markPlannerFailed({ runId, appScopeId, ownerToken, fence, errorCode, response } = {}) {
      const reply = await evalLua(
        D36_MARK_PLANNER_FAILED_LUA,
        [`${d36RunRoot(runId, appScopeId)}:meta`],
        [ownerToken, fence, errorCode, canonicalJson(response)],
      );
      return { status: reply.status };
    },
    async discover({ runId, appScopeId, bootstrapNonce, inputSha256 } = {}) {
      return discoverD36({ runId, appScopeId, bootstrapNonce, inputSha256, requireExternalIdentity: true });
    },
    async discoverByRun({ runId, appScopeId } = {}) {
      return discoverD36({ runId, appScopeId, requireExternalIdentity: false });
    },
    async reserveStep({ runId, appScopeId, checkpointPreimageSha256, logicalStepId, attemptNonce, ownerToken = randomUUID(), accessExpiresAtMs, minRemainingMs = ACCESS_SESSION_PAID_MIN_REMAINING_MS, leaseMs = IMAGE_LEDGER_IN_FLIGHT_LEASE_MS, maxCalls = 6 } = {}) {
      const actionId = d36StepActionId(runId, checkpointPreimageSha256, logicalStepId);
      const root = d36RunRoot(runId, appScopeId);
      const stepKey = `${root}:step:${actionId}`;
      const reply = await evalLua(D36_RESERVE_STEP_LUA, [`${root}:meta`, `${root}:inventory`, stepKey], [checkpointPreimageSha256, logicalStepId, attemptNonce, ownerToken, leaseMs, IMAGE_LEDGER_COMMIT_MARGIN_MS, "", accessExpiresAtMs, minRemainingMs, maxCalls]);
      let cachedResponse = null;
      if (reply.status === "CACHED") {
        const value = await command(["HGET", stepKey, "result_json"]);
        if (typeof value !== "string") throw new Error("IMAGE_LEDGER_CACHE_UNAVAILABLE");
        cachedResponse = JSON.parse(value);
      }
      return {
        status: reply.status,
        actionId,
        cacheKind: reply.status === "CACHED" ? String(reply.values[0] || "COMMITTED") : null,
        ownerToken: reply.status === "RESERVED" ? (reply.values[0] || ownerToken) : null,
        fence: reply.status === "RESERVED" ? Number(reply.values[1] || 0) : 0,
        cachedResponse,
      };
    },
    async commitStep({ runId, appScopeId, checkpointPreimageSha256, logicalStepId, attemptNonce, actionId, ownerToken, fence, compactRun, checkpointPreimage, nextCheckpointPreimageSha256, nextLogicalStepId, response, status } = {}) {
      const root = d36RunRoot(runId, appScopeId);
      const resultJson = canonicalJson(response);
      const runJson = canonicalJson(compactRun);
      const reply = await evalLua(D36_COMMIT_STEP_LUA, [`${root}:meta`, `${root}:step:${actionId}`], [checkpointPreimageSha256, logicalStepId, attemptNonce, ownerToken, fence, sha256Bytes(Buffer.from(resultJson)), resultJson, status, runJson, sha256Bytes(Buffer.from(runJson)), canonicalJson(checkpointPreimage), nextCheckpointPreimageSha256, nextLogicalStepId]);
      return { status: reply.status };
    },
    async markStepUnknown({ runId, appScopeId, actionId, attemptNonce, ownerToken, fence } = {}) {
      const root = d36RunRoot(runId, appScopeId);
      const reply = await evalLua(D36_MARK_STEP_UNKNOWN_LUA, [`${root}:meta`, `${root}:step:${actionId}`], [attemptNonce, ownerToken, fence]);
      let cachedResponse = null;
      if (reply.status === "COMMITTED" || reply.status === "LATE_RESULT") {
        const value = await command(["HGET", `${root}:step:${actionId}`, "result_json"]);
        if (typeof value === "string") cachedResponse = JSON.parse(value);
      }
      return { status: reply.status, cachedResponse };
    },
    async readAsset({ runId, sha256, appScopeId } = {}) {
      const discoveredRaw = await command(["HGETALL", `${d36RunRoot(runId, appScopeId)}:meta`]);
      if (!Array.isArray(discoveredRaw) || discoveredRaw.length === 0) return { status: "RUN_MISSING" };
      const record = redisHashObject(discoveredRaw);
      if (record.app_scope !== appScopeId) return { status: "FORBIDDEN" };
      const manifest = [
        ...(record.manifest_json ? JSON.parse(record.manifest_json) : []),
        ...((record.run_json ? JSON.parse(record.run_json).assets : []) || []).map((asset) => stripAssetUrl(d36ManifestFromAsset(asset, runId))),
      ].find((item) => item.sha256 === sha256);
      if (!manifest) return { status: "NOT_MEMBER" };
      const stored = await this.readRunAsset({ runId, appScopeId, sha256 });
      if (stored.status !== "FOUND") return stored;
      try { assertExactJpegAsset(stored.bytes, manifest); }
      catch { return { status: "CORRUPT" }; }
      return { status: "FOUND", bytes: Buffer.from(stored.bytes), manifest };
    },
    async cleanupRun({ runId, appScopeId, exactKeys = [] } = {}) {
      const root = d36RunRoot(runId, appScopeId);
      if (exactKeys.length) throw new TypeError("IMAGE_LEDGER_CLEANUP_CALLER_KEYS_FORBIDDEN");
      const metaKey = `${root}:meta`;
      const inventoryKey = d36InventoryKey(runId, appScopeId);
      const frozen = await evalLua(D36_FREEZE_CLEANUP_LUA, [metaKey, inventoryKey], []);
      if (frozen.status !== "FROZEN") return { status: frozen.status, released: false, keys: [] };
      const keys = [...new Set(frozen.values.map(String))].sort();
      if (!keys.length || !keys.includes(metaKey) || !keys.includes(inventoryKey)
        || !keys.every((key) => key.startsWith(`${root}:`))) return { status: "INVENTORY_INCOMPLETE", released: false, keys };
      const physicalKeys = await scanD36RootKeys(root);
      if (physicalKeys.length !== keys.length || physicalKeys.some((key, index) => key !== keys[index])) {
        return { status: "INVENTORY_INCOMPLETE", released: false, keys, physicalKeys };
      }
      await command(["DEL", ...keys]);
      for (const key of keys) if (Number(await command(["EXISTS", key])) !== 0) return { status: "PHYSICAL_KEYS_REMAIN", released: false, keys };
      return {
        status: "PHYSICAL_ABSENT_READBACK",
        physicalReleased: true,
        released: false,
        keys,
      };
    },
  };
}

export function createUpstashImageLedgerFromEnv(env = process.env, options = {}) {
  const value = imageLedgerEnv(env);
  if (!value.ready) return null;
  const access = inspectServerAccessConfig(env);
  const runtimeBinding = imageLedgerRuntimeBinding(env, access.appScope, value.url);
  return createUpstashImageLedger({ url: value.url, token: value.token, runtimeBinding, ...options });
}

function publicRunCreatedAtMs(runId) {
  const match = /^images-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}$/.exec(String(runId || ""));
  if (!match) throw new TypeError("IMAGE_LEDGER_RUN_ID_INVALID");
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7]));
}

export function imageLedgerIdentity(checkpoint, apiKey) {
  const parsed = parsePublicImageRun(checkpoint);
  if (!parsed.signature) throw new TypeError("PUBLIC_IMAGE_RESUME_SIGNATURE_INVALID");
  const checkpointSha256 = sha256Bytes(Buffer.from(canonicalJson(parsed)));
  return {
    runId: parsed.run_id,
    checkpointSha256,
    attemptNonce: createHmac("sha256", apiKey).update(`xiaoshimei-image-ledger-attempt-v1:${checkpointSha256}`).digest("hex"),
    attemptIndex: parsed.actual_image_calls,
    jobIndex: parsed.next_job_index,
    maxCalls: parsed.max_image_calls,
    expiresAtMs: publicRunCreatedAtMs(parsed.run_id) + IMAGE_LEDGER_RUN_TTL_MS,
  };
}

function cachedOutcome(value) {
  let outcome;
  try { outcome = typeof value === "string" ? JSON.parse(value) : value; } catch { throw new Error("IMAGE_LEDGER_CACHE_INVALID"); }
  if (outcome?.kind === "SUCCESS") return outcome.value;
  if (outcome?.kind === "ERROR") {
    const error = new Error(String(outcome.code || "IMAGE_LEDGER_CACHED_ERROR"));
    if (outcome.details && typeof outcome.details === "object") error.details = structuredClone(outcome.details);
    throw error;
  }
  throw new Error("IMAGE_LEDGER_CACHE_INVALID");
}

function imageLedgerStateError(status, identity, details = {}) {
  const code = status === "BUDGET_EXHAUSTED" ? "IMAGE_CALL_BUDGET_EXHAUSTED"
    : status === "IN_FLIGHT" ? "IMAGE_STEP_IN_FLIGHT"
      : status === "UNKNOWN" ? "IMAGE_STEP_UNKNOWN"
        : status === "COMPLETE" ? "IMAGE_RUN_ALREADY_COMPLETE"
          : status === "RUN_MISSING" ? "IMAGE_LEDGER_RUN_MISSING"
            : status === "NONCE_CONFLICT" || status === "CHECKPOINT_CONFLICT" || status === "COMMIT_CONFLICT" || status === "CONFLICT" ? "IMAGE_LEDGER_REPLAY_CONFLICT"
              : "IMAGE_LEDGER_UNAVAILABLE";
  const error = new Error(code);
  error.details = {
    resume_run_id: identity?.runId || null,
    retry_scope: status === "IN_FLIGHT" ? "CHECK_SAME_STEP_WITHOUT_UPSTREAM" : status === "BUDGET_EXHAUSTED" ? "NO_MORE_PAID_CALLS_IN_THIS_RUN" : "OPEN_NEW_RUN_ONLY_AFTER_USER_DECISION",
    ledger_status: status,
    ...details,
  };
  return error;
}

function checkpointWithoutSignature(value) {
  const checkpoint = structuredClone(value);
  delete checkpoint.signature;
  return checkpoint;
}

export function signPublicImageCheckpoint(value, apiKey) {
  const checkpoint = parsePublicImageRun(checkpointWithoutSignature(value));
  return { ...checkpoint, signature: createHmac("sha256", apiKey).update(canonicalJson(checkpoint)).digest("hex") };
}

export function verifyPublicImageCheckpoint(value, apiKey, expected) {
  const parsed = parsePublicImageRun(value, expected);
  if (!/^[0-9a-f]{64}$/.test(String(parsed.signature || ""))) throw new TypeError("PUBLIC_IMAGE_RESUME_SIGNATURE_INVALID");
  const expectedSignature = createHmac("sha256", apiKey).update(canonicalJson(checkpointWithoutSignature(parsed))).digest("hex");
  if (!timingSafeEqual(Buffer.from(parsed.signature), Buffer.from(expectedSignature))) throw new TypeError("PUBLIC_IMAGE_RESUME_SIGNATURE_INVALID");
  return parsed;
}

function publicReferenceFingerprint(input) {
  return sha256Bytes(Buffer.from(JSON.stringify({
    references: input.reference_images.map((item) => ({ name: item.name, sha256: sha256Bytes(Buffer.from(item.data_url)) })),
    note: input.reference_note,
  })));
}

function publicImageStepResponse(checkpoint, settings) {
  const signed = signPublicImageCheckpoint(checkpoint, settings.apiKey);
  const response = {
    schema: PUBLIC_IMAGE_STEP_RESPONSE_SCHEMA,
    status: "PARTIAL",
    resume: { ...publicImageRunProgress(signed, IMAGE_PRICE_CNY), resume_checkpoint: signed },
  };
  assertPublicGenerationResponseBudget(response);
  return response;
}

function publicImageResumeError(error, checkpoint, settings, { providerAssetReturned = false, providerRequestStarted = false } = {}) {
  const failed = failPublicImageJob(checkpoint, { code: String(error?.message || error), providerAssetReturned });
  const signed = signPublicImageCheckpoint(failed, settings.apiKey);
  error.details = {
    ...publicImageRunProgress(signed, IMAGE_PRICE_CNY),
    resume_checkpoint: signed,
    retry_scope: "CURRENT_IMAGE_STEP_ONLY",
    current_step_may_replay: providerRequestStarted,
    provider_asset_returned: providerAssetReturned,
  };
  return error;
}

function publicImageBudgetError(checkpoint, settings) {
  const exhausted = markPublicImageBudgetExhausted(checkpoint);
  const signed = signPublicImageCheckpoint(exhausted, settings.apiKey);
  const error = new Error("IMAGE_CALL_BUDGET_EXHAUSTED");
  error.details = {
    ...publicImageRunProgress(signed, IMAGE_PRICE_CNY),
    resume_checkpoint: signed,
    retry_scope: "NO_MORE_PAID_CALLS_IN_THIS_RUN",
    current_step_may_replay: false,
    provider_asset_returned: false,
  };
  return error;
}

function advancePublicImageRun(checkpoint) {
  if (checkpoint.next_job_index < checkpoint.jobs.length) return checkpoint;
  const unresolved = unresolvedPublicImageUnitIds(checkpoint);
  if (!unresolved.length) return completePublicImageRun(checkpoint);
  const units = checkpoint.illustration_units.filter((unit) => unresolved.includes(unit.unit_id));
  if (checkpoint.phase === "PRIMARY") {
    const repairJobs = buildMissingUnitRepairJobs(units, checkpoint.jobs.length).map((job) => ({ ...job, job_kind: "mother_sheet" }));
    return appendPublicImageJobs(checkpoint, { phase: "GROUPED_REPAIR", jobs: repairJobs });
  }
  if (checkpoint.phase === "GROUPED_REPAIR") {
    const repairJobs = units.map((unit, offset) => ({
      sheet_index: checkpoint.jobs.length + offset,
      sheet_id: `standalone-repair-${unit.unit_id}`,
      template: "standalone",
      kv_unit_index: null,
      unit_labels: ["补"],
      units: [structuredClone(unit)],
      repair: true,
      job_kind: "standalone",
    }));
    return appendPublicImageJobs(checkpoint, { phase: "STANDALONE_REPAIR", jobs: repairJobs });
  }
  return exhaustPublicImageRun(checkpoint);
}

async function createInitialPublicImageRun(input, settings, pageCount, draftSha256, referenceFingerprint, { runId = null } = {}) {
  let pages;
  let planError;
  const planAttempts = [];
  const serverManaged = settings.credentialMode === "SERVER_MANAGED";
  const maxPlanAttempts = serverManaged ? 1 : 3;
  for (let attempt = 1; attempt <= maxPlanAttempts; attempt += 1) {
    const qualityFeedback = planError ? pagePlanRetryGuidance(planError) : "";
    const result = await arkPost("/responses", settings.apiKey, buildArkPagePlanRequest(input.draft, pageCount, settings.textModel, qualityFeedback, input.production_mode, input.reference_note), "PAGE_PLAN_MODEL_CALL_FAILED");
    try {
      pages = extractArkPagePlan(result, pageCount, { topic: input.draft.source_input, pillar: input.draft.pillar, goal: input.draft.goal, productionMode: input.production_mode, repairEyeCareEvidence: !serverManaged && attempt === 3 });
      assertXhsPublishQuality(pages.map((page) => ({
        page_role: page.pageRole,
        eyebrow: page.eyebrow,
        title: page.title,
        body: page.body,
        info_panels: page.panels.map((panel) => ({ title: panel.title, body: panel.body, content_role: panel.contentRole })),
      })), { pillar: input.draft.pillar, publishBody: input.draft.body, productionMode: input.production_mode });
      planAttempts.push({ attempt, status: "PASS" });
      break;
    } catch (error) {
      planError = error;
      planAttempts.push({ attempt, status: "REJECTED", rejection_code: String(error?.message || error).slice(0, 180) });
    }
  }
  if (!pages) throw planError || new Error("PAGE_PLAN_REJECTED");
  const units = buildIllustrationUnits(pages);
  const jobs = groupIllustrationUnits(units).map((job) => ({ ...job, job_kind: "mother_sheet" }));
  return createPublicImageRun({
    runId: runId || `images-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    draftId: input.draft.draft_id,
    draftSha256,
    productionMode: input.production_mode,
    finalPages: pages,
    illustrationUnits: units,
    planAttempts,
    referenceFingerprint,
    jobs,
  });
}

async function executePublicImageJob(checkpoint, input, settings) {
  let active = checkpoint;
  const job = active.jobs[active.next_job_index];
  const tileBudget = publicTileBudgetForResponse(active.illustration_units.length);
  const extraReferences = input.reference_images.map((item) => item.data_url);
  let providerAssetReturned = false;
  let providerRequestStarted = false;
  try {
    const prompt = job.job_kind === "standalone"
      ? buildStandaloneRepairPrompt(job.units[0], { styleLock: input.draft.style_lock, imageContext: input.draft.prompt_context })
      : buildMotherSheetPrompt(job, { styleLock: input.draft.style_lock, imageContext: input.draft.prompt_context });
    active = startPublicImageJob(active);
    providerRequestStarted = true;
    const payload = await arkPost("/images/generations", settings.apiKey, buildArkImageRequest({ model: settings.imageModel, prompt, referenceImageDataUrl: XIAOSHIMEI_AVATAR_DATA_URL, actionReferenceImageDataUrls: extraReferences, actionReferenceNote: input.reference_note }), `${job.job_kind === "standalone" ? "STANDALONE_REPAIR" : "MOTHER_SHEET"}_${active.next_job_index + 1}_CALL_FAILED`);
    providerAssetReturned = true;
    const image = await imagePayload(payload);
    const tiles = job.job_kind === "standalone"
      ? [await sliceStandaloneRepairForUnit(image.bytes, job.units[0], { maxBytes: tileBudget, allowMissing: true })]
      : await splitMotherSheetForUnits(image.bytes, job, { maxBytes: tileBudget, allowMissing: true });
    active = admitPublicImageJob(active, {
      assets: tiles.filter((tile) => !tile.missing),
      attempt: {
        image_sha256: image.sha256,
        image_size_bytes: image.bytes.length,
        missing_unit_ids: tiles.filter((tile) => tile.missing).map((tile) => tile.unit_id),
      },
    });
    return advancePublicImageRun(active);
  } catch (error) {
    if (!providerRequestStarted) throw error;
    throw publicImageResumeError(error, active, settings, { providerAssetReturned, providerRequestStarted });
  }
}

function assemblePublicImageContent(checkpoint, input, settings) {
  const assetMap = buildAssetMapFromMotherSheets(checkpoint.final_pages, checkpoint.illustration_units, [{ tiles: checkpoint.assets }]);
  const successfulMotherSheets = checkpoint.job_attempts.filter((attempt) => attempt.job_kind === "mother_sheet" && attempt.decision !== "FAILED_RESUMABLE").length;
  const initialMissing = new Set(checkpoint.job_attempts.filter((attempt) => attempt.job_index < groupIllustrationUnits(checkpoint.illustration_units).length).flatMap((attempt) => attempt.missing_unit_ids || []));
  let content = assembleArkContentFromDraft(input.draft, checkpoint.final_pages, assetMap, { textModel: settings.textModel, imageModel: settings.imageModel, motherSheetCount: successfulMotherSheets, illustrationUnitCount: checkpoint.illustration_units.length, enforcePublishQuality: true }, input.production_mode);
  content = {
    ...content,
    generation: {
      ...content.generation,
      run_id: checkpoint.run_id,
      strategy: "resumable_public_image_steps_v1",
      credential_mode: settings.credentialMode,
      mother_sheet_count: successfulMotherSheets,
      illustration_unit_count: checkpoint.illustration_units.length,
      actual_image_calls: checkpoint.actual_image_calls,
      estimated_image_cost_cny: Number((checkpoint.actual_image_calls * IMAGE_PRICE_CNY).toFixed(2)),
      page_plan_attempts: checkpoint.plan_attempts,
      image_step_attempts: checkpoint.job_attempts,
      tile_sha256: checkpoint.assets.map((asset) => asset.sha256),
      tile_transport_budget_bytes: publicTileBudgetForResponse(checkpoint.illustration_units.length),
      repaired_missing_unit_count: [...initialMissing].filter((unitId) => checkpoint.assets.some((asset) => asset.unit_id === unitId)).length,
      repair_mother_sheet_count: checkpoint.jobs.filter((job) => job.repair && job.job_kind === "mother_sheet").length,
      standalone_repair_count: checkpoint.jobs.filter((job) => job.job_kind === "standalone").length,
    },
  };
  const responseSizeBytes = assertPublicGenerationResponseBudget(content);
  content.generation.response_size_bytes = responseSizeBytes;
  assertPublicGenerationResponseBudget(content);
  return parseContentPackage(JSON.stringify(content));
}

function imageLedgerErrorOutcome(error) {
  return {
    kind: "ERROR",
    code: String(error?.message || error || "IMAGE_STEP_FAILED").slice(0, 360),
    ...(error?.details && typeof error.details === "object" ? { details: structuredClone(error.details) } : {}),
  };
}

async function markImageLedgerUnknown(imageLedger, identity, cause) {
  try {
    const result = await imageLedger.markUnknown(identity);
    if (result?.status === "COMMITTED") return true;
  } catch {
    // The authority could not prove a durable result, so the old run remains
    // frozen. Never infer safety from a failed readback.
  }
  const error = imageLedgerStateError("UNKNOWN", identity, { cause: String(cause?.message || cause || "IMAGE_LEDGER_COMMIT_FAILED").slice(0, 180) });
  error.cause = cause;
  throw error;
}

async function commitImageLedgerOutcome(imageLedger, identity, { outcome, nextIdentity, status }) {
  let result;
  try {
    result = await imageLedger.commit(identity, { outcome, nextIdentity, status });
  } catch (error) {
    if (await markImageLedgerUnknown(imageLedger, identity, error)) return;
  }
  if (result?.status !== "COMMITTED") throw imageLedgerStateError(result?.status || "UNKNOWN", identity);
}

function d36LegacyInput(snapshot, referenceDataUrls = []) {
  const draft = {
    schema: TEXT_DRAFT_RESPONSE_SCHEMA,
    created_at: new Date(0).toISOString(),
    text_requirements: "",
    generation: {},
    ...structuredClone(snapshot.confirmed_draft),
  };
  return {
    draft,
    production_mode: snapshot.production_mode,
    image_count: snapshot.page_count,
    reference_images: referenceDataUrls,
    reference_note: snapshot.reference_note,
  };
}

function d36Progress(run) {
  const completedPages = new Set((run.assets || []).map((asset) => asset.page_index)).size;
  return {
    resume_run_id: run.run_id,
    completed_pages: completedPages,
    total_pages: run.final_page_count,
    completed_image_steps: run.next_job_index,
    total_image_steps: run.jobs.length,
    actual_image_calls: run.actual_image_calls,
    max_image_calls: run.max_image_calls,
    remaining_image_calls: Math.max(0, run.max_image_calls - run.actual_image_calls),
    estimated_image_cost_cny: Number((run.actual_image_calls * IMAGE_PRICE_CNY).toFixed(2)),
  };
}

function d36PlaceholderCheckpoint(runId, status) {
  const base = { schema: "xiaoshimei.image-checkpoint.v1", run_id: runId, state: status };
  return { ...base, state_sha256: sha256Json(base) };
}

function d36Response({ status, bootstrapNonce, inputSha256, runId, checkpointPreimage, logicalStepId, progress = {}, assets = [], mediaDelta = [], cached = false, recoverableUntil = 0, upstreamCalls = 0, error = null, contentPackage = undefined }) {
  const checkpoint = checkpointPreimage || d36PlaceholderCheckpoint(runId, status);
  const response = {
    schema: IMAGE_GENERATION_RESPONSE_SCHEMA,
    status,
    bootstrap_nonce: bootstrapNonce,
    input_sha256: inputSha256,
    run_id: runId,
    checkpoint_preimage: checkpoint,
    checkpoint_preimage_sha256: sha256Json(checkpoint),
    logical_step_id: logicalStepId || "discover",
    progress: structuredClone(progress),
    assets: structuredClone(assets),
    media_delta: structuredClone(mediaDelta),
    error: error == null ? null : structuredClone(error),
    cached: Boolean(cached),
    recoverable_until: d36RecoverableUntil(recoverableUntil),
    upstream_calls: upstreamCalls,
    ...(contentPackage === undefined ? {} : { content_package: structuredClone(contentPackage) }),
  };
  const sizeBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  if (sizeBytes > IMAGE_TRANSACTION_RESPONSE_MAX_BYTES) throw new Error("IMAGE_GENERATION_RESPONSE_TOO_LARGE");
  return parseImageGenerationResponse(response);
}

function d36ResponseForCompactRun({ compactRun, bootstrapNonce, inputSha256, apiKey, mediaDelta = [], cached = false, recoverableUntil, upstreamCalls = 0, status = null, contentPackage = undefined, error = null }) {
  const checkpoint = d36CheckpointPreimage(compactRun, apiKey);
  const assets = (compactRun.assets || []).map((asset) => d36ManifestFromAsset(asset, compactRun.run_id));
  return d36Response({
    status: status || (compactRun.status === "COMPLETE" ? "COMPLETE" : "PARTIAL"),
    bootstrapNonce,
    inputSha256,
    runId: compactRun.run_id,
    checkpointPreimage: checkpoint,
    logicalStepId: d36LogicalStepId(compactRun),
    progress: d36Progress(compactRun),
    assets,
    mediaDelta,
    cached,
    recoverableUntil,
    upstreamCalls,
    error,
    contentPackage,
  });
}

function imageTransactionStateError(status, details = {}) {
  const code = status === "EXPIRY_WINDOW_TOO_SHORT" ? "EXPIRY_WINDOW_TOO_SHORT"
    : status === "RUN_EXPIRY_WINDOW_TOO_SHORT" ? "IMAGE_RUN_EXPIRY_WINDOW_TOO_SHORT"
    : status === "BUDGET_EXHAUSTED" ? "IMAGE_CALL_BUDGET_EXHAUSTED"
      : status === "IN_FLIGHT" ? "IMAGE_STEP_IN_FLIGHT"
        : status === "UNKNOWN" ? "IMAGE_STEP_UNKNOWN"
          : status === "RUN_MISSING" || status === "NOT_FOUND" ? "IMAGE_LEDGER_RUN_MISSING"
            : status === "NONCE_CONFLICT" ? "IMAGE_STEP_NONCE_CONFLICT"
              : status === "CHECKPOINT_CONFLICT" || status === "CONFLICT" ? "IMAGE_LEDGER_REPLAY_CONFLICT"
              : status === "COMPLETE" ? "IMAGE_RUN_ALREADY_COMPLETE"
                : "IMAGE_LEDGER_UNAVAILABLE";
  const error = new Error(code);
  error.details = { ledger_status: status, ...details };
  return error;
}

async function readAndVerifyD36ReferenceAssets(imageLedger, runId, appScopeId, referenceManifest) {
  const references = [];
  for (const manifest of referenceManifest || []) {
    const stored = await imageLedger.readRunAsset({ runId, appScopeId, sha256: manifest.sha256 });
    if (!stored || stored.status !== "FOUND") throw new Error(stored?.status === "CORRUPT" ? "IMAGE_REFERENCE_MEDIA_CORRUPT" : "IMAGE_REFERENCE_MEDIA_MISSING");
    const bytes = assertExactJpegAsset(stored.bytes, manifest);
    references.push({ name: manifest.name, data_url: `data:image/jpeg;base64,${bytes.toString("base64")}` });
  }
  return references;
}

async function materializeD36References(input, imageLedger, runId, appScopeId) {
  const missing = new Map(input.missing_reference_media.map((item) => [item.media_ref, item]));
  for (const manifest of input.reference_manifest) {
    const current = await imageLedger.readRunAsset({ runId, appScopeId, sha256: manifest.sha256 });
    if (current?.status === "FOUND") {
      assertExactJpegAsset(current.bytes, manifest);
      continue;
    }
    if (current?.status === "CORRUPT") throw new Error("IMAGE_REFERENCE_MEDIA_CORRUPT");
    const transfer = missing.get(manifest.media_ref);
    if (!transfer) throw new Error("IMAGE_REFERENCE_MEDIA_MISSING");
    const bytes = Buffer.from(transfer.bytes_base64, "base64");
    assertExactJpegAsset(bytes, manifest);
    await imageLedger.putRunAsset({ runId, appScopeId, manifest: stripAssetUrl(manifest), bytes });
    const readback = await imageLedger.readRunAsset({ runId, appScopeId, sha256: manifest.sha256 });
    if (!readback || readback.status !== "FOUND") throw new Error("IMAGE_REFERENCE_MEDIA_READBACK_FAILED");
    assertExactJpegAsset(readback.bytes, manifest);
  }
  await readAndVerifyD36ReferenceAssets(imageLedger, runId, appScopeId, input.reference_manifest);
}

async function persistD36GeneratedAssets(imageLedger, runId, appScopeId, run, previousAssets = []) {
  const previous = new Set(previousAssets.map((asset) => asset.sha256));
  const mediaDelta = [];
  for (const asset of run.assets || []) {
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(asset.src || ""));
    if (!match) throw new Error("IMAGE_GENERATED_ASSET_INLINE_MISSING");
    const bytes = Buffer.from(match[1], "base64");
    const manifest = stripAssetUrl(d36ManifestFromAsset(asset, runId));
    assertExactJpegAsset(bytes, manifest);
    await imageLedger.putRunAsset({ runId, appScopeId, manifest, bytes });
    const readback = await imageLedger.readRunAsset({ runId, appScopeId, sha256: asset.sha256 });
    if (!readback || readback.status !== "FOUND") throw new Error("IMAGE_GENERATED_ASSET_READBACK_FAILED");
    assertExactJpegAsset(readback.bytes, manifest);
    if (!previous.has(asset.sha256)) mediaDelta.push(d36ManifestFromAsset(asset, runId));
  }
  return { compactRun: compactPublicImageRun(run), mediaDelta };
}

async function readD36RunState(imageLedger, runId, appScopeId) {
  const state = typeof imageLedger.discoverByRun === "function"
    ? await imageLedger.discoverByRun({ runId, appScopeId })
    : await imageLedger.discover({ runId, appScopeId });
  if (!state || state.status === "NOT_FOUND" || state.status === "RUN_MISSING") throw imageTransactionStateError("RUN_MISSING", { run_id: runId });
  if (state.status === "CONFLICT" || state.status === "FORBIDDEN") throw imageTransactionStateError("CONFLICT", { run_id: runId });
  return state;
}

async function recoverD36CommittedResponse(imageLedger, runId, appScopeId) {
  try {
    const state = await readD36RunState(imageLedger, runId, appScopeId);
    if (state.cachedResponse && new Set(["READY", "PARTIAL", "COMPLETE"]).has(state.status)) {
      return parseImageGenerationResponse({ ...state.cachedResponse, cached: true, upstream_calls: 0 });
    }
  } catch (error) {
    if (error?.message === "IMAGE_LEDGER_RUN_MISSING" || error?.message === "IMAGE_LEDGER_REPLAY_CONFLICT") return null;
    throw error;
  }
  return null;
}

function returnOrThrowD36Response(value) {
  const response = parseImageGenerationResponse(value);
  if (response.status !== "ERROR") return response;
  const cause = String(response.error?.details?.cause || "").slice(0, 180);
  const code = `${response.error?.code || "IMAGE_STEP_FAILED"}${cause ? `:${cause}` : ""}`;
  const error = new Error(code);
  error.details = structuredClone(response);
  throw error;
}

async function markPlannerUnknown(imageLedger, claim, cause) {
  if (typeof imageLedger.markPlannerUnknown === "function") {
    try { await imageLedger.markPlannerUnknown({ runId: claim.runId, appScopeId: claim.appScopeId, ownerToken: claim.ownerToken, fence: claim.fence }); }
    catch { /* Fail closed below. */ }
  }
  const error = imageTransactionStateError("UNKNOWN", { run_id: claim.runId, cause: String(cause?.message || cause || "PLANNER_UNKNOWN").slice(0, 180) });
  error.cause = cause;
  throw error;
}

function plannerFailureResponse({ bootstrapNonce, inputSha256, runId, recoverableUntil, cause, cached = false, upstreamCalls = 1 } = {}) {
  const causeText = String(cause?.message || cause || "PLANNER_FAILED").slice(0, 180);
  return d36Response({
    status: "ERROR",
    bootstrapNonce,
    inputSha256,
    runId,
    progress: {
      state: "PLANNER_FAILED",
      image_upstream_calls: 0,
      planner_upstream_calls_may_have_occurred: upstreamCalls > 0 ? 1 : 0,
    },
    cached,
    recoverableUntil,
    upstreamCalls,
    error: {
      code: "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS",
      details: {
        cause: causeText,
        image_upstream_calls: 0,
        retry_scope: "EDIT_VISUAL_INPUTS_THEN_RESTART",
      },
    },
  });
}

async function commitPlannerFailure(imageLedger, claim, input, cause, recoverableUntil) {
  const response = plannerFailureResponse({
    bootstrapNonce: input.bootstrap_nonce,
    inputSha256: input.input_sha256,
    runId: claim.runId,
    recoverableUntil,
    cause,
  });
  if (typeof imageLedger.markPlannerFailed !== "function") return markPlannerUnknown(imageLedger, claim, cause);
  try {
    const result = await imageLedger.markPlannerFailed({
      runId: claim.runId,
      appScopeId: claim.appScopeId,
      ownerToken: claim.ownerToken,
      fence: claim.fence,
      errorCode: response.error.code,
      response,
    });
    if (result?.status === "COMMITTED") return response;
  } catch {
    // Read back below before falling back to the conservative UNKNOWN state.
  }
  try {
    const state = await readD36RunState(imageLedger, claim.runId, claim.appScopeId);
    if (state.status === "PLANNER_FAILED" && state.cachedResponse) {
      return parseImageGenerationResponse({ ...state.cachedResponse, cached: true, upstream_calls: 0 });
    }
  } catch {
    // UNKNOWN remains the only safe result when the planner failure commit cannot be confirmed.
  }
  return markPlannerUnknown(imageLedger, claim, cause);
}

export async function generateImagesTransaction(input, settings, { imageLedger, nowMs = Date.now(), accessExpiresAtMs = 0, appScopeId = "" } = {}) {
  if (!input || !new Set(["START", "DISCOVER", "STEP"]).has(input.mode)) throw new TypeError("IMAGE_GENERATION_MODE_INVALID");
  if (settings.credentialMode !== "SERVER_MANAGED") throw new Error("IMAGE_TRANSACTION_SERVER_MANAGED_REQUIRED");
  if (!imageLedger) throw new Error("IMAGE_LEDGER_CONFIGURATION_REQUIRED");
  if (!appScopeId) throw new Error("IMAGE_LEDGER_APP_SCOPE_REQUIRED");

  if (input.mode === "DISCOVER") {
    const runId = d36RunId(appScopeId, input.bootstrap_nonce);
    const state = await imageLedger.discover({ runId, appScopeId, bootstrapNonce: input.bootstrap_nonce, inputSha256: input.input_sha256 });
    if (!state || state.status === "NOT_FOUND") {
      return d36Response({ status: "ERROR", bootstrapNonce: input.bootstrap_nonce, inputSha256: input.input_sha256, runId, progress: {}, error: { code: "IMAGE_LEDGER_RUN_MISSING" } });
    }
    if (state.status === "CONFLICT") throw imageTransactionStateError("CONFLICT", { run_id: runId });
    if (state.status === "PLANNER_FAILED") {
      if (state.cachedResponse) return parseImageGenerationResponse({ ...state.cachedResponse, cached: true, upstream_calls: 0 });
      return plannerFailureResponse({
        bootstrapNonce: input.bootstrap_nonce,
        inputSha256: input.input_sha256,
        runId,
        recoverableUntil: state.recoverableUntil,
        cause: state.plannerFailureCode || "LEGACY_PLANNER_UNKNOWN",
        cached: true,
        upstreamCalls: 0,
      });
    }
    if (state.cachedResponse && new Set(["READY", "PARTIAL", "COMPLETE"]).has(state.status)) {
      return parseImageGenerationResponse({
        ...state.cachedResponse,
        status: state.status === "READY" ? "READY_DISCOVERY" : state.cachedResponse.status,
        cached: true,
        upstream_calls: 0,
      });
    }
    return d36Response({
      status: new Set(["MATERIALIZING", "PLANNING", "IN_FLIGHT", "UNKNOWN"]).has(state.status) ? state.status : "UNKNOWN",
      bootstrapNonce: input.bootstrap_nonce,
      inputSha256: input.input_sha256,
      runId,
      checkpointPreimage: state.checkpointPreimage || null,
      logicalStepId: state.logicalStepId || "discover",
      progress: state.compactRun ? d36Progress(state.compactRun) : { state: state.status },
      assets: state.compactRun ? state.compactRun.assets.map((asset) => d36ManifestFromAsset(asset, runId)) : [],
      mediaDelta: [],
      cached: true,
      recoverableUntil: state.recoverableUntil,
      upstreamCalls: 0,
    });
  }

  if (!Number.isFinite(accessExpiresAtMs) || accessExpiresAtMs - nowMs < ACCESS_SESSION_PAID_MIN_REMAINING_MS) {
    throw imageTransactionStateError("EXPIRY_WINDOW_TOO_SHORT");
  }

  if (typeof imageLedger.assertProductionReady !== "function") throw new Error("IMAGE_LEDGER_READINESS_UNKNOWN");
  const readinessRunId = input.mode === "START" ? d36RunId(appScopeId, input.bootstrap_nonce) : input.run_id;
  const productionReadiness = await imageLedger.assertProductionReady({ appScopeId, nowMs, mode: input.mode, runId: readinessRunId });

  if (input.mode === "START") {
    const computedInputSha256 = sha256Bytes(Buffer.from(canonicalImageGenerationInputPreimage(input), "utf8"));
    if (computedInputSha256 !== input.input_sha256) throw new TypeError("IMAGE_GENERATION_INPUT_SHA_MISMATCH");
    const runId = d36RunId(appScopeId, input.bootstrap_nonce);
    const claim = await imageLedger.claimStart({
      runId,
      appScopeId,
      bootstrapNonce: input.bootstrap_nonce,
      inputSha256: input.input_sha256,
      snapshot: input.operation_snapshot,
      referenceManifest: input.reference_manifest,
      accessExpiresAtMs,
      readiness: productionReadiness,
      minRemainingMs: ACCESS_SESSION_PAID_MIN_REMAINING_MS,
      ttlMs: IMAGE_LEDGER_RUN_TTL_MS,
    });
    claim.runId = runId;
    if (claim.status === "EXPIRY_WINDOW_TOO_SHORT") throw imageTransactionStateError(claim.status, { run_id: runId });
    if (claim.status === "CONFLICT") throw new Error("BOOTSTRAP_INPUT_CONFLICT");
    if (new Set(["READY", "PARTIAL", "COMPLETE"]).has(claim.status)) {
      const recovered = await recoverD36CommittedResponse(imageLedger, runId, appScopeId);
      if (recovered) return recovered;
      throw imageTransactionStateError("UNKNOWN", { run_id: runId, reason: "READY_WITHOUT_CACHE" });
    }
    if (claim.status === "PLANNER_FAILED") {
      const state = await readD36RunState(imageLedger, runId, appScopeId);
      if (state.cachedResponse) return parseImageGenerationResponse({ ...state.cachedResponse, cached: true, upstream_calls: 0 });
      return plannerFailureResponse({
        bootstrapNonce: input.bootstrap_nonce,
        inputSha256: input.input_sha256,
        runId,
        recoverableUntil: state.recoverableUntil,
        cause: state.plannerFailureCode || "PLANNER_FAILED",
        cached: true,
        upstreamCalls: 0,
      });
    }
    if (new Set(["PLANNING", "IN_FLIGHT", "UNKNOWN"]).has(claim.status)) {
      return d36Response({ status: claim.status === "PLANNING" ? "PLANNING" : claim.status, bootstrapNonce: input.bootstrap_nonce, inputSha256: input.input_sha256, runId, progress: { state: claim.status }, cached: true, recoverableUntil: claim.recoverableUntil });
    }
    if (claim.status !== "MATERIALIZING") throw imageTransactionStateError(claim.status, { run_id: runId });

    await materializeD36References(input, imageLedger, runId, appScopeId);
    const plannerClaim = await imageLedger.claimPlanner({
      runId,
      appScopeId,
      ownerToken: randomUUID(),
      materializedManifestSha256: sha256Json(input.reference_manifest),
      accessExpiresAtMs,
      minRemainingMs: ACCESS_SESSION_PAID_MIN_REMAINING_MS,
      leaseMs: IMAGE_PLANNER_LEASE_MS,
    });
    if (plannerClaim.status === "EXPIRY_WINDOW_TOO_SHORT") throw imageTransactionStateError(plannerClaim.status, { run_id: runId });
    if (new Set(["READY", "PARTIAL", "COMPLETE"]).has(plannerClaim.status)) {
      const recovered = await recoverD36CommittedResponse(imageLedger, runId, appScopeId);
      if (recovered) return recovered;
      throw imageTransactionStateError("UNKNOWN", { run_id: runId, reason: "READY_WITHOUT_CACHE" });
    }
    if (new Set(["IN_FLIGHT", "UNKNOWN"]).has(plannerClaim.status)) {
      return d36Response({ status: plannerClaim.status, bootstrapNonce: input.bootstrap_nonce, inputSha256: input.input_sha256, runId, progress: { state: plannerClaim.status }, cached: true, recoverableUntil: claim.recoverableUntil });
    }
    if (plannerClaim.status !== "PLANNING") throw imageTransactionStateError(plannerClaim.status, { run_id: runId });
    const plannerOwner = { ...plannerClaim, runId, appScopeId };

    let compactRun;
    let response;
    try {
      const referenceDataUrls = await readAndVerifyD36ReferenceAssets(imageLedger, runId, appScopeId, input.reference_manifest);
      const legacyInput = d36LegacyInput(input.operation_snapshot, referenceDataUrls);
      const draftSha256 = sha256Bytes(Buffer.from(JSON.stringify(legacyInput.draft)));
      const referenceFingerprint = sha256Json({ references: input.reference_manifest, note: input.operation_snapshot.reference_note });
      const run = await createInitialPublicImageRun(legacyInput, settings, input.operation_snapshot.page_count, draftSha256, referenceFingerprint, { runId });
      compactRun = compactPublicImageRun(run);
      response = d36ResponseForCompactRun({ compactRun, bootstrapNonce: input.bootstrap_nonce, inputSha256: input.input_sha256, apiKey: settings.apiKey, recoverableUntil: claim.recoverableUntil, upstreamCalls: 1, status: "READY" });
    } catch (error) {
      return commitPlannerFailure(imageLedger, plannerOwner, input, error, claim.recoverableUntil);
    }
    const checkpoint = response.checkpoint_preimage;
    try {
      const committed = await imageLedger.commitPlanner({
        runId,
        appScopeId,
        ownerToken: plannerClaim.ownerToken,
        fence: plannerClaim.fence,
        compactRun,
        checkpointPreimage: checkpoint,
        checkpointPreimageSha256: response.checkpoint_preimage_sha256,
        logicalStepId: response.logical_step_id,
        response,
      });
      if (committed?.status !== "COMMITTED") throw imageTransactionStateError(committed?.status || "UNKNOWN", { run_id: runId });
    } catch (error) {
      const recovered = await recoverD36CommittedResponse(imageLedger, runId, appScopeId);
      if (recovered) return recovered;
      await markPlannerUnknown(imageLedger, plannerOwner, error);
    }
    return response;
  }

  if (sha256Json(input.checkpoint_preimage) !== input.checkpoint_preimage_sha256) throw new TypeError("IMAGE_CHECKPOINT_HASH_MISMATCH");
  const checkpoint = verifyD36CheckpointPreimage(input.checkpoint_preimage, settings.apiKey, { runId: input.run_id, checkpointSha256: input.checkpoint_preimage_sha256 });
  const state = await readD36RunState(imageLedger, input.run_id, appScopeId);
  let coveredNarrativePreparation = null;
  if (state.compactRun?.production_mode === "narrative") {
    const hydratedRun = await hydrateCompactPublicImageRun(state.compactRun, imageLedger, appScopeId);
    const advanced = completeCoveredNarrativePublicImageRun(hydratedRun);
    if (advanced) {
      const references = await readAndVerifyD36ReferenceAssets(imageLedger, input.run_id, appScopeId, state.referenceManifest || []);
      const legacyInput = d36LegacyInput(state.snapshot, references);
      const compactRun = compactPublicImageRun(advanced);
      const inlineContent = assemblePublicImageContent(advanced, legacyInput, settings);
      const allManifests = compactRun.assets.map((asset) => stripAssetUrl(d36ManifestFromAsset(asset, input.run_id)));
      const contentPackage = replaceInlineMediaWithRefs(inlineContent, allManifests);
      const response = d36ResponseForCompactRun({
        compactRun,
        bootstrapNonce: state.bootstrapNonce,
        inputSha256: state.inputSha256,
        apiKey: settings.apiKey,
        mediaDelta: [],
        recoverableUntil: state.recoverableUntil,
        upstreamCalls: 0,
        status: "COMPLETE",
        contentPackage,
      });
      coveredNarrativePreparation = { compactRun, response };
    }
  }
  const reservation = await imageLedger.reserveStep({
    runId: input.run_id,
    appScopeId,
    checkpointPreimageSha256: input.checkpoint_preimage_sha256,
    logicalStepId: input.logical_step_id,
    attemptNonce: input.attempt_nonce,
    ownerToken: randomUUID(),
    accessExpiresAtMs,
    nowMs,
    minRemainingMs: ACCESS_SESSION_PAID_MIN_REMAINING_MS,
    leaseMs: IMAGE_LEDGER_IN_FLIGHT_LEASE_MS,
    maxCalls: 6,
  });
  if (reservation?.status === "CACHED") {
    if (reservation.cacheKind === "LATE_RESULT") {
      return d36Response({
        status: "LATE_RESULT",
        bootstrapNonce: state.bootstrapNonce,
        inputSha256: state.inputSha256,
        runId: input.run_id,
        checkpointPreimage: input.checkpoint_preimage,
        logicalStepId: input.logical_step_id,
        progress: { state: "LATE_RESULT", recovery_only: true },
        assets: [],
        mediaDelta: [],
        cached: true,
        recoverableUntil: state.recoverableUntil,
        upstreamCalls: 0,
      });
    }
    return returnOrThrowD36Response({ ...reservation.cachedResponse, cached: true, upstream_calls: 0 });
  }
  if (reservation?.status !== "RESERVED") throw imageTransactionStateError(reservation?.status || "UNKNOWN", { run_id: input.run_id, logical_step_id: input.logical_step_id });
  const reservedStateConflict = !state.compactRun
    || state.checkpointPreimageSha256 !== input.checkpoint_preimage_sha256
    || state.logicalStepId !== input.logical_step_id
    || sha256Json(state.compactRun) !== checkpoint.run_state_sha256;
  if (reservedStateConflict) {
    try { await imageLedger.markStepUnknown({ runId: input.run_id, appScopeId, actionId: reservation.actionId, attemptNonce: input.attempt_nonce, ownerToken: reservation.ownerToken, fence: reservation.fence }); }
    catch { /* The paid lane remains fail closed. */ }
    throw imageTransactionStateError("CHECKPOINT_CONFLICT", { run_id: input.run_id, reason: "RESERVED_STATE_MISMATCH" });
  }

  let compactRun;
  let response;
  try {
    if (coveredNarrativePreparation) {
      ({ compactRun, response } = coveredNarrativePreparation);
    } else {
      const hydratedRun = await hydrateCompactPublicImageRun(state.compactRun, imageLedger, appScopeId);
      const references = await readAndVerifyD36ReferenceAssets(imageLedger, input.run_id, appScopeId, state.referenceManifest || []);
      const legacyInput = d36LegacyInput(state.snapshot, references);
      try {
        const advanced = await executePublicImageJob(hydratedRun, legacyInput, settings);
        const persisted = await persistD36GeneratedAssets(imageLedger, input.run_id, appScopeId, advanced, state.compactRun.assets || []);
        compactRun = persisted.compactRun;
        let contentPackage;
        if (advanced.status === "COMPLETE") {
          const inlineContent = assemblePublicImageContent(advanced, legacyInput, settings);
          const allManifests = compactRun.assets.map((asset) => stripAssetUrl(d36ManifestFromAsset(asset, input.run_id)));
          contentPackage = replaceInlineMediaWithRefs(inlineContent, allManifests);
        }
        response = d36ResponseForCompactRun({
          compactRun,
          bootstrapNonce: state.bootstrapNonce,
          inputSha256: state.inputSha256,
          apiKey: settings.apiKey,
          mediaDelta: persisted.mediaDelta,
          recoverableUntil: state.recoverableUntil,
          upstreamCalls: 1,
          status: advanced.status === "COMPLETE" ? "COMPLETE" : "PARTIAL",
          contentPackage,
        });
      } catch (error) {
        const failedRun = error?.details?.resume_checkpoint ? parsePublicImageRun(error.details.resume_checkpoint) : null;
        if (!failedRun) throw error;
        compactRun = compactPublicImageRun(failedRun);
        response = d36ResponseForCompactRun({
          compactRun,
          bootstrapNonce: state.bootstrapNonce,
          inputSha256: state.inputSha256,
          apiKey: settings.apiKey,
          recoverableUntil: state.recoverableUntil,
          upstreamCalls: 1,
          status: "ERROR",
          error: { code: "IMAGE_STEP_FAILED", details: { cause: String(error?.message || error).slice(0, 180) } },
        });
      }
    }
  } catch (error) {
    try { await imageLedger.markStepUnknown({ runId: input.run_id, appScopeId, actionId: reservation.actionId, attemptNonce: input.attempt_nonce, ownerToken: reservation.ownerToken, fence: reservation.fence }); }
    catch { /* UNKNOWN remains fail closed. */ }
    throw imageTransactionStateError("UNKNOWN", { run_id: input.run_id, cause: String(error?.message || error).slice(0, 180) });
  }

  try {
    const committed = await imageLedger.commitStep({
      runId: input.run_id,
      appScopeId,
      checkpointPreimageSha256: input.checkpoint_preimage_sha256,
      logicalStepId: input.logical_step_id,
      attemptNonce: input.attempt_nonce,
      actionId: reservation.actionId,
      ownerToken: reservation.ownerToken,
      fence: reservation.fence,
      compactRun,
      checkpointPreimage: response.checkpoint_preimage,
      nextCheckpointPreimageSha256: response.checkpoint_preimage_sha256,
      nextLogicalStepId: response.logical_step_id,
      response,
      status: response.status === "COMPLETE" ? "COMPLETE" : "PARTIAL",
      runStatus: response.status === "COMPLETE" ? "COMPLETE" : "PARTIAL",
    });
    if (committed?.status !== "COMMITTED") throw imageTransactionStateError(committed?.status || "UNKNOWN", { run_id: input.run_id });
  } catch (error) {
    const recovered = await recoverD36CommittedResponse(imageLedger, input.run_id, appScopeId);
    if (recovered) return returnOrThrowD36Response(recovered);
    let readback = null;
    try { readback = await imageLedger.markStepUnknown({ runId: input.run_id, appScopeId, actionId: reservation.actionId, attemptNonce: input.attempt_nonce, ownerToken: reservation.ownerToken, fence: reservation.fence }); }
    catch { /* UNKNOWN remains fail closed. */ }
    if (readback?.status === "COMMITTED" && readback.cachedResponse) return returnOrThrowD36Response({ ...readback.cachedResponse, cached: true, upstream_calls: 0 });
    throw imageTransactionStateError("UNKNOWN", { run_id: input.run_id, cause: String(error?.message || error).slice(0, 180) });
  }
  return returnOrThrowD36Response(response);
}

export async function generateImages(input, settings, options = {}) {
  const { imageLedger = null, nowMs = Date.now(), ledgerReady = false } = options;
  if (input?.mode) return generateImagesTransaction(input, settings, options);
  const serverManaged = settings.credentialMode === "SERVER_MANAGED";
  if (serverManaged && !imageLedger) throw new Error("IMAGE_LEDGER_CONFIGURATION_REQUIRED");
  if (serverManaged && !ledgerReady && typeof imageLedger.assertReady === "function") await imageLedger.assertReady();
  const pageCount = input.image_count === "AUTO" ? input.draft.recommended_image_count : input.image_count;
  const draftSha256 = sha256Bytes(Buffer.from(JSON.stringify(input.draft)));
  const referenceFingerprint = publicReferenceFingerprint(input);
  let checkpoint;
  if (input.resume_checkpoint) {
    checkpoint = verifyPublicImageCheckpoint(input.resume_checkpoint, settings.apiKey, { draftId: input.draft.draft_id, draftSha256, productionMode: input.production_mode, finalPageCount: pageCount, referenceFingerprint });
    if (input.resume_run_id !== checkpoint.run_id) throw new TypeError("PUBLIC_IMAGE_RESUME_ID_MISMATCH");
  } else {
    if (input.resume_run_id) throw new TypeError("PUBLIC_IMAGE_RESUME_CHECKPOINT_REQUIRED");
    checkpoint = await createInitialPublicImageRun(input, settings, pageCount, draftSha256, referenceFingerprint);
    const result = publicImageStepResponse(checkpoint, settings);
    if (serverManaged) {
      const identity = imageLedgerIdentity(result.resume.resume_checkpoint, settings.apiKey);
      if (identity.expiresAtMs <= nowMs) throw imageLedgerStateError("RUN_MISSING", identity, { reason: "RUN_EXPIRED" });
      const initialized = await imageLedger.init(identity);
      if (!new Set(["INITIALIZED", "EXISTING"]).has(initialized?.status)) throw imageLedgerStateError(initialized?.status || "UNKNOWN", identity);
    }
    return result;
  }
  if (!serverManaged) {
    if (checkpoint.status === "COMPLETE") return assemblePublicImageContent(checkpoint, input, settings);
    if (checkpoint.status === "EXHAUSTED") throw new Error(checkpoint.failure?.code || "PUBLIC_IMAGE_REPAIR_EXHAUSTED");
    if (checkpoint.actual_image_calls >= checkpoint.max_image_calls) throw publicImageBudgetError(checkpoint, settings);
    checkpoint = await executePublicImageJob(checkpoint, input, settings);
    if (checkpoint.status === "EXHAUSTED") {
      const signed = signPublicImageCheckpoint(checkpoint, settings.apiKey);
      const error = new Error(checkpoint.failure?.code || "PUBLIC_IMAGE_REPAIR_EXHAUSTED");
      error.details = { ...publicImageRunProgress(signed, IMAGE_PRICE_CNY), resume_checkpoint: signed, retry_scope: "CHANGE_VISUAL_INPUTS_THEN_RESTART", unresolved_unit_ids: checkpoint.failure?.unresolved_unit_ids || [] };
      throw error;
    }
    return checkpoint.status === "COMPLETE" ? assemblePublicImageContent(checkpoint, input, settings) : publicImageStepResponse(checkpoint, settings);
  }

  const identity = imageLedgerIdentity(input.resume_checkpoint, settings.apiKey);
  if (identity.expiresAtMs <= nowMs) throw imageLedgerStateError("RUN_MISSING", identity, { reason: "RUN_EXPIRED" });
  const reservation = await imageLedger.reserve(identity, { nowMs });
  if (reservation?.status === "CACHED") return cachedOutcome(reservation.cachedBody);
  if (reservation?.status === "BUDGET_EXHAUSTED") {
    if (checkpoint.status === "EXHAUSTED") {
      const error = new Error(checkpoint.failure?.code || "PUBLIC_IMAGE_REPAIR_EXHAUSTED");
      error.details = { ...publicImageRunProgress(input.resume_checkpoint, IMAGE_PRICE_CNY), resume_checkpoint: input.resume_checkpoint, retry_scope: "CHANGE_VISUAL_INPUTS_THEN_RESTART", unresolved_unit_ids: checkpoint.failure?.unresolved_unit_ids || [] };
      throw error;
    }
    if (checkpoint.actual_image_calls >= checkpoint.max_image_calls) throw publicImageBudgetError(checkpoint, settings);
    throw imageLedgerStateError("BUDGET_EXHAUSTED", identity, { reason: "COUNTER_CHECKPOINT_MISMATCH" });
  }
  if (reservation?.status === "COMPLETE" && checkpoint.status === "COMPLETE") return assemblePublicImageContent(checkpoint, input, settings);
  if (reservation?.status !== "RESERVED") throw imageLedgerStateError(reservation?.status || "UNKNOWN", identity);

  let result;
  let nextCheckpoint;
  let terminalStatus = "READY";
  try {
    checkpoint = await executePublicImageJob(checkpoint, input, settings);
    if (checkpoint.status === "EXHAUSTED") {
      nextCheckpoint = signPublicImageCheckpoint(checkpoint, settings.apiKey);
      terminalStatus = "EXHAUSTED";
      const error = new Error(checkpoint.failure?.code || "PUBLIC_IMAGE_REPAIR_EXHAUSTED");
      error.details = { ...publicImageRunProgress(nextCheckpoint, IMAGE_PRICE_CNY), resume_checkpoint: nextCheckpoint, retry_scope: "CHANGE_VISUAL_INPUTS_THEN_RESTART", unresolved_unit_ids: checkpoint.failure?.unresolved_unit_ids || [] };
      throw error;
    }
    if (checkpoint.status === "COMPLETE") {
      nextCheckpoint = signPublicImageCheckpoint(checkpoint, settings.apiKey);
      terminalStatus = "COMPLETE";
      result = assemblePublicImageContent(checkpoint, input, settings);
    } else {
      result = publicImageStepResponse(checkpoint, settings);
      nextCheckpoint = result.resume.resume_checkpoint;
    }
  } catch (error) {
    const resumableCheckpoint = nextCheckpoint || error?.details?.resume_checkpoint;
    if (!resumableCheckpoint) {
      await markImageLedgerUnknown(imageLedger, identity, error);
      throw error;
    }
    const nextIdentity = imageLedgerIdentity(resumableCheckpoint, settings.apiKey);
    await commitImageLedgerOutcome(imageLedger, identity, { outcome: imageLedgerErrorOutcome(error), nextIdentity, status: terminalStatus });
    throw error;
  }

  const nextIdentity = imageLedgerIdentity(nextCheckpoint, settings.apiKey);
  await commitImageLedgerOutcome(imageLedger, identity, { outcome: { kind: "SUCCESS", value: result }, nextIdentity, status: terminalStatus });
  return result;
}

async function generatePageCandidates(input, settings) {
  const candidates = await Promise.all([0, 1, 2].map(async (index) => {
    const prompt = buildArkPageCandidatePrompt(input, index);
    const payload = await arkPost("/images/generations", settings.apiKey, buildArkImageRequest({ model: settings.imageModel, prompt, referenceImageDataUrl: XIAOSHIMEI_AVATAR_DATA_URL }), "PAGE_CANDIDATE_IMAGE_CALL_FAILED");
    const image = await imagePayload(payload);
    return { src: image.dataUrl, sha256: image.sha256, size_bytes: image.bytes.length, width: image.info.width, height: image.info.height };
  }));
  return { schema: PAGE_CANDIDATE_RESPONSE_SCHEMA, run_id: `candidate-web-${Date.now()}-${randomUUID().slice(0, 8)}`, candidates };
}

function providerErrorStatus(code, error) {
  if (code.includes("API_KEY_REQUIRED")) return 401;
  if (new Set(["IMAGE_STEP_IN_FLIGHT", "IMAGE_STEP_UNKNOWN", "IMAGE_LEDGER_REPLAY_CONFLICT", "IMAGE_RUN_ALREADY_COMPLETE"]).has(code)) return 409;
  if (code.startsWith("IMAGE_LEDGER_") || code === "IMAGE_LEDGER_CONFIGURATION_REQUIRED") return 503;
  if (code.includes("INVALID") || error instanceof TypeError) return 400;
  return 422;
}

export function createProviderHandler(options = {}) {
  const env = options.env || process.env;
  const currentTime = () => typeof options.nowMs === "function" ? Number(options.nowMs()) : Number(options.nowMs ?? Date.now());
  const resolveImageLedger = async () => {
    const injected = typeof options.imageLedger === "function" ? await options.imageLedger() : options.imageLedger;
    return injected || createUpstashImageLedgerFromEnv(env, { fetchImpl: options.ledgerFetchImpl || globalThis.fetch });
  };

  return async function providerHandler(request, response) {
    const route = routeName(request);
    const nowMs = currentTime();
    if (request.method === "GET" && route === "health") return send(response, 200, publicProviderConfig(request, { env, nowMs }));
    if (request.method === "GET" && route === "config") return send(response, 200, publicProviderConfig(request, { env, nowMs }));
    const rawAssetMatch = request.method === "GET" ? /^assets\/([^/]+)\/([0-9a-f]{64})$/.exec(route) : null;
    if (rawAssetMatch) {
      const serverManaged = configuredServerManaged(env);
      const accessConfig = inspectServerAccessConfig(env);
      if (!serverManaged || !accessConfig.ready) return send(response, 503, { error: "ACCESS_CONFIGURATION_REQUIRED" });
      if (!requestHasExactSameOriginReadGate(request, accessConfig.appOrigin)) return send(response, 403, { error: "ORIGIN_FORBIDDEN" });
      const candidates = inspectAccessSessionCandidates(requestHeader(request, "cookie"), accessConfig, { nowMs });
      if (candidates.headerTooLarge || candidates.familyOverflow) return send(response, 431, { error: candidates.headerTooLarge ? "COOKIE_HEADER_TOO_LARGE" : "ACCESS_SESSION_CANDIDATE_LIMIT_EXCEEDED" });
      if (!candidates.authenticated) return send(response, 401, { error: "ACCESS_SESSION_REQUIRED" });
      const imageLedger = await resolveImageLedger().catch(() => null);
      if (!imageLedger || typeof imageLedger.readAsset !== "function") return send(response, 503, { error: "IMAGE_LEDGER_CONFIGURATION_REQUIRED" });
      let asset;
      try {
        asset = await imageLedger.readAsset({ runId: rawAssetMatch[1], sha256: rawAssetMatch[2], appScopeId: accessConfig.appScope });
      } catch {
        return send(response, 503, { error: "IMAGE_LEDGER_UNAVAILABLE" });
      }
      if (asset?.status !== "FOUND") {
        const status = asset?.status === "FORBIDDEN" ? 403 : asset?.status === "CORRUPT" ? 409 : 404;
        return send(response, status, { error: `IMAGE_ASSET_${String(asset?.status || "MISSING")}` });
      }
      const bytes = Buffer.from(asset.bytes);
      if (sha256Bytes(bytes) !== rawAssetMatch[2] || bytes.length !== asset.manifest?.size_bytes || asset.manifest?.mime !== "image/jpeg") {
        return send(response, 409, { error: "IMAGE_ASSET_CORRUPT" });
      }
      response.status(200)
        .setHeader("content-type", "image/jpeg")
        .setHeader("content-length", String(bytes.length))
        .setHeader(IMAGE_ASSET_SHA256_HEADER, rawAssetMatch[2])
        .setHeader("cache-control", "private, no-store, max-age=0")
        .setHeader("x-content-type-options", "nosniff");
      if (typeof response.send === "function") return response.send(bytes);
      return response.end(bytes);
    }
    if (request.method !== "POST") return send(response, 405, { error: "METHOD_NOT_ALLOWED" });

    const serverManaged = configuredServerManaged(env);
    const accessConfig = inspectServerAccessConfig(env);
    if (route === "access-session") {
      if (!serverManaged || !accessConfig.appOrigin) return send(response, 503, { error: "ACCESS_CONFIGURATION_REQUIRED" });
      if (!requestHasExactSameOriginWriteGate(request, accessConfig.appOrigin)) return send(response, 403, { error: "ORIGIN_FORBIDDEN" });
      if (!accessConfig.ready) return send(response, 503, { error: "ACCESS_CONFIGURATION_REQUIRED" });
      const visibleCandidates = inspectAccessSessionCandidates(requestHeader(request, "cookie"), accessConfig, { nowMs, allowFamilyOverflow: true });
      if (visibleCandidates.headerTooLarge) return send(response, 431, { error: "COOKIE_HEADER_TOO_LARGE" });
      let code;
      try { code = boundedAccessCode(request.body); }
      catch { return send(response, 400, { error: "ACCESS_CODE_INVALID" }); }
      if (!accessCodeMatches(code, accessConfig)) return send(response, 401, { error: "ACCESS_DENIED" });
      const sessionOptions = { nowMs };
      if (typeof options.sessionId === "function") sessionOptions.sessionId = options.sessionId();
      else if (options.sessionId != null) sessionOptions.sessionId = options.sessionId;
      const session = mintAccessSession(accessConfig, sessionOptions);
      const staleNames = [...new Set(visibleCandidates.familyPairs.map((pair) => pair.name))]
        .filter((name) => name !== session.cookieName)
        .sort()
        .slice(0, ACCESS_SESSION_MAX_PAIRS);
      response.setHeader("set-cookie", [...staleNames.map(deleteAccessSessionCookie), accessSessionCookie(session)]);
      return send(response, 200, { authenticated: true, credential_mode: "SERVER_MANAGED", expires_at: session.expiresAt.toISOString() });
    }

    let imageLedger = null;
    let accessCandidates = null;
    if (serverManaged) {
      if (!accessConfig.appOrigin) return send(response, 503, { error: "ACCESS_CONFIGURATION_REQUIRED" });
      if (!requestHasExactSameOriginWriteGate(request, accessConfig.appOrigin)) return send(response, 403, { error: "ORIGIN_FORBIDDEN" });
      if (!accessConfig.ready) return send(response, 503, { error: "ACCESS_CONFIGURATION_REQUIRED" });
      accessCandidates = inspectAccessSessionCandidates(requestHeader(request, "cookie"), accessConfig, { nowMs });
      if (accessCandidates.headerTooLarge || accessCandidates.familyOverflow) return send(response, 431, {
        error: accessCandidates.headerTooLarge ? "COOKIE_HEADER_TOO_LARGE" : "ACCESS_SESSION_CANDIDATE_LIMIT_EXCEEDED",
      });
      if (!accessCandidates.authenticated) return send(response, 401, { error: "ACCESS_SESSION_REQUIRED" });
      if (!SERVER_MANAGED_PROVIDER_ROUTES.has(route)) return send(response, 404, { error: "ROUTE_NOT_FOUND" });
      if (route === "page-candidates") return send(response, 403, { error: "SERVER_MANAGED_PAGE_CANDIDATES_DISABLED" });
    }

    try {
      const settings = requestConfig(request, env);
      if (route === "text-draft") return send(response, 200, await generateTextDraft(parseTextDraftRequest(request.body), settings));
      if (route === "generate-images") {
        // The paid-image lane must reject an invalid body before it touches the
        // distributed ledger. Auth and same-origin admission have already run,
        // so neither anonymous traffic nor malformed authenticated traffic can
        // consume readiness/calibration capacity.
        const parsedInput = parseImageGenerationRequest(request.body);
        if (serverManaged) {
          imageLedger = await resolveImageLedger().catch(() => null);
          if (!imageLedger) return send(response, 503, { error: "IMAGE_LEDGER_CONFIGURATION_REQUIRED" });
        }
        return send(response, 200, await generateImages(parsedInput, settings, {
          imageLedger,
          nowMs,
          accessExpiresAtMs: accessCandidates?.capabilityExpiresAtMs || 0,
          appScopeId: accessConfig.appScope || "",
        }));
      }
      if (route === "page-candidates") return send(response, 200, await generatePageCandidates(parsePageCandidateRequest(request.body), settings));
      return send(response, 404, { error: "ROUTE_NOT_FOUND" });
    } catch (error) {
      const code = String(error?.message || error || "PROVIDER_FAILED").slice(0, 360);
      return send(response, providerErrorStatus(code, error), { error: "ARK_PROBE_FAILED", code, stage: route === "text-draft" ? "text" : "image", ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}) });
    }
  };
}

const handler = createProviderHandler();
export default handler;
