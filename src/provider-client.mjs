import { buildGenerationRequest, buildImageGenerationRequest, buildPageCandidateRequest, buildTextDraftRequest, IMAGE_MEDIA_MANIFEST_SCHEMA, IMAGE_RESPONSE_ASSET_MAX_BYTES, parseImageGenerationResponse, parsePageCandidateResponse, parseTextDraftResponse } from "./provider-contract.mjs";
import { detectImageMime, sha256MediaBytes } from "./media-asset-store.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CLOUD_SETTINGS_KEY = "xiaoshimei-studio.byok-provider.v1";
const CLOUD_KEY = "xiaoshimei-studio.byok-api-key.v1";
const CLOUD_VERIFIED_KEY = "xiaoshimei-studio.byok-verified.v1";
const CLOUD_DEFAULTS = Object.freeze({
  provider: "volcengine-ark",
  provider_label: "火山方舟",
  base_url: "https://ark.cn-beijing.volces.com/api/v3",
  text_model: "doubao-seed-2-0-lite-260428",
  image_model: "doubao-seedream-5-0-lite-260128",
  key_store: "当前标签页 sessionStorage",
});

function mediaTransportError(code, details = null) {
  const error = new TypeError(code);
  error.providerCode = code;
  error.providerStage = "image";
  error.providerDetails = details == null ? null : structuredClone(details);
  return error;
}

function exactHeader(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  if (!headers || typeof headers !== "object") return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : null;
}

function verifiedDeltaManifest(value, index, expectedRunId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw mediaTransportError(`IMAGE_MEDIA_DELTA_${index + 1}_INVALID`);
  const expectedFields = ["schema", "media_ref", "sha256", "size_bytes", "mime", "name", "width", "height", "asset_url"].sort();
  const actualFields = Object.keys(value).sort();
  if (actualFields.length !== expectedFields.length || actualFields.some((key, fieldIndex) => key !== expectedFields[fieldIndex])) {
    throw mediaTransportError(`IMAGE_MEDIA_DELTA_${index + 1}_FIELDS_INVALID`);
  }
  if (value.schema !== IMAGE_MEDIA_MANIFEST_SCHEMA || !/^[0-9a-f]{64}$/.test(value.sha256 || "")) throw mediaTransportError(`IMAGE_MEDIA_DELTA_${index + 1}_INVALID`);
  if (value.media_ref !== `xiaoshimei-media://sha256/${value.sha256}`) throw mediaTransportError(`IMAGE_MEDIA_DELTA_${index + 1}_REF_INVALID`);
  if (value.mime !== "image/jpeg" || !Number.isInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > IMAGE_RESPONSE_ASSET_MAX_BYTES) {
    throw mediaTransportError(`IMAGE_MEDIA_DELTA_${index + 1}_MANIFEST_INVALID`);
  }
  const route = /^\/api\/provider\/assets\/([A-Za-z0-9._:-]{1,160})\/([0-9a-f]{64})$/.exec(value.asset_url || "");
  if (!route || route[2] !== value.sha256 || (expectedRunId != null && route[1] !== expectedRunId)) throw mediaTransportError(`IMAGE_MEDIA_DELTA_${index + 1}_ASSET_URL_INVALID`);
  return { manifest: structuredClone(value), runId: route[1] };
}

export async function fetchVerifiedImageMediaDelta(mediaDelta, {
  baseUrl,
  fetchImpl = globalThis.fetch,
  credentials = "same-origin",
  cryptoApi = globalThis.crypto,
  timeoutMs = 300000,
} = {}) {
  if (!Array.isArray(mediaDelta) || mediaDelta.length > 8) throw mediaTransportError("IMAGE_MEDIA_DELTA_INVALID");
  if (!mediaDelta.length) return [];
  if (typeof fetchImpl !== "function") throw mediaTransportError("IMAGE_MEDIA_FETCH_UNAVAILABLE");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw mediaTransportError("IMAGE_MEDIA_TIMEOUT_INVALID");
  let origin;
  try {
    const base = new URL(baseUrl);
    if (!new Set(["http:", "https:"]).has(base.protocol)) throw new TypeError("unsupported protocol");
    origin = base.origin;
  }
  catch { throw mediaTransportError("IMAGE_MEDIA_BASE_URL_INVALID"); }
  const materialized = [];
  let expectedRunId = null;
  for (let index = 0; index < mediaDelta.length; index += 1) {
    const verified = verifiedDeltaManifest(mediaDelta[index], index, expectedRunId);
    expectedRunId = verified.runId;
    const asset = verified.manifest;
    const assetUrl = new URL(asset.asset_url, origin);
    if (assetUrl.origin !== origin) throw mediaTransportError(`IMAGE_MEDIA_DELTA_${index + 1}_ASSET_URL_INVALID`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(assetUrl, { method: "GET", cache: "no-store", redirect: "error", credentials, signal: controller.signal });
      } catch (error) {
        throw mediaTransportError("IMAGE_MEDIA_FETCH_FAILED", { index, cause: String(error?.message || error) });
      }
      if (!response?.ok) {
        const error = mediaTransportError(`IMAGE_MEDIA_FETCH_HTTP_${response?.status || "UNKNOWN"}`, { index });
        error.httpStatus = response?.status || null;
        error.requiresAccess = response?.status === 401;
        throw error;
      }
      if (String(exactHeader(response.headers, "content-type") || "").toLowerCase() !== asset.mime) throw mediaTransportError("IMAGE_MEDIA_HEADER_MIME_MISMATCH", { index });
      if (exactHeader(response.headers, "content-length") !== String(asset.size_bytes)) throw mediaTransportError("IMAGE_MEDIA_HEADER_SIZE_MISMATCH", { index });
      if (exactHeader(response.headers, "x-content-sha256") !== asset.sha256) throw mediaTransportError("IMAGE_MEDIA_HEADER_HASH_MISMATCH", { index });
      const cacheControl = String(exactHeader(response.headers, "cache-control") || "").toLowerCase();
      if (!cacheControl.split(",").map((item) => item.trim()).includes("private") || !cacheControl.includes("no-store")) throw mediaTransportError("IMAGE_MEDIA_HEADER_CACHE_INVALID", { index });
      if (String(exactHeader(response.headers, "x-content-type-options") || "").toLowerCase() !== "nosniff") throw mediaTransportError("IMAGE_MEDIA_HEADER_NOSNIFF_REQUIRED", { index });
      let bytes;
      try { bytes = new Uint8Array(await response.arrayBuffer()); }
      catch (error) { throw mediaTransportError("IMAGE_MEDIA_BODY_READ_FAILED", { index, cause: String(error?.message || error) }); }
      if (bytes.byteLength !== asset.size_bytes) throw mediaTransportError("IMAGE_MEDIA_BODY_SIZE_MISMATCH", { index });
      let detectedMime;
      try { detectedMime = detectImageMime(bytes); }
      catch { throw mediaTransportError("IMAGE_MEDIA_BODY_MIME_MISMATCH", { index }); }
      if (detectedMime !== asset.mime) throw mediaTransportError("IMAGE_MEDIA_BODY_MIME_MISMATCH", { index });
      const actualSha256 = await sha256MediaBytes(bytes, { cryptoApi });
      if (actualSha256 !== asset.sha256) throw mediaTransportError("IMAGE_MEDIA_BODY_HASH_MISMATCH", { index });
      const { asset_url: _transportLocator, ...persistentManifest } = asset;
      materialized.push({ ...persistentManifest, bytes });
    } finally {
      clearTimeout(timer);
    }
  }
  return materialized;
}

export function createLocalHttpProvider({ endpoint, fetchImpl = globalThis.fetch, timeoutMs = 300000 } = {}) {
  let url;
  try { url = new URL(endpoint, globalThis.location?.origin); }
  catch { throw new TypeError("provider endpoint must be a valid URL"); }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new TypeError("provider endpoint must use HTTP or HTTPS");
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (!isLoopback && (url.protocol !== "https:" || url.origin !== globalThis.location?.origin || !url.pathname.startsWith("/api/provider/"))) throw new TypeError("provider endpoint must use loopback HTTP or the same HTTPS origin");
  if (typeof fetchImpl !== "function") throw new TypeError("provider fetch implementation is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new TypeError("provider timeout is invalid");

  let publicServerSettings = null;
  const publicProviderMetadata = (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return Object.fromEntries(["provider", "provider_label", "base_url", "text_model", "image_model", "configured", "credential_mode", "key_store"]
      .filter((key) => Object.prototype.hasOwnProperty.call(payload, key))
      .map((key) => [key, structuredClone(payload[key])]));
  };
  const cloudSettings = () => {
    if (isLoopback) return null;
    let stored = {};
    try { stored = JSON.parse(globalThis.sessionStorage?.getItem(CLOUD_SETTINGS_KEY) || "{}"); } catch { stored = {}; }
    const apiKey = globalThis.sessionStorage?.getItem(CLOUD_KEY) || "";
    const serverManaged = publicServerSettings?.credential_mode === "SERVER_MANAGED" && publicServerSettings?.configured === true;
    if (serverManaged) return { ...CLOUD_DEFAULTS, ...stored, ...publicServerSettings, configured: true, credential_mode: "SERVER_MANAGED" };
    return { ...CLOUD_DEFAULTS, ...publicServerSettings, ...stored, configured: apiKey.trim().length >= 8, credential_mode: "BROWSER_BYOK", key_store: "当前标签页 sessionStorage" };
  };

  const settingsSignature = (settings) => [settings?.provider, settings?.base_url, settings?.text_model, settings?.image_model, settings?.credential_mode].join("|");
  const cloudVerification = (settings) => {
    if (!settings?.configured) return null;
    try {
      const value = JSON.parse(globalThis.sessionStorage?.getItem(CLOUD_VERIFIED_KEY) || "null");
      return value?.signature === settingsSignature(settings) && value?.verified_at ? value : null;
    } catch { return null; }
  };
  const markCloudVerified = (settings) => {
    if (!settings?.configured) return;
    globalThis.sessionStorage?.setItem(CLOUD_VERIFIED_KEY, JSON.stringify({ signature: settingsSignature(settings), verified_at: new Date().toISOString() }));
  };

  const credentialOptions = isLoopback ? {} : { credentials: "same-origin" };
  const providerFailure = (response, payload) => {
    const providerCode = String(payload?.code || payload?.error || `HTTP_${response?.status || "UNKNOWN"}`);
    const error = new Error(`provider request failed: ${providerCode}`);
    error.providerCode = providerCode;
    error.providerStage = typeof payload?.stage === "string" ? payload.stage : null;
    error.failureId = typeof payload?.failure_id === "string" ? payload.failure_id : null;
    error.httpStatus = response?.status || null;
    error.requiresAccess = response?.status === 401 && !isLoopback
      && (new Set(["ACCESS_DENIED", "ACCESS_SESSION_REQUIRED"]).has(providerCode) || cloudSettings()?.credential_mode === "SERVER_MANAGED");
    error.providerDetails = payload?.details && typeof payload.details === "object" ? structuredClone(payload.details) : null;
    return error;
  };
  const progressRequestsStop = (value) => value === "STOP" || value === false || value?.action === "STOP";
  const progressConfirmsCheckpoint = (value) => value?.action === "STOP" && value?.checkpointPersisted === true;
  const stoppedAfterCheckpoint = (resume) => {
    const error = new Error("IMAGE_RUN_STOPPED_AFTER_CHECKPOINT");
    error.providerCode = "IMAGE_RUN_STOPPED_AFTER_CHECKPOINT";
    error.providerStage = "image";
    error.providerDetails = structuredClone(resume);
    error.checkpointPersisted = true;
    error.intentionalStop = true;
    return error;
  };
  const stoppedWithoutCheckpoint = (decision, resume) => {
    const providerCode = String(decision?.code || "IMAGE_CHECKPOINT_NOT_PERSISTED");
    const error = new Error(providerCode);
    error.providerCode = providerCode;
    error.providerStage = "image";
    error.providerDetails = {
      ...structuredClone(resume),
      local_checkpoint: decision && typeof decision === "object" ? structuredClone(decision) : null,
    };
    error.checkpointPersisted = false;
    error.intentionalStop = false;
    return error;
  };

  const post = async (target, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const settings = cloudSettings();
      const apiKey = settings ? globalThis.sessionStorage?.getItem(CLOUD_KEY) || "" : "";
      const browserByok = settings && settings.credential_mode !== "SERVER_MANAGED";
      const response = await fetchImpl(target, { method: "POST", headers: { "content-type": "application/json", ...(browserByok ? { authorization: `Bearer ${apiKey}`, "x-xiaoshimei-text-model": settings.text_model, "x-xiaoshimei-image-model": settings.image_model } : {}) }, body: JSON.stringify(body), signal: controller.signal, ...credentialOptions });
      const payload = await response.json();
      if (!response?.ok) throw providerFailure(response, payload);
      if (settings) markCloudVerified(settings);
      return payload;
    } finally { clearTimeout(timer); }
  };
  const candidateUrl = new URL(url);
  candidateUrl.pathname = candidateUrl.pathname.replace(/\/generate\/?$/, "/page-candidates");
  const textDraftUrl = new URL(url);
  textDraftUrl.pathname = textDraftUrl.pathname.replace(/\/generate\/?$/, "/text-draft");
  const imageGenerationUrl = new URL(url);
  imageGenerationUrl.pathname = imageGenerationUrl.pathname.replace(/\/generate\/?$/, "/generate-images");
  const healthUrl = new URL(url);
  healthUrl.pathname = isLoopback ? "/health" : url.pathname.replace(/\/generate\/?$/, "/health");
  const configUrl = new URL(url);
  configUrl.pathname = isLoopback ? "/config" : url.pathname.replace(/\/generate\/?$/, "/config");
  const accessSessionUrl = new URL(url);
  accessSessionUrl.pathname = isLoopback ? "/access-session" : url.pathname.replace(/\/generate\/?$/, "/access-session");

  const authenticateAccess = async (code, { generation = null } = {}) => {
    if (isLoopback) throw new TypeError("本机生成服务不使用公网访问会话");
    if (typeof code !== "string" || code.length < 1 || code.length > 256) throw new TypeError("请输入有效访问码");
    let loginPayload = null;
    let ambiguity = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(accessSessionUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (new Set([401, 403, 503]).has(response?.status)) {
          let explicitPayload = null;
          try { explicitPayload = await response.json(); } catch { explicitPayload = null; }
          throw providerFailure(response, explicitPayload);
        }
        if (!response?.ok) {
          let explicitPayload = null;
          try { explicitPayload = await response.json(); } catch { explicitPayload = null; }
          throw providerFailure(response, explicitPayload);
        }
        try { loginPayload = await response.json(); }
        catch { ambiguity = "BODY_AMBIGUOUS"; }
      } finally { clearTimeout(timer); }
    } catch (error) {
      if (error?.httpStatus != null) throw error;
      ambiguity = "TRANSPORT_AMBIGUOUS";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(configUrl, { method: "GET", cache: "no-store", signal: controller.signal, credentials: "same-origin" });
      let configPayload = null;
      try { configPayload = await response.json(); }
      catch { throw new TypeError("ACCESS_SESSION_CONFIG_RESPONSE_INVALID"); }
      if (!response?.ok) throw providerFailure(response, configPayload);
      if (!configPayload || typeof configPayload !== "object" || Array.isArray(configPayload)) throw new TypeError("ACCESS_SESSION_CONFIG_RESPONSE_INVALID");
      return {
        generation,
        outcome: ambiguity == null ? "CONFIG_RECONCILED" : "CONFIG_RECONCILED_AMBIGUOUS",
        ambiguity,
        login: loginPayload && typeof loginPayload === "object" && !Array.isArray(loginPayload) ? structuredClone(loginPayload) : null,
        config: structuredClone(configPayload),
      };
    } finally { clearTimeout(timer); }
  };

  return {
    id: `${isLoopback ? "local-http" : "same-origin-byok"}:${url.host}`,
    async checkHealth() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetchImpl(healthUrl, { method: "GET", signal: controller.signal, cache: "no-store", ...credentialOptions });
        const payload = await response.json();
        if (!response?.ok) throw new Error(`provider health failed: HTTP_${response?.status || "UNKNOWN"}`);
        if (isLoopback) return payload;
        publicServerSettings = publicProviderMetadata(payload);
        const settings = cloudSettings();
        const verified = cloudVerification(settings);
        if (settings.credential_mode === "SERVER_MANAGED") {
          return { ...settings, ...structuredClone(payload), last_success_at: payload?.last_success_at || verified?.verified_at || null };
        }
        return {
          ...payload,
          ...settings,
          status: verified ? "LIVE_VERIFIED" : settings.configured ? "CONFIGURED_UNVERIFIED" : payload.status,
          last_success_at: verified?.verified_at || null,
        };
      } finally { clearTimeout(timer); }
    },
    async getSettings() {
      const response = await fetchImpl(configUrl, { method: "GET", cache: "no-store", ...credentialOptions });
      const payload = await response.json();
      if (!response?.ok) throw new Error(`provider config failed: HTTP_${response?.status || "UNKNOWN"}`);
      if (isLoopback) return payload;
      publicServerSettings = publicProviderMetadata(payload);
      return { ...cloudSettings(), ...structuredClone(payload) };
    },
    async updateSettings(input) {
      if (!isLoopback) {
        if (cloudSettings()?.credential_mode === "SERVER_MANAGED") return cloudSettings();
        if (input?.provider !== "volcengine-ark") throw new TypeError("公网体验当前只开放火山方舟");
        const textModel = String(input?.text_model || "").trim();
        const imageModel = String(input?.image_model || "").trim();
        if (!/^[A-Za-z0-9_.:-]{3,120}$/.test(textModel) || !/^[A-Za-z0-9_.:-]{3,120}$/.test(imageModel)) throw new TypeError("请填写有效的文字与图片模型 ID");
        const next = { ...CLOUD_DEFAULTS, provider_label: String(input?.label || "火山方舟").trim().slice(0, 40) || "火山方舟", text_model: textModel, image_model: imageModel };
        const previous = cloudSettings();
        globalThis.sessionStorage?.setItem(CLOUD_SETTINGS_KEY, JSON.stringify(next));
        const key = String(input?.api_key || "").trim();
        if (key) globalThis.sessionStorage?.setItem(CLOUD_KEY, key);
        if (key || settingsSignature(previous) !== settingsSignature(next)) globalThis.sessionStorage?.removeItem(CLOUD_VERIFIED_KEY);
        return cloudSettings();
      }
      return post(configUrl, input);
    },
    async generate(input) {
      return post(url, buildGenerationRequest(input));
    },
    authenticateAccess,
    loginAccess: authenticateAccess,
    async generateTextDraft(input) {
      return parseTextDraftResponse(await post(textDraftUrl, buildTextDraftRequest(input)));
    },
    async generateImages(input, onProgress) {
      let next = structuredClone(input);
      for (let step = 0; step < 64; step += 1) {
        const payload = parseImageGenerationResponse(await post(imageGenerationUrl, buildImageGenerationRequest(next)));
        if (!new Set(["READY", "READY_DISCOVERY", "PARTIAL", "COMPLETE"]).has(payload.status)) return payload;
        const decision = typeof onProgress === "function" ? await onProgress(structuredClone(payload)) : null;
        if (progressRequestsStop(decision)) {
          if (progressConfirmsCheckpoint(decision)) throw stoppedAfterCheckpoint(payload);
          throw stoppedWithoutCheckpoint(decision, payload);
        }
        if (payload.status === "COMPLETE") return payload;
        const nextRequest = decision?.request || decision?.next_request || null;
        if (!nextRequest) return payload;
        next = structuredClone(nextRequest);
      }
      throw new Error("PUBLIC_IMAGE_STEP_LIMIT_EXCEEDED");
    },
    async fetchImageMediaDelta(mediaDelta) {
      return fetchVerifiedImageMediaDelta(mediaDelta, { baseUrl: url.origin, fetchImpl, credentials: isLoopback ? "omit" : "same-origin", timeoutMs });
    },
    async generatePageCandidates(input) {
      if (!isLoopback && cloudSettings()?.credential_mode === "SERVER_MANAGED") throw new Error("SERVER_MANAGED_PAGE_CANDIDATES_DISABLED");
      return parsePageCandidateResponse(await post(candidateUrl, buildPageCandidateRequest(input)));
    },
  };
}
