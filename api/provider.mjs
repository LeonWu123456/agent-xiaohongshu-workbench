import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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
  PAGE_CANDIDATE_RESPONSE_SCHEMA,
  TEXT_DRAFT_RESPONSE_SCHEMA,
  parseImageGenerationRequest,
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
export const ACCESS_SESSION_COOKIE = "__Host-xiaoshimei_session";
export const ACCESS_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const IMAGE_LEDGER_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const IMAGE_LEDGER_IN_FLIGHT_LEASE_MS = 360_000;
const SERVER_MANAGED_PROVIDER_ROUTES = new Set(["text-draft", "generate-images", "page-candidates"]);
const IMAGE_LEDGER_MAX_CACHE_BYTES = PUBLIC_GENERATION_RESPONSE_MAX_BYTES + 64_000;

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

export function inspectServerAccessConfig(env = process.env) {
  const accessCodeSha256 = String(env?.XIAOSHIMEI_ACCESS_CODE_SHA256 || "").trim().toLowerCase();
  const sessionSecret = String(env?.XIAOSHIMEI_SESSION_SECRET || "").trim();
  const appOrigin = configuredOrigin(env?.XIAOSHIMEI_APP_ORIGIN);
  const ready = /^[0-9a-f]{64}$/.test(accessCodeSha256) && sessionSecret.length >= 32 && Boolean(appOrigin);
  return { ready, accessCodeSha256, sessionSecret, appOrigin };
}

function imageLedgerEnv(env = process.env) {
  const url = String(env?.UPSTASH_REDIS_REST_URL || env?.KV_REST_API_URL || "").trim().replace(/\/$/, "");
  const token = String(env?.UPSTASH_REDIS_REST_TOKEN || env?.KV_REST_API_TOKEN || "").trim();
  let validUrl = false;
  try { validUrl = new URL(url).protocol === "https:"; } catch { validUrl = false; }
  return { url, token, ready: validUrl && token.length >= 16 };
}

function requestHeader(request, name) {
  const value = request?.headers?.[name] ?? request?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? "" : String(value || "");
}

function requestHasExactOrigin(request, expectedOrigin) {
  return Boolean(expectedOrigin) && requestHeader(request, "origin") === expectedOrigin;
}

function cookieValue(request, name) {
  const header = requestHeader(request, "cookie");
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function safeEqual(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.length === right.length && timingSafeEqual(left, right);
}

export function mintAccessSession(configValue, { nowMs = Date.now(), sessionId = randomUUID() } = {}) {
  if (!configValue?.ready) throw new TypeError("ACCESS_CONFIGURATION_REQUIRED");
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, sid: String(sessionId), iat: issuedAt, exp: issuedAt + ACCESS_SESSION_TTL_SECONDS })).toString("base64url");
  const signature = createHmac("sha256", configValue.sessionSecret).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt: new Date((issuedAt + ACCESS_SESSION_TTL_SECONDS) * 1000) };
}

export function verifyAccessSession(token, configValue, { nowMs = Date.now() } = {}) {
  if (!configValue?.ready || typeof token !== "string" || token.length > 1024) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  let actualSignature;
  let payload;
  try {
    actualSignature = Buffer.from(parts[1], "base64url");
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const expectedSignature = createHmac("sha256", configValue.sessionSecret).update(parts[0]).digest();
  if (!safeEqual(actualSignature, expectedSignature)) return false;
  const now = Math.floor(nowMs / 1000);
  return payload?.v === 1
    && typeof payload.sid === "string" && payload.sid.length >= 8 && payload.sid.length <= 160
    && Number.isInteger(payload.iat) && Number.isInteger(payload.exp)
    && payload.iat <= now + 60 && payload.exp > now && payload.exp - payload.iat === ACCESS_SESSION_TTL_SECONDS;
}

function requestHasValidAccessSession(request, accessConfig, nowMs = Date.now()) {
  return verifyAccessSession(cookieValue(request, ACCESS_SESSION_COOKIE), accessConfig, { nowMs });
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

function accessSessionCookie(token, expiresAt) {
  return `${ACCESS_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ACCESS_SESSION_TTL_SECONDS}; Expires=${expiresAt.toUTCString()}`;
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
  const authenticated = configured && access.ready && requestHasValidAccessSession(request, access, nowMs);
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
    const cleaned = cleanupGeneratedGridArtifacts({ data: new Uint8Array(rawTile.data), width: rawTile.info.width, height: rawTile.info.height, channels: rawTile.info.channels }, { kv: regionRole === "kv-2x2-3:4" });
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
  const baseTile = await sharp(bytes).flatten({ background: "#ffffff" }).extract(crop).png().toBuffer();
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

function imageLedgerKeys(runId, attemptIndex = null) {
  const normalized = String(runId || "");
  if (!/^images-[0-9TZ-]+-[0-9a-f]{8}$/.test(normalized)) throw new TypeError("IMAGE_LEDGER_RUN_ID_INVALID");
  const root = `xiaoshimei:image-run:{${normalized}}`;
  return { run: `${root}:meta`, attempt: attemptIndex == null ? null : `${root}:attempt:${Number(attemptIndex)}` };
}

function ledgerReplyStatus(value) {
  const result = Array.isArray(value) ? value : [value];
  return { status: String(result[0] || "IMAGE_LEDGER_INVALID_REPLY"), value: result[1] == null ? null : result[1] };
}

export function createUpstashImageLedger({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) {
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
  };
}

export function createUpstashImageLedgerFromEnv(env = process.env, options = {}) {
  const value = imageLedgerEnv(env);
  return value.ready ? createUpstashImageLedger({ url: value.url, token: value.token, ...options }) : null;
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

async function createInitialPublicImageRun(input, settings, pageCount, draftSha256, referenceFingerprint) {
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
      })), { pillar: input.draft.pillar, publishBody: input.draft.body });
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
    runId: `images-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
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

export async function generateImages(input, settings, { imageLedger = null, nowMs = Date.now(), ledgerReady = false } = {}) {
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
    if (request.method !== "POST") return send(response, 405, { error: "METHOD_NOT_ALLOWED" });

    const serverManaged = configuredServerManaged(env);
    const accessConfig = inspectServerAccessConfig(env);
    if (route === "access-session") {
      if (!serverManaged || !accessConfig.appOrigin) return send(response, 503, { error: "ACCESS_CONFIGURATION_REQUIRED" });
      if (!requestHasExactOrigin(request, accessConfig.appOrigin)) return send(response, 403, { error: "ORIGIN_FORBIDDEN" });
      if (!accessConfig.ready) return send(response, 503, { error: "ACCESS_CONFIGURATION_REQUIRED" });
      let code;
      try { code = boundedAccessCode(request.body); }
      catch { return send(response, 400, { error: "ACCESS_CODE_INVALID" }); }
      if (!accessCodeMatches(code, accessConfig)) return send(response, 401, { error: "ACCESS_DENIED" });
      const sessionOptions = { nowMs };
      if (typeof options.sessionId === "function") sessionOptions.sessionId = options.sessionId();
      else if (options.sessionId != null) sessionOptions.sessionId = options.sessionId;
      const session = mintAccessSession(accessConfig, sessionOptions);
      response.setHeader("set-cookie", accessSessionCookie(session.token, session.expiresAt));
      return send(response, 200, { authenticated: true, credential_mode: "SERVER_MANAGED", expires_at: session.expiresAt.toISOString() });
    }

    let imageLedger = null;
    if (serverManaged) {
      if (!accessConfig.appOrigin) return send(response, 503, { error: "ACCESS_CONFIGURATION_REQUIRED" });
      if (!requestHasExactOrigin(request, accessConfig.appOrigin)) return send(response, 403, { error: "ORIGIN_FORBIDDEN" });
      if (!accessConfig.ready) return send(response, 503, { error: "ACCESS_CONFIGURATION_REQUIRED" });
      if (!requestHasValidAccessSession(request, accessConfig, nowMs)) return send(response, 401, { error: "ACCESS_SESSION_REQUIRED" });
      if (!SERVER_MANAGED_PROVIDER_ROUTES.has(route)) return send(response, 404, { error: "ROUTE_NOT_FOUND" });
      if (route === "page-candidates") return send(response, 403, { error: "SERVER_MANAGED_PAGE_CANDIDATES_DISABLED" });
      if (route === "generate-images") {
        imageLedger = await resolveImageLedger().catch(() => null);
        if (!imageLedger) return send(response, 503, { error: "IMAGE_LEDGER_CONFIGURATION_REQUIRED" });
        try {
          if (typeof imageLedger.assertReady === "function") await imageLedger.assertReady();
        } catch {
          return send(response, 503, { error: "IMAGE_LEDGER_UNAVAILABLE" });
        }
      }
    }

    try {
      const settings = requestConfig(request, env);
      if (route === "text-draft") return send(response, 200, await generateTextDraft(parseTextDraftRequest(request.body), settings));
      if (route === "generate-images") return send(response, 200, await generateImages(parseImageGenerationRequest(request.body), settings, { imageLedger, nowMs, ledgerReady: true }));
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
