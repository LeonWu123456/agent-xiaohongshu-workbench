#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERCEL_DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
export const DELIVERY_TARGET = "https://xiaoshimei-full-workbench.vercel.app/";
export const DEFAULT_ALTERNATE_ENTRY_URL = "https://xiaoshimei-full-workbench-892350620-5733s-projects.vercel.app/";
const ALTERNATE_ENTRY_HOST_SUFFIX = "-892350620-5733s-projects.vercel.app";
export const JOURNEY_SCHEMA = "xiaoshimei.consumer-journey-readback.v1";
export const REQUIRED_JOURNEY_STEPS = ["open", "access", "edit", "save", "reopen", "copy", "download"];
const MAX_OPERATOR_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

class DeliveryError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
    this.detail = detail;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(code, detail) {
  throw new DeliveryError(code, detail);
}

function ipv4IsPrivate(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 192 && b === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function isProxySyntheticAddress(address) {
  const parts = String(address || "").split(".").map(Number);
  return parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

export function isPublicAddress(address) {
  const normalized = String(address || "").trim().toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return !ipv4IsPrivate(normalized);
  if (version !== 6) return false;
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
  const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
  return true;
}

export function classifyTargetUrl(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return { kind: "BLOCKED", errors: [{ code: "TARGET_URL_INVALID", detail: String(rawUrl || "") }] };
  }
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const localName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
  const literalPrivate = isIP(host) > 0 && !isPublicAddress(host);
  if (localName || literalPrivate) {
    return { kind: "LOCAL_ONLY", url: target.href, errors: [{ code: "TARGET_NOT_SHAREABLE", detail: `host=${host}` }] };
  }
  const errors = [];
  if (target.protocol !== "https:") errors.push({ code: "HTTPS_REQUIRED", detail: target.protocol });
  if (target.port && target.port !== "443") errors.push({ code: "DEFAULT_HTTPS_PORT_REQUIRED", detail: target.port });
  if (target.username || target.password) errors.push({ code: "URL_CREDENTIALS_FORBIDDEN", detail: host });
  return { kind: errors.length ? "BLOCKED" : "PUBLIC_HTTPS", url: target.href, errors };
}

export async function resolvePublicTarget(targetUrl, lookupImpl = lookup) {
  const target = new URL(targetUrl);
  let rows;
  try {
    rows = await lookupImpl(target.hostname, { all: true, verbatim: true });
  } catch (error) {
    fail("DNS_LOOKUP_FAILED", String(error?.message || error));
  }
  if (!Array.isArray(rows) || rows.length === 0) fail("DNS_EMPTY", target.hostname);
  const addresses = rows.map((row) => String(row?.address || ""));
  const rejected = addresses.filter((address) => !isPublicAddress(address));
  const trustedStableProxyResolution = target.href === DELIVERY_TARGET
    && rejected.length === addresses.length
    && rejected.every(isProxySyntheticAddress);
  if (rejected.length && !trustedStableProxyResolution) fail("DNS_PRIVATE_ADDRESS", rejected.join(","));
  return addresses;
}

function git(candidateRoot, ...args) {
  const result = spawnSync("git", ["-C", candidateRoot, ...args], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) fail("CANDIDATE_GIT_READ_FAILED", String(result.stderr || result.stdout).trim().slice(0, 320));
  return result.stdout.trim();
}

export async function inspectCandidate(candidateRoot, expectedCommit) {
  const root = path.resolve(candidateRoot);
  if (!SHA40.test(expectedCommit)) fail("EXPECTED_COMMIT_INVALID", expectedCommit);
  const top = path.resolve(git(root, "rev-parse", "--show-toplevel"));
  if (top !== root) fail("CANDIDATE_ROOT_MISMATCH", `expected=${root};actual=${top}`);
  const head = git(root, "rev-parse", "HEAD");
  if (head !== expectedCommit) fail("CANDIDATE_COMMIT_MISMATCH", `expected=${expectedCommit};actual=${head}`);
  const dirty = git(root, "status", "--porcelain=v1", "--untracked-files=all");
  if (dirty) fail("CANDIDATE_WORKTREE_DIRTY", dirty.split("\n")[0]);
  return { root, head, worktree: "CLEAN" };
}

export function collectEntrypointAssetPaths(html) {
  const paths = new Set();
  for (const match of String(html).matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
    let pathname;
    try {
      pathname = new URL(match[1], "https://artifact.invalid/").pathname;
    } catch {
      continue;
    }
    if (pathname.startsWith("/assets/")) paths.add(pathname);
  }
  return [...paths].sort();
}

export async function readLocalArtifact(candidateRoot) {
  const distRoot = path.join(candidateRoot, "dist");
  const htmlBytes = await readFile(path.join(distRoot, "index.html"));
  const html = htmlBytes.toString("utf8");
  const assetPaths = collectEntrypointAssetPaths(html);
  if (assetPaths.length === 0) fail("LOCAL_ENTRY_ASSETS_MISSING", "dist/index.html");
  const assets = {};
  for (const assetPath of assetPaths) {
    const bytes = await readFile(path.join(distRoot, assetPath.replace(/^\//, "")));
    assets[assetPath] = { sha256: sha256(bytes), size_bytes: bytes.length };
  }
  return { html_sha256: sha256(htmlBytes), html_size_bytes: htmlBytes.length, assets };
}

async function fetchBytes(url, fetchImpl, allowedOrigin) {
  let current = url;
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
        headers: { "user-agent": "xiaoshimei-shareable-delivery-verifier/1" },
      });
    } catch (error) {
      fail("TARGET_FETCH_FAILED", `${current}:${String(error?.message || error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.("location");
      if (!location) fail("TARGET_REDIRECT_LOCATION_MISSING", `${current}:${response.status}`);
      const next = new URL(location, current).href;
      const classified = classifyTargetUrl(next);
      if (classified.kind !== "PUBLIC_HTTPS") fail("TARGET_REDIRECT_NOT_PUBLIC", next);
      if (new URL(next).origin !== allowedOrigin) fail("TARGET_ORIGIN_REDIRECTED", next);
      current = next;
      continue;
    }
    if (!response.ok) fail("TARGET_HTTP_FAILED", `${current}:${response.status}`);
    const finalUrl = classifyTargetUrl(response.url || current);
    if (finalUrl.kind !== "PUBLIC_HTTPS") fail("TARGET_REDIRECT_NOT_PUBLIC", response.url || current);
    if (new URL(finalUrl.url).origin !== allowedOrigin) fail("TARGET_ORIGIN_REDIRECTED", finalUrl.url);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, final_url: finalUrl.url };
  }
  fail("TARGET_REDIRECT_LIMIT", url);
}

export async function readRemoteArtifact(targetUrl, fetchImpl = fetch) {
  const expectedOrigin = new URL(targetUrl).origin;
  const htmlResult = await fetchBytes(targetUrl, fetchImpl, expectedOrigin);
  const html = htmlResult.bytes.toString("utf8");
  const assetPaths = collectEntrypointAssetPaths(html);
  if (assetPaths.length === 0) fail("REMOTE_ENTRY_ASSETS_MISSING", htmlResult.final_url);
  const assets = {};
  for (const assetPath of assetPaths) {
    const assetUrl = new URL(assetPath, htmlResult.final_url).href;
    const result = await fetchBytes(assetUrl, fetchImpl, expectedOrigin);
    assets[assetPath] = { sha256: sha256(result.bytes), size_bytes: result.bytes.length };
  }
  return { html_sha256: sha256(htmlResult.bytes), html_size_bytes: htmlResult.bytes.length, assets };
}

export function validateProviderReadiness(health, { expectedCommit = "" } = {}) {
  if (!health || typeof health !== "object" || Array.isArray(health)) {
    return [{ code: "PROVIDER_HEALTH_INVALID", detail: String(health || "") }];
  }
  const checks = [
    [health.configured === true, "PROVIDER_SERVER_KEY_MISSING", `configured=${String(health.configured)}`],
    [health.credential_mode === "SERVER_MANAGED", "PROVIDER_CREDENTIAL_MODE_INVALID", String(health.credential_mode || "")],
    [health.key_store === "Vercel Sensitive Environment Variable", "PROVIDER_KEY_STORE_INVALID", String(health.key_store || "")],
    [health.access_required === true, "PROVIDER_ACCESS_NOT_REQUIRED", `access_required=${String(health.access_required)}`],
    [health.access_configured === true, "PROVIDER_ACCESS_NOT_CONFIGURED", `access_configured=${String(health.access_configured)}`],
    [health.authentication_mode === "STUDIO_ACCESS_SESSION", "PROVIDER_AUTHENTICATION_MODE_INVALID", String(health.authentication_mode || "")],
    [health.authenticated === false, "PROVIDER_PUBLIC_PROBE_ALREADY_AUTHENTICATED", `authenticated=${String(health.authenticated)}`],
    [health.status === "ACCESS_SESSION_REQUIRED", "PROVIDER_PUBLIC_STATUS_INVALID", String(health.status || "")],
    [health.image_ledger_configured === true, "PROVIDER_IMAGE_LEDGER_NOT_CONFIGURED", `image_ledger_configured=${String(health.image_ledger_configured)}`],
    [health.image_ledger_attested === true, "PROVIDER_IMAGE_LEDGER_NOT_ATTESTED", `image_ledger_attested=${String(health.image_ledger_attested)} status=${String(health.image_ledger_attestation_status || "")}`],
    [!expectedCommit || health.image_ledger_attestation_candidate_commit === expectedCommit, "PROVIDER_IMAGE_LEDGER_CANDIDATE_MISMATCH", `expected=${expectedCommit};actual=${String(health.image_ledger_attestation_candidate_commit || "")}`],
  ];
  return checks.filter(([passed]) => !passed).map(([, code, detail]) => ({ code, detail }));
}

export async function readProviderReadiness(targetUrl, fetchImpl = fetch) {
  const expectedOrigin = new URL(targetUrl).origin;
  const healthUrl = new URL("/api/provider/health", `${expectedOrigin}/`).href;
  let response;
  try {
    response = await fetchImpl(healthUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: {
        accept: "application/json",
        "user-agent": "xiaoshimei-shareable-delivery-verifier/1",
      },
    });
  } catch (error) {
    fail("PROVIDER_HEALTH_FETCH_FAILED", String(error?.message || error));
  }
  if (response.status >= 300 && response.status < 400) {
    fail("PROVIDER_HEALTH_REDIRECTED", `${healthUrl}:${response.status}`);
  }
  if (!response.ok) fail("PROVIDER_HEALTH_HTTP_FAILED", `${healthUrl}:${response.status}`);
  const finalUrl = response.url || healthUrl;
  if (new URL(finalUrl).origin !== expectedOrigin) fail("PROVIDER_HEALTH_ORIGIN_MISMATCH", finalUrl);
  let health;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 64_000) fail("PROVIDER_HEALTH_TOO_LARGE", String(Buffer.byteLength(text, "utf8")));
    health = JSON.parse(text);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    fail("PROVIDER_HEALTH_JSON_INVALID", String(error?.message || error));
  }
  return health;
}

export async function inspectAlternateEntry(alternateUrl, { canonicalUrl = DELIVERY_TARGET, fetchImpl = fetch } = {}) {
  const classified = classifyTargetUrl(alternateUrl);
  if (classified.kind !== "PUBLIC_HTTPS") {
    fail("ALTERNATE_ENTRY_NOT_PUBLIC_HTTPS", String(classified.url || alternateUrl || ""));
  }
  const canonical = new URL(canonicalUrl);
  const alternate = new URL(classified.url);
  if (alternate.origin === canonical.origin) fail("ALTERNATE_ENTRY_IS_CANONICAL", alternate.href);
  if (!alternate.hostname.endsWith(ALTERNATE_ENTRY_HOST_SUFFIX)) fail("ALTERNATE_ENTRY_HOST_UNTRUSTED", alternate.hostname);

  let response;
  try {
    response = await fetchImpl(alternate.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: { "user-agent": "xiaoshimei-shareable-delivery-verifier/1" },
    });
  } catch (error) {
    fail("ALTERNATE_ENTRY_FETCH_FAILED", `${alternate.href}:${String(error?.message || error)}`);
  }

  if ([401, 403, 404, 410].includes(response.status)) {
    return { url: alternate.href, status: response.status, state: "NOT_A_PUBLIC_ENTRY" };
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers?.get?.("location");
    if (!location) fail("ALTERNATE_ENTRY_REDIRECT_LOCATION_MISSING", `${alternate.href}:${response.status}`);
    const destination = new URL(location, alternate.href);
    if (destination.origin === canonical.origin) {
      return { url: alternate.href, status: response.status, state: "REDIRECTS_TO_CANONICAL", destination: destination.href };
    }
    if (destination.protocol === "https:" && destination.hostname === "vercel.com" && destination.pathname === "/sso-api") {
      let protectedOrigin = "";
      try {
        protectedOrigin = new URL(destination.searchParams.get("url") || "").origin;
      } catch {
        protectedOrigin = "";
      }
      if (protectedOrigin === alternate.origin) {
        return { url: alternate.href, status: response.status, state: "PROTECTED_BY_VERCEL" };
      }
    }
    fail("ALTERNATE_ENTRY_REDIRECT_UNSAFE", `${alternate.href}->${destination.href}`);
  }
  if (response.ok) fail("ALTERNATE_PUBLIC_ENTRY_ACTIVE", `${alternate.href}:${response.status}`);
  fail("ALTERNATE_ENTRY_STATE_UNVERIFIED", `${alternate.href}:${response.status}`);
}

export function compareArtifacts(localArtifact, remoteArtifact) {
  const errors = [];
  if (localArtifact?.html_sha256 !== remoteArtifact?.html_sha256) {
    errors.push({ code: "HTML_ARTIFACT_MISMATCH", detail: `local=${localArtifact?.html_sha256};remote=${remoteArtifact?.html_sha256}` });
  }
  const localAssets = localArtifact?.assets || {};
  const remoteAssets = remoteArtifact?.assets || {};
  const paths = [...new Set([...Object.keys(localAssets), ...Object.keys(remoteAssets)])].sort();
  for (const assetPath of paths) {
    const local = localAssets[assetPath];
    const remote = remoteAssets[assetPath];
    if (!local || !remote || local.sha256 !== remote.sha256 || local.size_bytes !== remote.size_bytes) {
      errors.push({ code: "ENTRY_ASSET_MISMATCH", detail: assetPath });
    }
  }
  return errors;
}

export function validateJourneyReceipt(receipt, { targetUrl, expectedCommit, nowMs = Date.now() }) {
  const errors = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { errors: [{ code: "JOURNEY_RECEIPT_REQUIRED", detail: JOURNEY_SCHEMA }] };
  }
  if (receipt.schema !== JOURNEY_SCHEMA) errors.push({ code: "JOURNEY_SCHEMA_INVALID", detail: String(receipt.schema || "") });
  let receiptUrl = "";
  try {
    receiptUrl = new URL(receipt.target_url).href;
  } catch {
    errors.push({ code: "JOURNEY_TARGET_INVALID", detail: String(receipt.target_url || "") });
  }
  if (receiptUrl && receiptUrl !== new URL(targetUrl).href) errors.push({ code: "JOURNEY_TARGET_MISMATCH", detail: receiptUrl });
  if (receipt.source_commit !== expectedCommit) errors.push({ code: "JOURNEY_COMMIT_MISMATCH", detail: String(receipt.source_commit || "") });
  const observedAt = Date.parse(receipt.observed_at);
  if (!Number.isFinite(observedAt)) errors.push({ code: "JOURNEY_TIME_INVALID", detail: String(receipt.observed_at || "") });
  else if (observedAt > nowMs + MAX_CLOCK_SKEW_MS) errors.push({ code: "JOURNEY_TIME_IN_FUTURE", detail: receipt.observed_at });
  else if (nowMs - observedAt > MAX_OPERATOR_RECEIPT_AGE_MS) errors.push({ code: "JOURNEY_RECEIPT_STALE", detail: receipt.observed_at });
  const role = receipt.actor?.role;
  if (role === "xiaoshimei") errors.push({ code: "CONSUMER_SELF_ASSERTION_UNVERIFIED", detail: "direct consumer readback is required outside this tool" });
  else if (role !== "operator") errors.push({ code: "JOURNEY_ACTOR_INVALID", detail: String(role || "") });
  if (typeof receipt.actor?.identity !== "string" || !receipt.actor.identity.trim()) errors.push({ code: "JOURNEY_ACTOR_IDENTITY_MISSING", detail: String(role || "") });
  for (const step of REQUIRED_JOURNEY_STEPS) {
    if (receipt.steps?.[step] !== true) errors.push({ code: "JOURNEY_STEP_NOT_PASS", detail: step });
  }
  if (receipt.fresh_user?.new_draft !== true) errors.push({ code: "FRESH_USER_NEW_DRAFT_NOT_PASS", detail: String(receipt.fresh_user?.new_draft) });
  if (receipt.fresh_user?.generate_text !== true) errors.push({ code: "FRESH_USER_TEXT_GENERATION_NOT_PASS", detail: String(receipt.fresh_user?.generate_text) });
  if (typeof receipt.fresh_user?.text_draft_id !== "string" || !receipt.fresh_user.text_draft_id.trim()) {
    errors.push({ code: "FRESH_USER_TEXT_DRAFT_ID_MISSING", detail: String(receipt.fresh_user?.text_draft_id || "") });
  }
  if (!Number.isInteger(receipt.fresh_user?.body_length) || receipt.fresh_user.body_length < 1) {
    errors.push({ code: "FRESH_USER_TEXT_BODY_EMPTY", detail: String(receipt.fresh_user?.body_length) });
  }
  if (!Number.isInteger(receipt.fresh_user?.tag_count) || receipt.fresh_user.tag_count < 1) {
    errors.push({ code: "FRESH_USER_TAGS_EMPTY", detail: String(receipt.fresh_user?.tag_count) });
  }
  if (receipt.fresh_user?.image_calls !== 0) {
    errors.push({ code: "FRESH_USER_IMAGE_CALLS_NOT_ZERO", detail: String(receipt.fresh_user?.image_calls) });
  }
  const productionDeploymentId = receipt.deployment?.production_deployment_id;
  const rollbackDeploymentId = receipt.deployment?.rollback_deployment_id;
  if (!VERCEL_DEPLOYMENT_ID.test(String(productionDeploymentId || ""))) {
    errors.push({ code: "PRODUCTION_DEPLOYMENT_ID_INVALID", detail: String(productionDeploymentId || "") });
  }
  if (!VERCEL_DEPLOYMENT_ID.test(String(rollbackDeploymentId || ""))) {
    errors.push({ code: "ROLLBACK_DEPLOYMENT_ID_INVALID", detail: String(rollbackDeploymentId || "") });
  } else if (rollbackDeploymentId === productionDeploymentId) {
    errors.push({ code: "ROLLBACK_DEPLOYMENT_NOT_DISTINCT", detail: String(rollbackDeploymentId) });
  }
  const rollback = receipt.rollback_verification;
  if (rollback?.deployment_id !== rollbackDeploymentId) {
    errors.push({ code: "ROLLBACK_VERIFICATION_ID_MISMATCH", detail: String(rollback?.deployment_id || "") });
  }
  if (!SHA40.test(String(rollback?.source_commit || ""))) {
    errors.push({ code: "ROLLBACK_SOURCE_COMMIT_INVALID", detail: String(rollback?.source_commit || "") });
  }
  if (rollback?.ready_state !== "READY") {
    errors.push({ code: "ROLLBACK_NOT_READY", detail: String(rollback?.ready_state || "") });
  }
  if (rollback?.action !== "promote_existing_deployment") {
    errors.push({ code: "ROLLBACK_ACTION_NOT_EXECUTABLE", detail: String(rollback?.action || "") });
  }
  if (typeof rollback?.evidence_ref !== "string" || !/^Evidence\/[A-Za-z0-9._-]+\.json$/.test(rollback.evidence_ref)) {
    errors.push({ code: "ROLLBACK_EVIDENCE_REF_INVALID", detail: String(rollback?.evidence_ref || "") });
  }
  if (!SHA256.test(String(rollback?.evidence_sha256 || ""))) {
    errors.push({ code: "ROLLBACK_EVIDENCE_HASH_INVALID", detail: String(rollback?.evidence_sha256 || "") });
  }
  const rollbackObservedAt = Date.parse(rollback?.verified_at);
  if (!Number.isFinite(rollbackObservedAt)) {
    errors.push({ code: "ROLLBACK_VERIFICATION_TIME_INVALID", detail: String(rollback?.verified_at || "") });
  } else if (rollbackObservedAt > observedAt + MAX_CLOCK_SKEW_MS) {
    errors.push({ code: "ROLLBACK_VERIFICATION_AFTER_JOURNEY", detail: String(rollback.verified_at) });
  }
  const rollbackProvider = rollback?.provider_readiness;
  for (const [passed, code, detail] of [
    [rollbackProvider?.configured === true, "ROLLBACK_PROVIDER_KEY_MISSING", `configured=${String(rollbackProvider?.configured)}`],
    [rollbackProvider?.access_required === true, "ROLLBACK_ACCESS_NOT_REQUIRED", `access_required=${String(rollbackProvider?.access_required)}`],
    [rollbackProvider?.credential_mode === "SERVER_MANAGED", "ROLLBACK_CREDENTIAL_MODE_INVALID", String(rollbackProvider?.credential_mode || "")],
    [rollbackProvider?.image_ledger_configured === true, "ROLLBACK_IMAGE_LEDGER_NOT_CONFIGURED", `image_ledger_configured=${String(rollbackProvider?.image_ledger_configured)}`],
    [rollbackProvider?.image_ledger_attested === true, "ROLLBACK_IMAGE_LEDGER_NOT_ATTESTED", `image_ledger_attested=${String(rollbackProvider?.image_ledger_attested)} status=${String(rollbackProvider?.image_ledger_attestation_status || "")}`],
  ]) {
    if (!passed) errors.push({ code, detail });
  }
  const ids = [receipt.same_draft?.initial_draft_id, receipt.same_draft?.saved_draft_id, receipt.same_draft?.reopened_draft_id, receipt.same_draft?.export_source_draft_id];
  if (ids.some((value) => typeof value !== "string" || !value.trim()) || new Set(ids).size !== 1) {
    errors.push({ code: "JOURNEY_DRAFT_IDENTITY_MISMATCH", detail: ids.map((value) => String(value || "")).join(",") });
  }
  return { errors, actor_role: role };
}

export async function evaluateDelivery(input, dependencies = {}) {
  const target = classifyTargetUrl(input.targetUrl);
  const base = {
    schema: "xiaoshimei.shareable-delivery-verdict.v1",
    checked_at: new Date().toISOString(),
    target_url: target.url || String(input.targetUrl || ""),
    expected_commit: input.expectedCommit,
    authority_granted: false,
  };
  if (target.kind === "LOCAL_ONLY") return { ...base, verdict: "LOCAL_ONLY", errors: target.errors };
  if (target.kind !== "PUBLIC_HTTPS") return { ...base, verdict: "BLOCKED", errors: target.errors };
  if (target.url !== DELIVERY_TARGET) {
    return { ...base, verdict: "BLOCKED", errors: [{ code: "STABLE_TARGET_REQUIRED", detail: DELIVERY_TARGET }] };
  }

  const errors = [];
  const capture = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      errors.push({ code: error?.code || "VERIFICATION_FAILED", detail: String(error?.detail || error?.message || error) });
      return undefined;
    }
  };
  const providedAlternateUrls = Array.isArray(input.alternateUrls) ? input.alternateUrls.filter(Boolean) : [];
  const exactDeploymentUrls = providedAlternateUrls.filter((value) => {
    try {
      return new URL(value).href !== DEFAULT_ALTERNATE_ENTRY_URL;
    } catch {
      return true;
    }
  });
  if (exactDeploymentUrls.length === 0) {
    errors.push({ code: "ALTERNATE_ENTRY_CENSUS_REQUIRED", detail: "pass the exact promoted deployment URL with --alternate-url" });
  }
  const alternateUrls = [...new Set([DEFAULT_ALTERNATE_ENTRY_URL, ...providedAlternateUrls].map((value) => String(value)))];
  const alternateEntries = [];
  for (const alternateUrl of alternateUrls) {
    const entry = await capture(() => (dependencies.inspectAlternateEntry || inspectAlternateEntry)(alternateUrl, { canonicalUrl: target.url }));
    if (entry) alternateEntries.push(entry);
  }
  const candidate = await capture(() => (dependencies.inspectCandidate || inspectCandidate)(input.candidateRoot, input.expectedCommit));
  const dnsAddresses = await capture(() => (dependencies.resolvePublicTarget || resolvePublicTarget)(target.url)) || [];
  const localArtifact = await capture(() => (dependencies.readLocalArtifact || readLocalArtifact)(input.candidateRoot));
  const remoteArtifact = dnsAddresses.length
    ? await capture(() => (dependencies.readRemoteArtifact || readRemoteArtifact)(target.url))
    : undefined;
  if (localArtifact && remoteArtifact) errors.push(...compareArtifacts(localArtifact, remoteArtifact));
  const providerHealth = dnsAddresses.length
    ? await capture(() => (dependencies.readProviderReadiness || readProviderReadiness)(target.url))
    : undefined;
  if (providerHealth) errors.push(...validateProviderReadiness(providerHealth, { expectedCommit: input.expectedCommit }));
  const journey = validateJourneyReceipt(input.receipt, { targetUrl: target.url, expectedCommit: input.expectedCommit });
  errors.push(...journey.errors);
  if (errors.length) {
    return { ...base, verdict: "BLOCKED", errors, checks: { candidate, dns_addresses: dnsAddresses, alternate_entries: alternateEntries, local_artifact: localArtifact, remote_artifact: remoteArtifact, provider_health: providerHealth } };
  }
  return {
    ...base,
    verdict: "HANDOFF_READY",
    errors: [],
    checks: { candidate, dns_addresses: dnsAddresses, alternate_entries: alternateEntries, artifact_identity: localArtifact, provider_health: providerHealth },
    consumer: {
      operator_actor_role: journey.actor_role,
      same_draft_id: input.receipt.same_draft.initial_draft_id,
      final_state: "REQUIRES_DIRECT_XIAOSHIMEI_READBACK",
    },
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--") || !argv[index + 1]) fail("ARGUMENT_INVALID", flag);
    const key = flag.slice(2);
    if (key === "alternate-url") {
      values[key] ||= [];
      values[key].push(argv[index + 1]);
    } else {
      values[key] = argv[index + 1];
    }
    index += 1;
  }
  for (const key of ["url", "expected-commit"]) {
    if (!values[key]) fail("ARGUMENT_REQUIRED", `--${key}`);
  }
  return values;
}

export async function runCli(argv = process.argv.slice(2)) {
  let result;
  try {
    const args = parseArgs(argv);
    let receipt;
    if (args.receipt) receipt = JSON.parse(await readFile(path.resolve(args.receipt), "utf8"));
    result = await evaluateDelivery({
      targetUrl: args.url,
      expectedCommit: args["expected-commit"],
      candidateRoot: path.resolve(args["candidate-root"] || process.cwd()),
      alternateUrls: args["alternate-url"] || [],
      receipt,
    });
  } catch (error) {
    result = {
      schema: "xiaoshimei.shareable-delivery-verdict.v1",
      checked_at: new Date().toISOString(),
      verdict: "BLOCKED",
      authority_granted: false,
      errors: [{ code: error?.code || "VERIFICATION_FAILED", detail: String(error?.detail || error?.message || error) }],
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.verdict === "HANDOFF_READY" ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runCli();
}
