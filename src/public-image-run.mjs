export const PUBLIC_IMAGE_RUN_SCHEMA = "xiaoshimei.public-image-run.v1";
export const PUBLIC_IMAGE_CALL_LIMIT = 6;

const PHASES = new Set(["PRIMARY", "GROUPED_REPAIR", "STANDALONE_REPAIR", "COMPLETE", "EXHAUSTED"]);
const STATUSES = new Set(["GENERATING", "IMAGE_CALL_IN_PROGRESS", "PARTIAL_FAILURE_RESUMABLE", "COMPLETE", "EXHAUSTED"]);
const MAX_CHECKPOINT_BYTES = 3_800_000;

function requiredString(value, code, max = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(code);
  return value.trim();
}

function requiredSha(value, code) {
  const normalized = requiredString(value, code, 64);
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new TypeError(code);
  return normalized;
}

function cloneWithoutSignature(value) {
  const cloned = structuredClone(value);
  delete cloned.signature;
  return cloned;
}

function normalizeJob(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`PUBLIC_IMAGE_JOB_${index + 1}_INVALID`);
  const kind = value.job_kind === "standalone" ? "standalone" : "mother_sheet";
  const units = Array.isArray(value.units) ? structuredClone(value.units) : [];
  if (units.length < 1 || units.length > (kind === "standalone" ? 1 : 9)) throw new TypeError(`PUBLIC_IMAGE_JOB_${index + 1}_UNITS_INVALID`);
  units.forEach((unit, unitIndex) => requiredString(unit?.unit_id, `PUBLIC_IMAGE_JOB_${index + 1}_UNIT_${unitIndex + 1}_INVALID`, 120));
  return {
    ...structuredClone(value),
    job_kind: kind,
    sheet_index: Number.isInteger(value.sheet_index) ? value.sheet_index : index,
    sheet_id: requiredString(value.sheet_id || `image-step-${index + 1}`, `PUBLIC_IMAGE_JOB_${index + 1}_ID_INVALID`, 120),
    units,
  };
}

function normalizeAsset(value, unitIds, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`PUBLIC_IMAGE_ASSET_${index + 1}_INVALID`);
  const unitId = requiredString(value.unit_id, `PUBLIC_IMAGE_ASSET_${index + 1}_UNIT_INVALID`, 120);
  if (!unitIds.has(unitId)) throw new TypeError(`PUBLIC_IMAGE_ASSET_${index + 1}_UNIT_UNKNOWN`);
  const src = requiredString(value.src, `PUBLIC_IMAGE_ASSET_${index + 1}_SRC_INVALID`, 1_000_000);
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) throw new TypeError(`PUBLIC_IMAGE_ASSET_${index + 1}_SRC_INVALID`);
  const sizeBytes = Number(value.size_bytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1024 || sizeBytes > 750_000) throw new TypeError(`PUBLIC_IMAGE_ASSET_${index + 1}_SIZE_INVALID`);
  return { ...structuredClone(value), unit_id: unitId, src, sha256: requiredSha(value.sha256, `PUBLIC_IMAGE_ASSET_${index + 1}_HASH_INVALID`), size_bytes: sizeBytes };
}

export function parsePublicImageRun(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== PUBLIC_IMAGE_RUN_SCHEMA) throw new TypeError("PUBLIC_IMAGE_RESUME_CHECKPOINT_INVALID");
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_CHECKPOINT_BYTES) throw new TypeError("PUBLIC_IMAGE_RESUME_CHECKPOINT_TOO_LARGE");
  const runId = requiredString(value.run_id, "PUBLIC_IMAGE_RUN_ID_INVALID", 120);
  if (!/^images-[0-9TZ-]+-[0-9a-f]{8}$/.test(runId)) throw new TypeError("PUBLIC_IMAGE_RUN_ID_INVALID");
  const draftId = requiredString(value.draft_id, "PUBLIC_IMAGE_DRAFT_ID_INVALID", 160);
  const draftSha256 = requiredSha(value.draft_sha256, "PUBLIC_IMAGE_DRAFT_HASH_INVALID");
  const productionMode = requiredString(value.production_mode, "PUBLIC_IMAGE_PRODUCTION_MODE_INVALID", 40);
  if (!["smart", "narrative", "infographic"].includes(productionMode)) throw new TypeError("PUBLIC_IMAGE_PRODUCTION_MODE_INVALID");
  const finalPageCount = Number(value.final_page_count);
  if (!Number.isInteger(finalPageCount) || finalPageCount < 1 || finalPageCount > 8 || !Array.isArray(value.final_pages) || value.final_pages.length !== finalPageCount) throw new TypeError("PUBLIC_IMAGE_FINAL_PAGE_CONTRACT_INVALID");
  if (!Array.isArray(value.illustration_units) || value.illustration_units.length < 1 || value.illustration_units.length > 32) throw new TypeError("PUBLIC_IMAGE_UNIT_CONTRACT_INVALID");
  const illustrationUnits = structuredClone(value.illustration_units);
  const unitIds = new Set(illustrationUnits.map((unit, index) => requiredString(unit?.unit_id, `PUBLIC_IMAGE_UNIT_${index + 1}_INVALID`, 120)));
  if (unitIds.size !== illustrationUnits.length) throw new TypeError("PUBLIC_IMAGE_UNIT_DUPLICATE");
  if (!Array.isArray(value.jobs) || value.jobs.length < 1 || value.jobs.length > 48) throw new TypeError("PUBLIC_IMAGE_JOBS_INVALID");
  const jobs = value.jobs.map(normalizeJob);
  const nextJobIndex = Number(value.next_job_index);
  if (!Number.isInteger(nextJobIndex) || nextJobIndex < 0 || nextJobIndex > jobs.length) throw new TypeError("PUBLIC_IMAGE_NEXT_JOB_INVALID");
  const assets = Array.isArray(value.assets) ? value.assets.map((asset, index) => normalizeAsset(asset, unitIds, index)) : null;
  if (!assets) throw new TypeError("PUBLIC_IMAGE_ASSETS_INVALID");
  if (new Set(assets.map((asset) => asset.unit_id)).size !== assets.length) throw new TypeError("PUBLIC_IMAGE_ASSET_DUPLICATE");
  if (!Array.isArray(value.job_attempts) || value.job_attempts.length > 64) throw new TypeError("PUBLIC_IMAGE_ATTEMPTS_INVALID");
  const maxImageCalls = Number(value.max_image_calls);
  if (maxImageCalls !== PUBLIC_IMAGE_CALL_LIMIT) throw new TypeError("PUBLIC_IMAGE_CALL_LIMIT_INVALID");
  const actualImageCalls = Number(value.actual_image_calls);
  if (!Number.isInteger(actualImageCalls) || actualImageCalls < 0 || actualImageCalls > maxImageCalls || actualImageCalls < value.job_attempts.length) throw new TypeError("PUBLIC_IMAGE_CALL_EVIDENCE_INVALID");
  const phase = requiredString(value.phase, "PUBLIC_IMAGE_PHASE_INVALID", 40);
  const status = requiredString(value.status, "PUBLIC_IMAGE_STATUS_INVALID", 48);
  if (!PHASES.has(phase) || !STATUSES.has(status)) throw new TypeError("PUBLIC_IMAGE_STATE_INVALID");
  const normalized = {
    schema: PUBLIC_IMAGE_RUN_SCHEMA,
    run_id: runId,
    draft_id: draftId,
    draft_sha256: draftSha256,
    production_mode: productionMode,
    final_page_count: finalPageCount,
    final_pages: structuredClone(value.final_pages),
    illustration_units: illustrationUnits,
    plan_attempts: Array.isArray(value.plan_attempts) ? structuredClone(value.plan_attempts).slice(0, 3) : [],
    reference_fingerprint: requiredSha(value.reference_fingerprint, "PUBLIC_IMAGE_REFERENCE_FINGERPRINT_INVALID"),
    jobs,
    next_job_index: nextJobIndex,
    assets,
    job_attempts: structuredClone(value.job_attempts),
    max_image_calls: maxImageCalls,
    actual_image_calls: actualImageCalls,
    phase,
    status,
    failure: value.failure && typeof value.failure === "object" && !Array.isArray(value.failure) ? structuredClone(value.failure) : null,
    ...(typeof value.signature === "string" ? { signature: value.signature } : {}),
  };
  if (expected.draftId != null && normalized.draft_id !== expected.draftId) throw new TypeError("PUBLIC_IMAGE_RESUME_DRAFT_ID_MISMATCH");
  if (expected.draftSha256 != null && normalized.draft_sha256 !== expected.draftSha256) throw new TypeError("PUBLIC_IMAGE_RESUME_DRAFT_HASH_MISMATCH");
  if (expected.productionMode != null && normalized.production_mode !== expected.productionMode) throw new TypeError("PUBLIC_IMAGE_RESUME_PRODUCTION_MODE_MISMATCH");
  if (expected.finalPageCount != null && normalized.final_page_count !== expected.finalPageCount) throw new TypeError("PUBLIC_IMAGE_RESUME_PAGE_COUNT_MISMATCH");
  if (expected.referenceFingerprint != null && normalized.reference_fingerprint !== expected.referenceFingerprint) throw new TypeError("PUBLIC_IMAGE_RESUME_REFERENCE_MISMATCH");
  return normalized;
}

export function createPublicImageRun({ runId, draftId, draftSha256, productionMode, finalPages, illustrationUnits, planAttempts = [], referenceFingerprint, jobs }) {
  return parsePublicImageRun({
    schema: PUBLIC_IMAGE_RUN_SCHEMA,
    run_id: runId,
    draft_id: draftId,
    draft_sha256: draftSha256,
    production_mode: productionMode,
    final_page_count: finalPages.length,
    final_pages: structuredClone(finalPages),
    illustration_units: structuredClone(illustrationUnits),
    plan_attempts: structuredClone(planAttempts),
    reference_fingerprint: referenceFingerprint,
    jobs: jobs.map((job) => structuredClone(job)),
    next_job_index: 0,
    assets: [],
    job_attempts: [],
    max_image_calls: PUBLIC_IMAGE_CALL_LIMIT,
    actual_image_calls: 0,
    phase: "PRIMARY",
    status: "GENERATING",
    failure: null,
  });
}

export function startPublicImageJob(value) {
  const next = cloneWithoutSignature(parsePublicImageRun(value));
  if (next.next_job_index >= next.jobs.length || next.phase === "COMPLETE" || next.phase === "EXHAUSTED") throw new TypeError("PUBLIC_IMAGE_JOB_NOT_AVAILABLE");
  if (next.actual_image_calls >= next.max_image_calls) throw new TypeError("IMAGE_CALL_BUDGET_EXHAUSTED");
  next.actual_image_calls += 1;
  next.status = "IMAGE_CALL_IN_PROGRESS";
  next.failure = null;
  return parsePublicImageRun(next);
}

export function markPublicImageBudgetExhausted(value) {
  const next = cloneWithoutSignature(parsePublicImageRun(value));
  if (next.actual_image_calls < next.max_image_calls || next.phase === "COMPLETE" || next.phase === "EXHAUSTED") {
    throw new TypeError("PUBLIC_IMAGE_BUDGET_EXHAUSTION_INVALID");
  }
  next.status = "PARTIAL_FAILURE_RESUMABLE";
  next.failure = {
    failed_job_index: next.next_job_index,
    code: "IMAGE_CALL_BUDGET_EXHAUSTED",
    provider_asset_returned: false,
  };
  return parsePublicImageRun(next);
}

export function admitPublicImageJob(value, { assets = [], attempt = {} } = {}) {
  const next = cloneWithoutSignature(parsePublicImageRun(value));
  if (next.status !== "IMAGE_CALL_IN_PROGRESS" || next.next_job_index >= next.jobs.length) throw new TypeError("PUBLIC_IMAGE_JOB_ADMISSION_INVALID");
  const unitIds = new Set(next.illustration_units.map((unit) => unit.unit_id));
  const admitted = assets.map((asset, index) => normalizeAsset(asset, unitIds, index));
  const byUnit = new Map(next.assets.map((asset) => [asset.unit_id, asset]));
  admitted.forEach((asset) => byUnit.set(asset.unit_id, asset));
  const job = next.jobs[next.next_job_index];
  next.assets = [...byUnit.values()];
  next.job_attempts.push({
    job_index: next.next_job_index,
    job_id: job.sheet_id,
    job_kind: job.job_kind,
    decision: admitted.length === job.units.length ? "ASSETS_ADMITTED" : "PARTIAL_ASSETS_ADMITTED",
    admitted_unit_ids: admitted.map((asset) => asset.unit_id),
    missing_unit_ids: job.units.map((unit) => unit.unit_id).filter((unitId) => !admitted.some((asset) => asset.unit_id === unitId)),
    ...structuredClone(attempt),
  });
  next.next_job_index += 1;
  next.status = "GENERATING";
  next.failure = null;
  return parsePublicImageRun(next);
}

export function failPublicImageJob(value, { code, providerAssetReturned = false } = {}) {
  const next = cloneWithoutSignature(parsePublicImageRun(value));
  if (next.status !== "IMAGE_CALL_IN_PROGRESS" || next.next_job_index >= next.jobs.length) throw new TypeError("PUBLIC_IMAGE_JOB_FAILURE_INVALID");
  const job = next.jobs[next.next_job_index];
  const failureCode = requiredString(code, "PUBLIC_IMAGE_FAILURE_CODE_INVALID", 360);
  next.job_attempts.push({ job_index: next.next_job_index, job_id: job.sheet_id, job_kind: job.job_kind, decision: "FAILED_RESUMABLE", code: failureCode, provider_asset_returned: Boolean(providerAssetReturned) });
  next.status = "PARTIAL_FAILURE_RESUMABLE";
  next.failure = { failed_job_index: next.next_job_index, code: failureCode, provider_asset_returned: Boolean(providerAssetReturned) };
  return parsePublicImageRun(next);
}

export function appendPublicImageJobs(value, { phase, jobs }) {
  const next = cloneWithoutSignature(parsePublicImageRun(value));
  if (next.next_job_index !== next.jobs.length || !new Set(["GROUPED_REPAIR", "STANDALONE_REPAIR"]).has(phase) || !Array.isArray(jobs) || !jobs.length) throw new TypeError("PUBLIC_IMAGE_JOB_APPEND_INVALID");
  next.jobs = [...next.jobs, ...jobs.map((job, offset) => normalizeJob(job, next.jobs.length + offset))];
  next.phase = phase;
  next.status = "GENERATING";
  next.failure = null;
  return parsePublicImageRun(next);
}

export function completePublicImageRun(value) {
  const next = cloneWithoutSignature(parsePublicImageRun(value));
  if (next.next_job_index !== next.jobs.length || unresolvedPublicImageUnitIds(next).length) throw new TypeError("PUBLIC_IMAGE_RUN_INCOMPLETE");
  next.phase = "COMPLETE";
  next.status = "COMPLETE";
  next.failure = null;
  return parsePublicImageRun(next);
}

export function exhaustPublicImageRun(value) {
  const next = cloneWithoutSignature(parsePublicImageRun(value));
  const unresolved = unresolvedPublicImageUnitIds(next);
  if (next.next_job_index !== next.jobs.length || !unresolved.length) throw new TypeError("PUBLIC_IMAGE_RUN_EXHAUST_INVALID");
  next.phase = "EXHAUSTED";
  next.status = "EXHAUSTED";
  next.failure = { code: `PUBLIC_IMAGE_REPAIR_EXHAUSTED:${unresolved.join(",")}`, unresolved_unit_ids: unresolved };
  return parsePublicImageRun(next);
}

export function unresolvedPublicImageUnitIds(value) {
  const parsed = parsePublicImageRun(value);
  const admitted = new Set(parsed.assets.map((asset) => asset.unit_id));
  return parsed.illustration_units.map((unit) => unit.unit_id).filter((unitId) => !admitted.has(unitId));
}

export function publicImageRunProgress(value, imagePriceCny = 0.22) {
  const parsed = parsePublicImageRun(value);
  const admitted = new Set(parsed.assets.map((asset) => asset.unit_id));
  const completedPages = Array.from({ length: parsed.final_page_count }, (_item, pageIndex) => parsed.illustration_units.filter((unit) => unit.page_index === pageIndex)).filter((units) => units.length > 0 && units.every((unit) => admitted.has(unit.unit_id))).length;
  return {
    resume_run_id: parsed.run_id,
    completed_pages: completedPages,
    total_pages: parsed.final_page_count,
    completed_image_steps: parsed.next_job_index,
    total_image_steps: parsed.jobs.length,
    failed_image_step: parsed.failure?.failed_job_index != null ? parsed.failure.failed_job_index + 1 : null,
    max_image_calls: parsed.max_image_calls,
    actual_image_calls: parsed.actual_image_calls,
    remaining_image_calls: parsed.max_image_calls - parsed.actual_image_calls,
    plan_exceeds_remaining_budget: Math.max(0, parsed.jobs.length - parsed.next_job_index) > parsed.max_image_calls - parsed.actual_image_calls,
    estimated_image_cost_cny: Number((parsed.actual_image_calls * Number(imagePriceCny || 0)).toFixed(2)),
  };
}
