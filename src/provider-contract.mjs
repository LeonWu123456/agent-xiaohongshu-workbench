import { normalizePromptContext } from "./prompt-context.mjs";
import { normalizeStyleLock, normalizeXhsContentType, normalizeXhsPageRole } from "./content-strategy.mjs";
import { normalizeProductionMode } from "./production-mode.mjs";

export const GENERATION_REQUEST_SCHEMA = "xiaoshimei.generation-request.v1";
export const PAGE_CANDIDATE_REQUEST_SCHEMA = "xiaoshimei.page-candidate-request.v1";
export const PAGE_CANDIDATE_RESPONSE_SCHEMA = "xiaoshimei.page-candidate-response.v1";
export const TEXT_DRAFT_REQUEST_SCHEMA = "xiaoshimei.text-draft-request.v1";
export const TEXT_DRAFT_RESPONSE_SCHEMA = "xiaoshimei.text-draft-response.v1";
export const IMAGE_GENERATION_REQUEST_SCHEMA = "xiaoshimei.image-generation-request.v1";
export const IMAGE_OPERATION_SNAPSHOT_SCHEMA = "xiaoshimei.image-operation-snapshot.v1";
export const IMAGE_MEDIA_MANIFEST_SCHEMA = "xiaoshimei.media-asset-manifest.v1";
export const IMAGE_GENERATION_RESPONSE_SCHEMA = "xiaoshimei.image-generation-response.v1";

export const IMAGE_REFERENCE_ASSET_MAX_BYTES = 900_000;
export const IMAGE_REFERENCE_TOTAL_MAX_BYTES = 2_700_000;
export const IMAGE_GENERATION_REQUEST_MAX_BYTES = 3_500_000;
export const IMAGE_RESPONSE_ASSET_MAX_BYTES = 4_000_000;

const IMAGE_OPERATION_SNAPSHOT_MAX_BYTES = 256_000;
const IMAGE_CHECKPOINT_MAX_BYTES = 256_000;
const IMAGE_CONTENT_PACKAGE_MAX_BYTES = 750_000;
const IMAGE_GENERATION_RESPONSE_MAX_BYTES = 1_250_000;
const IMAGE_REQUEST_MODES = new Set(["START", "DISCOVER", "STEP"]);
const IMAGE_RESPONSE_STATUSES = new Set(["MATERIALIZING", "PLANNING", "READY", "READY_DISCOVERY", "PARTIAL", "COMPLETE", "IN_FLIGHT", "UNKNOWN", "ERROR", "COMMITTED_RESULT", "LATE_RESULT"]);
const MEDIA_REF_PATTERN = /^xiaoshimei-media:\/\/sha256\/([0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function buildGenerationRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("generation input must be an object");
  return { schema: GENERATION_REQUEST_SCHEMA, input: structuredClone(input) };
}

export function parseGenerationRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("GENERATION_REQUEST_INVALID");
  if (value.schema !== GENERATION_REQUEST_SCHEMA) throw new TypeError("GENERATION_REQUEST_SCHEMA_UNSUPPORTED");
  if (!value.input || typeof value.input !== "object" || Array.isArray(value.input)) throw new TypeError("GENERATION_REQUEST_INPUT_INVALID");
  return structuredClone(value.input);
}

function requiredString(value, code, max = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(code);
  return value.trim();
}

function textDraftInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("TEXT_DRAFT_INPUT_INVALID");
  if (!input.profile_contract || typeof input.profile_contract !== "object") throw new TypeError("TEXT_DRAFT_PROFILE_INVALID");
  return {
    topic: requiredString(input.topic, "TEXT_DRAFT_TOPIC_INVALID", 12000),
    text_requirements: typeof input.text_requirements === "string" ? input.text_requirements.trim().slice(0, 4000) : "",
    pillar: requiredString(input.pillar, "TEXT_DRAFT_PILLAR_INVALID", 40),
    goal: requiredString(input.goal, "TEXT_DRAFT_GOAL_INVALID", 40),
    profile_contract: structuredClone(input.profile_contract),
    prompt_context: normalizePromptContext(input.prompt_context),
  };
}

export function buildTextDraftRequest(input) {
  return { schema: TEXT_DRAFT_REQUEST_SCHEMA, input: textDraftInput(input) };
}

export function parseTextDraftRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== TEXT_DRAFT_REQUEST_SCHEMA) throw new TypeError("TEXT_DRAFT_REQUEST_INVALID");
  return textDraftInput(value.input);
}

export function parseTextDraftResponse(value, { imageVariantTarget = null } = {}) {
  const frozenVariant = normalizePageImageVariantTarget(imageVariantTarget);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== TEXT_DRAFT_RESPONSE_SCHEMA) throw new TypeError("TEXT_DRAFT_RESPONSE_INVALID");
  if (typeof value.draft_id !== "string" || !value.draft_id || typeof value.source_input !== "string" || !value.source_input.trim()) throw new TypeError("TEXT_DRAFT_LINEAGE_INVALID");
  if (typeof value.pillar !== "string" || typeof value.goal !== "string") throw new TypeError("TEXT_DRAFT_ROUTE_INVALID");
  if (typeof value.text_requirements !== "string") throw new TypeError("TEXT_DRAFT_REQUIREMENTS_INVALID");
  if (!Array.isArray(value.titles) || value.titles.length !== 3 || !value.titles.every((item) => typeof item === "string" && item.trim())) throw new TypeError("TEXT_DRAFT_TITLES_INVALID");
  if (!value.titles.includes(value.selected_title)) throw new TypeError("TEXT_DRAFT_SELECTED_TITLE_INVALID");
  if (typeof value.body !== "string" || value.body.replace(/\s/g, "").length < (frozenVariant ? 1 : 180)) throw new TypeError("TEXT_DRAFT_BODY_INVALID");
  if (!Array.isArray(value.tags) || value.tags.length !== 5 || !value.tags.every((item) => typeof item === "string" && item.trim())) throw new TypeError("TEXT_DRAFT_TAGS_INVALID");
  if (!Number.isInteger(value.recommended_image_count) || value.recommended_image_count < 1 || value.recommended_image_count > 8) throw new TypeError("TEXT_DRAFT_IMAGE_COUNT_INVALID");
  const contentType = value.content_type == null ? "knowledge_card" : normalizeXhsContentType(value.content_type, "TEXT_DRAFT_CONTENT_TYPE");
  const styleLock = value.style_lock == null ? null : normalizeStyleLock(value.style_lock, "TEXT_DRAFT_STYLE_LOCK");
  return { ...structuredClone(value), content_type: contentType, ...(styleLock ? { style_lock: styleLock } : {}), prompt_context: normalizePromptContext(value.prompt_context) };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(value, fields, code) {
  if (!isPlainObject(value)) throw new TypeError(code);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(code);
}

function jsonByteLength(value, code) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { throw new TypeError(code); }
}

function exactString(value, code, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) throw new TypeError(code);
  return value;
}

function safeId(value, code, max = 160) {
  const normalized = exactString(value, code, max);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) throw new TypeError(code);
  return normalized;
}

function sha256String(value, code) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new TypeError(code);
  return value;
}

function exactStringArray(value, code, { length = null, maxItems = 40, maxItemLength = 2000 } = {}) {
  if (!Array.isArray(value) || (length != null && value.length !== length) || value.length > maxItems) throw new TypeError(code);
  return value.map((item) => exactString(item, code, maxItemLength));
}

function normalizeConfirmedImageDraft(value) {
  assertExactFields(value, ["draft_id", "source_input", "pillar", "goal", "titles", "selected_title", "body", "tags", "recommended_image_count", "facts", "risks", "content_type", "style_lock", "prompt_context"], "IMAGE_GENERATION_CONFIRMED_DRAFT_FIELDS_INVALID");
  const titles = exactStringArray(value.titles, "IMAGE_GENERATION_TITLES_INVALID", { length: 3, maxItems: 3, maxItemLength: 120 });
  const selectedTitle = exactString(value.selected_title, "IMAGE_GENERATION_SELECTED_TITLE_INVALID", 120);
  if (!titles.includes(selectedTitle)) throw new TypeError("IMAGE_GENERATION_SELECTED_TITLE_INVALID");
  const tags = exactStringArray(value.tags, "IMAGE_GENERATION_TAGS_INVALID", { length: 5, maxItems: 5, maxItemLength: 80 });
  const recommendedImageCount = Number(value.recommended_image_count);
  if (!Number.isInteger(recommendedImageCount) || recommendedImageCount < 1 || recommendedImageCount > 8) throw new TypeError("IMAGE_GENERATION_RECOMMENDED_COUNT_INVALID");
  return {
    draft_id: safeId(value.draft_id, "IMAGE_GENERATION_DRAFT_ID_INVALID"),
    source_input: exactString(value.source_input, "IMAGE_GENERATION_SOURCE_INVALID", 12_000),
    pillar: exactString(value.pillar, "IMAGE_GENERATION_PILLAR_INVALID", 40),
    goal: exactString(value.goal, "IMAGE_GENERATION_GOAL_INVALID", 40),
    titles,
    selected_title: selectedTitle,
    body: exactString(value.body, "IMAGE_GENERATION_BODY_INVALID", 12_000),
    tags,
    recommended_image_count: recommendedImageCount,
    facts: exactStringArray(value.facts, "IMAGE_GENERATION_FACTS_INVALID"),
    risks: exactStringArray(value.risks, "IMAGE_GENERATION_RISKS_INVALID"),
    content_type: normalizeXhsContentType(value.content_type, "IMAGE_GENERATION_CONTENT_TYPE_INVALID"),
    style_lock: value.style_lock == null ? null : normalizeStyleLock(value.style_lock, "IMAGE_GENERATION_STYLE_LOCK_INVALID"),
    prompt_context: normalizePromptContext(value.prompt_context),
  };
}

export function normalizePageImageVariantTarget(value) {
 if(value==null)return null;
 const fields=['schema','source_draft_id','source_page_index','source_page_sha256','object_id','image_id','title','body','visual_action','image_prompt'];
 assertExactFields(value,fields,'IMAGE_VARIANT_TARGET_FIELDS_INVALID');
 if(value.schema!=='xiaoshimei.page-image-variants-target.v1')throw new TypeError('IMAGE_VARIANT_TARGET_SCHEMA_INVALID');
 if(!Number.isInteger(value.source_page_index)||value.source_page_index<0||value.source_page_index>7)throw new TypeError('IMAGE_VARIANT_PAGE_INVALID');
 const imageId=safeId(value.image_id,'IMAGE_VARIANT_IMAGE_INVALID');
 if(!/^(?:hero|panel-\d+)$/.test(imageId))throw new TypeError('IMAGE_VARIANT_IMAGE_INVALID');
 return {schema:value.schema,source_draft_id:safeId(value.source_draft_id,'IMAGE_VARIANT_SOURCE_INVALID'),source_page_index:value.source_page_index,
  source_page_sha256:sha256String(value.source_page_sha256,'IMAGE_VARIANT_SOURCE_HASH_INVALID'),object_id:safeId(value.object_id,'IMAGE_VARIANT_OBJECT_INVALID'),image_id:imageId,
  title:exactString(value.title,'IMAGE_VARIANT_TITLE_INVALID',120),body:exactString(value.body,'IMAGE_VARIANT_BODY_INVALID',2000,{allowEmpty:true}),
  visual_action:exactString(value.visual_action,'IMAGE_VARIANT_ACTION_INVALID',400),image_prompt:exactString(value.image_prompt,'IMAGE_VARIANT_PROMPT_INVALID',1800,{allowEmpty:true})};
}

function normalizeImageOperationSnapshot(value) {
  const hasVariant = Object.prototype.hasOwnProperty.call(value || {}, "image_variant_target");
  assertExactFields(value, ["schema", "draft_record_id", "mutation_epoch", "confirmed_draft", "page_count", "production_mode", "reference_note", ...(hasVariant ? ["image_variant_target"] : [])], "IMAGE_GENERATION_OPERATION_SNAPSHOT_FIELDS_INVALID");
  if (value.schema !== IMAGE_OPERATION_SNAPSHOT_SCHEMA) throw new TypeError("IMAGE_GENERATION_OPERATION_SNAPSHOT_SCHEMA_INVALID");
  const mutationEpoch = Number(value.mutation_epoch);
  if (!Number.isSafeInteger(mutationEpoch) || mutationEpoch < 0) throw new TypeError("IMAGE_GENERATION_MUTATION_EPOCH_INVALID");
  const pageCount = Number(value.page_count);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 8) throw new TypeError("IMAGE_GENERATION_PAGE_COUNT_INVALID");
  const snapshot = {
    schema: IMAGE_OPERATION_SNAPSHOT_SCHEMA,
    draft_record_id: safeId(value.draft_record_id, "IMAGE_GENERATION_DRAFT_RECORD_ID_INVALID"),
    mutation_epoch: mutationEpoch,
    confirmed_draft: normalizeConfirmedImageDraft(value.confirmed_draft),
    page_count: pageCount,
    production_mode: normalizeProductionMode(value.production_mode, "IMAGE_GENERATION_PRODUCTION_MODE_INVALID"),
    reference_note: exactString(value.reference_note, "IMAGE_GENERATION_REFERENCE_NOTE_INVALID", 1000, { allowEmpty: true }),
  };
  if(hasVariant){
    const target=normalizePageImageVariantTarget(value.image_variant_target);
    if(!target||snapshot.page_count!==3||snapshot.production_mode!=='smart')throw new TypeError('IMAGE_VARIANT_OPERATION_INVALID');
    snapshot.image_variant_target=target;
  }
  if (jsonByteLength(snapshot, "IMAGE_GENERATION_OPERATION_SNAPSHOT_INVALID") > IMAGE_OPERATION_SNAPSHOT_MAX_BYTES) throw new TypeError("IMAGE_GENERATION_OPERATION_SNAPSHOT_TOO_LARGE");
  return snapshot;
}

function normalizeReferenceManifest(value, index, { response = false, runId = null } = {}) {
  const baseFields = ["schema", "media_ref", "sha256", "size_bytes", "mime", "name", "width", "height"];
  const hasAssetUrl = response && Object.prototype.hasOwnProperty.call(value || {}, "asset_url");
  assertExactFields(value, hasAssetUrl ? [...baseFields, "asset_url"] : baseFields, `IMAGE_GENERATION_REFERENCE_${index + 1}_FIELDS_INVALID`);
  if (value.schema !== IMAGE_MEDIA_MANIFEST_SCHEMA) throw new TypeError(`IMAGE_GENERATION_REFERENCE_${index + 1}_SCHEMA_INVALID`);
  const sha256 = sha256String(value.sha256, `IMAGE_GENERATION_REFERENCE_${index + 1}_SHA_INVALID`);
  const mediaRefMatch = typeof value.media_ref === "string" ? MEDIA_REF_PATTERN.exec(value.media_ref) : null;
  if (!mediaRefMatch || mediaRefMatch[1] !== sha256) throw new TypeError(`IMAGE_GENERATION_REFERENCE_${index + 1}_REF_INVALID`);
  const sizeBytes = Number(value.size_bytes);
  const maxSizeBytes = response ? IMAGE_RESPONSE_ASSET_MAX_BYTES : IMAGE_REFERENCE_ASSET_MAX_BYTES;
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxSizeBytes) throw new TypeError(response ? "IMAGE_GENERATION_RESPONSE_ASSET_SIZE_INVALID" : "IMAGE_GENERATION_REFERENCE_SIZE_INVALID");
  if (value.mime !== "image/jpeg") throw new TypeError(`IMAGE_GENERATION_REFERENCE_${index + 1}_MIME_INVALID`);
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isInteger(width) || width < 1 || width > 20_000 || !Number.isInteger(height) || height < 1 || height > 20_000) throw new TypeError(`IMAGE_GENERATION_REFERENCE_${index + 1}_DIMENSIONS_INVALID`);
  const normalized = {
    schema: IMAGE_MEDIA_MANIFEST_SCHEMA,
    media_ref: value.media_ref,
    sha256,
    size_bytes: sizeBytes,
    mime: "image/jpeg",
    name: exactString(value.name, `IMAGE_GENERATION_REFERENCE_${index + 1}_NAME_INVALID`, 100),
    width,
    height,
  };
  if (hasAssetUrl) {
    const assetUrlMatch = typeof value.asset_url === "string"
      ? /^\/api\/provider\/assets\/([A-Za-z0-9._:-]{1,160})\/([0-9a-f]{64})$/.exec(value.asset_url)
      : null;
    if (!assetUrlMatch || assetUrlMatch[1] !== runId || assetUrlMatch[2] !== sha256) throw new TypeError(`IMAGE_GENERATION_REFERENCE_${index + 1}_ASSET_URL_INVALID`);
    normalized.asset_url = value.asset_url;
  }
  return normalized;
}

function normalizeManifestArray(value, code, options = {}) {
  if (!Array.isArray(value) || value.length > (options.maxItems ?? 8)) throw new TypeError(code);
  const normalized = value.map((item, index) => normalizeReferenceManifest(item, index, options));
  if (new Set(normalized.map((item) => item.media_ref)).size !== normalized.length) throw new TypeError(code);
  return normalized;
}

export function canonicalImageGenerationInputPreimage({ operation_snapshot: operationSnapshot, reference_manifest: referenceManifest } = {}) {
  const normalizedSnapshot = normalizeImageOperationSnapshot(operationSnapshot);
  const normalizedManifest = normalizeManifestArray(referenceManifest, "IMAGE_GENERATION_REFERENCES_INVALID", { maxItems: 3 });
  const totalBytes = normalizedManifest.reduce((total, item) => total + item.size_bytes, 0);
  if (totalBytes > IMAGE_REFERENCE_TOTAL_MAX_BYTES) throw new TypeError("IMAGE_GENERATION_REFERENCE_TOTAL_INVALID");
  return JSON.stringify({ operation_snapshot: normalizedSnapshot, reference_manifest: normalizedManifest });
}

export async function computeImageGenerationInputSha256(value, { subtle = globalThis.crypto?.subtle } = {}) {
  if (!subtle || typeof subtle.digest !== "function") throw new TypeError("IMAGE_GENERATION_SHA256_UNAVAILABLE");
  const bytes = new TextEncoder().encode(canonicalImageGenerationInputPreimage(value));
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodedBase64Length(value, code) {
  if (typeof value !== "string" || value.length < 4 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new TypeError(code);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function normalizeMissingReferenceMedia(value, manifests) {
  if (!Array.isArray(value) || value.length > 3) throw new TypeError("IMAGE_GENERATION_MISSING_MEDIA_INVALID");
  const byRef = new Map(manifests.map((manifest) => [manifest.media_ref, manifest]));
  const seen = new Set();
  return value.map((item, index) => {
    assertExactFields(item, ["media_ref", "sha256", "size_bytes", "mime", "bytes_base64"], `IMAGE_GENERATION_MISSING_MEDIA_${index + 1}_FIELDS_INVALID`);
    const manifest = byRef.get(item.media_ref);
    if (!manifest || seen.has(item.media_ref)) throw new TypeError("IMAGE_GENERATION_MISSING_MEDIA_INVALID");
    seen.add(item.media_ref);
    if (item.sha256 !== manifest.sha256 || item.size_bytes !== manifest.size_bytes || item.mime !== manifest.mime) throw new TypeError(`IMAGE_GENERATION_MISSING_MEDIA_${index + 1}_MANIFEST_MISMATCH`);
    if (decodedBase64Length(item.bytes_base64, `IMAGE_GENERATION_MISSING_MEDIA_${index + 1}_BYTES_INVALID`) !== manifest.size_bytes) throw new TypeError(`IMAGE_GENERATION_MISSING_MEDIA_${index + 1}_SIZE_MISMATCH`);
    return { media_ref: manifest.media_ref, sha256: manifest.sha256, size_bytes: manifest.size_bytes, mime: manifest.mime, bytes_base64: item.bytes_base64 };
  });
}

function assertSmallOpaqueState(value, code, maxBytes = IMAGE_CHECKPOINT_MAX_BYTES) {
  if (!isPlainObject(value)) throw new TypeError(code);
  const forbiddenKeys = new Set(["draft", "confirmed_draft", "reference_manifest", "reference_images", "missing_reference_media", "bytes_base64", "data_url"]);
  const visit = (current) => {
    if (typeof current === "string" && /^(?:data|blob):/i.test(current)) throw new TypeError(code);
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (forbiddenKeys.has(key)) throw new TypeError(code);
      visit(child);
    }
  };
  visit(value);
  if (jsonByteLength(value, code) > maxBytes) throw new TypeError(code);
  return structuredClone(value);
}

function normalizeImageGenerationInput(input) {
  if (!isPlainObject(input) || !IMAGE_REQUEST_MODES.has(input.mode)) throw new TypeError("IMAGE_GENERATION_MODE_INVALID");
  if (input.mode === "DISCOVER") {
    assertExactFields(input, ["mode", "bootstrap_nonce", "input_sha256"], "IMAGE_GENERATION_DISCOVER_FIELDS_INVALID");
    return { mode: "DISCOVER", bootstrap_nonce: sha256String(input.bootstrap_nonce, "IMAGE_GENERATION_BOOTSTRAP_NONCE_INVALID"), input_sha256: sha256String(input.input_sha256, "IMAGE_GENERATION_INPUT_SHA_INVALID") };
  }
  if (input.mode === "STEP") {
    assertExactFields(input, ["mode", "run_id", "checkpoint_preimage", "checkpoint_preimage_sha256", "logical_step_id", "attempt_nonce"], "IMAGE_GENERATION_STEP_FIELDS_INVALID");
    return {
      mode: "STEP",
      run_id: safeId(input.run_id, "IMAGE_GENERATION_RUN_ID_INVALID"),
      checkpoint_preimage: assertSmallOpaqueState(input.checkpoint_preimage, "IMAGE_GENERATION_CHECKPOINT_INVALID"),
      checkpoint_preimage_sha256: sha256String(input.checkpoint_preimage_sha256, "IMAGE_GENERATION_CHECKPOINT_SHA_INVALID"),
      logical_step_id: safeId(input.logical_step_id, "IMAGE_GENERATION_LOGICAL_STEP_ID_INVALID", 120),
      attempt_nonce: sha256String(input.attempt_nonce, "IMAGE_GENERATION_ATTEMPT_NONCE_INVALID"),
    };
  }
  assertExactFields(input, ["mode", "bootstrap_nonce", "operation_snapshot", "input_sha256", "reference_manifest", "missing_reference_media"], "IMAGE_GENERATION_START_FIELDS_INVALID");
  const referenceManifest = normalizeManifestArray(input.reference_manifest, "IMAGE_GENERATION_REFERENCES_INVALID", { maxItems: 3 });
  const totalBytes = referenceManifest.reduce((total, item) => total + item.size_bytes, 0);
  if (totalBytes > IMAGE_REFERENCE_TOTAL_MAX_BYTES) throw new TypeError("IMAGE_GENERATION_REFERENCE_TOTAL_INVALID");
  const normalized = {
    mode: "START",
    bootstrap_nonce: sha256String(input.bootstrap_nonce, "IMAGE_GENERATION_BOOTSTRAP_NONCE_INVALID"),
    operation_snapshot: normalizeImageOperationSnapshot(input.operation_snapshot),
    input_sha256: sha256String(input.input_sha256, "IMAGE_GENERATION_INPUT_SHA_INVALID"),
    reference_manifest: referenceManifest,
    missing_reference_media: normalizeMissingReferenceMedia(input.missing_reference_media, referenceManifest),
  };
  const envelope = { schema: IMAGE_GENERATION_REQUEST_SCHEMA, input: normalized };
  if (jsonByteLength(envelope, "IMAGE_GENERATION_REQUEST_INVALID") > IMAGE_GENERATION_REQUEST_MAX_BYTES) throw new TypeError("IMAGE_GENERATION_REQUEST_TOO_LARGE");
  return normalized;
}

export function buildImageGenerationRequest(input) {
  return { schema: IMAGE_GENERATION_REQUEST_SCHEMA, input: normalizeImageGenerationInput(input) };
}

export function parseImageGenerationRequest(value) {
  assertExactFields(value, ["schema", "input"], "IMAGE_GENERATION_REQUEST_FIELDS_INVALID");
  if (value.schema !== IMAGE_GENERATION_REQUEST_SCHEMA) throw new TypeError("IMAGE_GENERATION_REQUEST_INVALID");
  const input = normalizeImageGenerationInput(value.input);
  if (jsonByteLength({ schema: IMAGE_GENERATION_REQUEST_SCHEMA, input }, "IMAGE_GENERATION_REQUEST_INVALID") > IMAGE_GENERATION_REQUEST_MAX_BYTES) throw new TypeError("IMAGE_GENERATION_REQUEST_TOO_LARGE");
  return input;
}

function normalizeResponseError(value) {
  if (value == null) return null;
  const fields = Object.prototype.hasOwnProperty.call(value || {}, "details") ? ["code", "details"] : ["code"];
  assertExactFields(value, fields, "IMAGE_GENERATION_RESPONSE_ERROR_INVALID");
  const normalized = { code: safeId(value.code, "IMAGE_GENERATION_RESPONSE_ERROR_CODE_INVALID", 160) };
  if (fields.includes("details")) normalized.details = assertSmallOpaqueState(value.details, "IMAGE_GENERATION_RESPONSE_ERROR_DETAILS_INVALID", 64_000);
  return normalized;
}

function assertRefOnlyContentPackage(value) {
  if (!isPlainObject(value)) throw new TypeError("IMAGE_GENERATION_RESPONSE_CONTENT_INVALID");
  const visit = (current, key = "") => {
    if (typeof current === "string") {
      if (/^(?:data|blob):/i.test(current)) throw new TypeError("IMAGE_GENERATION_RESPONSE_MEDIA_INLINE_FORBIDDEN");
      if ((key === "src" || key === "imageSrc") && current && !MEDIA_REF_PATTERN.test(current)) throw new TypeError("IMAGE_GENERATION_RESPONSE_CONTENT_MEDIA_REF_INVALID");
      return;
    }
    if (!current || typeof current !== "object") return;
    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current) || (typeof Blob !== "undefined" && current instanceof Blob)) {
      throw new TypeError("IMAGE_GENERATION_RESPONSE_MEDIA_INLINE_FORBIDDEN");
    }
    for (const [childKey, child] of Object.entries(current)) {
      if (new Set(["bytes", "bytes_base64", "data_url", "blob", "blob_url", "asset_url"]).has(childKey)) {
        throw new TypeError("IMAGE_GENERATION_RESPONSE_MEDIA_INLINE_FORBIDDEN");
      }
      visit(child, childKey);
    }
  };
  visit(value);
  if (jsonByteLength(value, "IMAGE_GENERATION_RESPONSE_CONTENT_INVALID") > IMAGE_CONTENT_PACKAGE_MAX_BYTES) throw new TypeError("IMAGE_GENERATION_RESPONSE_CONTENT_TOO_LARGE");
  return structuredClone(value);
}

export function parseImageGenerationResponse(value) {
  const fields = ["schema", "status", "bootstrap_nonce", "input_sha256", "run_id", "checkpoint_preimage", "checkpoint_preimage_sha256", "logical_step_id", "progress", "assets", "media_delta", "error", "cached", "recoverable_until", "upstream_calls"];
  if (Object.prototype.hasOwnProperty.call(value || {}, "content_package")) fields.push("content_package");
  assertExactFields(value, fields, "IMAGE_GENERATION_RESPONSE_FIELDS_INVALID");
  if (value.schema !== IMAGE_GENERATION_RESPONSE_SCHEMA || !IMAGE_RESPONSE_STATUSES.has(value.status)) throw new TypeError("IMAGE_GENERATION_RESPONSE_INVALID");
  const runId = safeId(value.run_id, "IMAGE_GENERATION_RESPONSE_RUN_ID_INVALID");
  const assets = normalizeManifestArray(value.assets, "IMAGE_GENERATION_RESPONSE_ASSETS_INVALID", { maxItems: 32, response: true, runId });
  const mediaDelta = normalizeManifestArray(value.media_delta, "IMAGE_GENERATION_RESPONSE_MEDIA_DELTA_INVALID", { maxItems: 9, response: true, runId });
  if (mediaDelta.some((item) => !item.asset_url)) throw new TypeError("IMAGE_GENERATION_RESPONSE_MEDIA_DELTA_ASSET_URL_REQUIRED");
  const normalized = {
    schema: IMAGE_GENERATION_RESPONSE_SCHEMA,
    status: value.status,
    bootstrap_nonce: sha256String(value.bootstrap_nonce, "IMAGE_GENERATION_RESPONSE_NONCE_INVALID"),
    input_sha256: sha256String(value.input_sha256, "IMAGE_GENERATION_RESPONSE_INPUT_SHA_INVALID"),
    run_id: runId,
    checkpoint_preimage: assertSmallOpaqueState(value.checkpoint_preimage, "IMAGE_GENERATION_RESPONSE_CHECKPOINT_INVALID"),
    checkpoint_preimage_sha256: sha256String(value.checkpoint_preimage_sha256, "IMAGE_GENERATION_RESPONSE_CHECKPOINT_SHA_INVALID"),
    logical_step_id: safeId(value.logical_step_id, "IMAGE_GENERATION_RESPONSE_LOGICAL_STEP_INVALID", 120),
    progress: assertSmallOpaqueState(value.progress, "IMAGE_GENERATION_RESPONSE_PROGRESS_INVALID", 64_000),
    assets,
    media_delta: mediaDelta,
    error: normalizeResponseError(value.error),
    cached: typeof value.cached === "boolean" ? value.cached : (() => { throw new TypeError("IMAGE_GENERATION_RESPONSE_CACHED_INVALID"); })(),
    recoverable_until: exactString(value.recoverable_until, "IMAGE_GENERATION_RESPONSE_RECOVERY_INVALID", 64, { allowEmpty: true }),
    upstream_calls: Number(value.upstream_calls),
  };
  if (!Number.isInteger(normalized.upstream_calls) || normalized.upstream_calls < 0 || normalized.upstream_calls > 1) throw new TypeError("IMAGE_GENERATION_RESPONSE_UPSTREAM_INVALID");
  if (value.status === "ERROR" && normalized.error == null) throw new TypeError("IMAGE_GENERATION_RESPONSE_ERROR_REQUIRED");
  if (value.status !== "ERROR" && normalized.error != null) throw new TypeError("IMAGE_GENERATION_RESPONSE_ERROR_INVALID");
  if (value.status === "COMPLETE") {
    if (!Object.prototype.hasOwnProperty.call(value, "content_package")) throw new TypeError("IMAGE_GENERATION_RESPONSE_CONTENT_REQUIRED");
    normalized.content_package = assertRefOnlyContentPackage(value.content_package);
  } else if (Object.prototype.hasOwnProperty.call(value, "content_package")) {
    throw new TypeError("IMAGE_GENERATION_RESPONSE_CONTENT_INVALID");
  }
  if (jsonByteLength(normalized, "IMAGE_GENERATION_RESPONSE_INVALID") > IMAGE_GENERATION_RESPONSE_MAX_BYTES) throw new TypeError("IMAGE_GENERATION_RESPONSE_TOO_LARGE");
  return normalized;
}

export const parsePublicImageStepResponse = parseImageGenerationResponse;

function pageCandidateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("PAGE_CANDIDATE_INPUT_INVALID");
  const pageIndex = Number(input.page_index);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 7) throw new TypeError("PAGE_CANDIDATE_INDEX_INVALID");
  const string = (value, code, max) => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(code);
    return value.trim();
  };
  const optionalString = (value, code, max) => {
    if (value == null || value === "") return "";
    if (typeof value !== "string" || value.length > max) throw new TypeError(code);
    return value.trim();
  };
  return {
    page_index: pageIndex,
    source_input: string(input.source_input, "PAGE_CANDIDATE_SOURCE_INVALID", 2000),
    title: string(input.title, "PAGE_CANDIDATE_TITLE_INVALID", 120),
    body: string(input.body, "PAGE_CANDIDATE_BODY_INVALID", 500),
    layout: string(input.layout, "PAGE_CANDIDATE_LAYOUT_INVALID", 40),
    content_type: input.content_type ? normalizeXhsContentType(input.content_type, "PAGE_CANDIDATE_CONTENT_TYPE_INVALID") : "knowledge_card",
    page_role: input.page_role ? normalizeXhsPageRole(input.page_role, "PAGE_CANDIDATE_PAGE_ROLE_INVALID") : (pageIndex === 0 ? "hook" : "example"),
    visual_action: optionalString(input.visual_action, "PAGE_CANDIDATE_VISUAL_ACTION_INVALID", 400),
    image_prompt: optionalString(input.image_prompt, "PAGE_CANDIDATE_IMAGE_PROMPT_INVALID", 1800),
    style_lock: input.style_lock == null ? null : normalizeStyleLock(input.style_lock, "PAGE_CANDIDATE_STYLE_LOCK_INVALID"),
    prompt_context: normalizePromptContext(input.prompt_context),
  };
}

export function buildPageCandidateRequest(input) {
  return { schema: PAGE_CANDIDATE_REQUEST_SCHEMA, input: pageCandidateInput(input) };
}

export function parsePageCandidateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== PAGE_CANDIDATE_REQUEST_SCHEMA) throw new TypeError("PAGE_CANDIDATE_REQUEST_INVALID");
  return pageCandidateInput(value.input);
}

export function parsePageCandidateResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== PAGE_CANDIDATE_RESPONSE_SCHEMA) throw new TypeError("PAGE_CANDIDATE_RESPONSE_INVALID");
  if (!Array.isArray(value.candidates) || value.candidates.length !== 3) throw new TypeError("PAGE_CANDIDATE_COUNT_INVALID");
  const candidates = value.candidates.map((item, index) => {
    const source = String(item?.src || "");
    const localAsset = /^\/generated\/ark\/page-candidates\/[^/]+\/(0[1-3])\.(png|jpg)$/.test(source);
    const browserAsset = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(source);
    if (!item || typeof item !== "object" || (!localAsset && !browserAsset)) throw new TypeError(`PAGE_CANDIDATE_${index + 1}_SRC_INVALID`);
    if (!/^[0-9a-f]{64}$/.test(String(item.sha256)) || !Number.isInteger(item.size_bytes) || item.size_bytes < 1024) throw new TypeError(`PAGE_CANDIDATE_${index + 1}_EVIDENCE_INVALID`);
    if (item.width * 4 !== item.height * 3) throw new TypeError(`PAGE_CANDIDATE_${index + 1}_RATIO_INVALID`);
    return { src: item.src, sha256: item.sha256, size_bytes: item.size_bytes, width: item.width, height: item.height };
  });
  return { schema: PAGE_CANDIDATE_RESPONSE_SCHEMA, run_id: String(value.run_id || ""), candidates };
}
