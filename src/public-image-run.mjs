import { createDraftRecord, draftRecordToken } from "./workspace-state.mjs";

export const PUBLIC_IMAGE_RUN_SCHEMA = "xiaoshimei.public-image-run.v1";
export const PUBLIC_IMAGE_CALL_LIMIT = 6;
export const DRAFT_BOUND_IMAGE_OPERATION_SCHEMA = "xiaoshimei.draft-bound-image-operation.v1";

const PHASES = new Set(["PRIMARY", "GROUPED_REPAIR", "STANDALONE_REPAIR", "COMPLETE", "EXHAUSTED"]);
const STATUSES = new Set(["GENERATING", "IMAGE_CALL_IN_PROGRESS", "PARTIAL_FAILURE_RESUMABLE", "COMPLETE", "EXHAUSTED"]);
const MAX_CHECKPOINT_BYTES = 3_800_000;

function jsonClone(value, code) {
  try { return structuredClone(value); }
  catch { throw new TypeError(code); }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function confirmedCopyFromTextDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("IMAGE_OPERATION_TEXT_DRAFT_INVALID");
  return {
    source_input: typeof value.source_input === "string" ? value.source_input : "",
    pillar: typeof value.pillar === "string" ? value.pillar : "",
    goal: typeof value.goal === "string" ? value.goal : "",
    selected_title: typeof value.selected_title === "string" ? value.selected_title : "",
    body: typeof value.body === "string" ? value.body : "",
    tags: Array.isArray(value.tags) ? [...value.tags] : [],
  };
}

function confirmedCopyFromContent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("IMAGE_OPERATION_CONTENT_INVALID");
  return {
    source_input: typeof value.source_input === "string" ? value.source_input : "",
    pillar: typeof value.pillar === "string" ? value.pillar : "",
    goal: typeof value.goal === "string" ? value.goal : "",
    selected_title: typeof value.selectedTitle === "string" ? value.selectedTitle : "",
    body: typeof value.body === "string" ? value.body : "",
    tags: Array.isArray(value.tags) ? [...value.tags] : [],
  };
}

function normalizeOperationRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(code);
  try {
    return createDraftRecord({
      draftId: value.draft_id,
      contentPackage: value.content_package,
      generationSession: value.generation_session,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    });
  } catch (error) {
    throw new TypeError(`${code}:${error.message}`);
  }
}

export function parseDraftBoundImageOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== DRAFT_BOUND_IMAGE_OPERATION_SCHEMA) {
    throw new TypeError("IMAGE_OPERATION_INVALID");
  }
  const operationId = requiredString(value.operation_id, "IMAGE_OPERATION_ID_INVALID", 120);
  const targetDraftId = requiredString(value.target_draft_id, "IMAGE_OPERATION_DRAFT_ID_INVALID", 160);
  const recoveredDraftId = requiredString(value.recovered_draft_id, "IMAGE_OPERATION_RECOVERED_ID_INVALID", 160);
  if (recoveredDraftId === targetDraftId) throw new TypeError("IMAGE_OPERATION_RECOVERED_ID_INVALID");
  const record = normalizeOperationRecord(value.record_snapshot, "IMAGE_OPERATION_RECORD_INVALID");
  if (record.draft_id !== targetDraftId) throw new TypeError("IMAGE_OPERATION_DRAFT_ID_MISMATCH");
  if (typeof value.expected_draft_token !== "string" || value.expected_draft_token !== draftRecordToken(record)) {
    throw new TypeError("IMAGE_OPERATION_DRAFT_TOKEN_INVALID");
  }
  const session = record.generation_session;
  const textDraft = session?.text_draft;
  if (!textDraft || session.text_confirmed !== true) throw new TypeError("IMAGE_OPERATION_TEXT_NOT_CONFIRMED");
  const textDraftId = requiredString(value.text_draft_id, "IMAGE_OPERATION_TEXT_DRAFT_ID_INVALID", 160);
  if (textDraft.draft_id !== textDraftId) throw new TypeError("IMAGE_OPERATION_TEXT_DRAFT_ID_MISMATCH");
  if (session.assembled_draft_id != null && session.assembled_draft_id !== textDraftId) {
    throw new TypeError("IMAGE_OPERATION_SESSION_LINEAGE_INVALID");
  }
  const confirmedCopy = confirmedCopyFromTextDraft(textDraft);
  if (!exactJson(value.confirmed_copy, confirmedCopy)) throw new TypeError("IMAGE_OPERATION_COPY_SNAPSHOT_INVALID");
  const requestSnapshot = jsonClone(value.request_snapshot, "IMAGE_OPERATION_REQUEST_INVALID");
  if (!requestSnapshot || typeof requestSnapshot !== "object" || Array.isArray(requestSnapshot)) {
    throw new TypeError("IMAGE_OPERATION_REQUEST_INVALID");
  }
  return deepFreeze({
    schema: DRAFT_BOUND_IMAGE_OPERATION_SCHEMA,
    operation_id: operationId,
    target_draft_id: targetDraftId,
    recovered_draft_id: recoveredDraftId,
    text_draft_id: textDraftId,
    expected_draft_token: value.expected_draft_token,
    record_snapshot: record,
    confirmed_copy: confirmedCopy,
    request_snapshot: requestSnapshot,
  });
}

export function createDraftBoundImageOperation({
  operationId,
  sourceDraftRecord,
  requestSnapshot,
  recoveredDraftId = null,
} = {}) {
  const operation = requiredString(operationId, "IMAGE_OPERATION_ID_INVALID", 120);
  const record = normalizeOperationRecord(sourceDraftRecord, "IMAGE_OPERATION_RECORD_INVALID");
  const fallbackRecoveredId = `${record.draft_id}--recovered--${operation}`;
  const resolvedRecoveredId = recoveredDraftId == null ? fallbackRecoveredId : recoveredDraftId;
  const textDraft = record.generation_session?.text_draft;
  return parseDraftBoundImageOperation({
    schema: DRAFT_BOUND_IMAGE_OPERATION_SCHEMA,
    operation_id: operation,
    target_draft_id: record.draft_id,
    recovered_draft_id: resolvedRecoveredId,
    text_draft_id: textDraft?.draft_id,
    expected_draft_token: draftRecordToken(record),
    record_snapshot: record,
    confirmed_copy: confirmedCopyFromTextDraft(textDraft),
    request_snapshot: jsonClone(requestSnapshot, "IMAGE_OPERATION_REQUEST_INVALID"),
  });
}

export function claimDraftBoundImageOperation(currentOperation, nextOperation) {
  if (currentOperation != null) throw new TypeError("IMAGE_GENERATION_ALREADY_RUNNING");
  return parseDraftBoundImageOperation(nextOperation);
}

function operationSession(operation, imageResume, assembledDraftId) {
  return {
    ...jsonClone(operation.record_snapshot.generation_session, "IMAGE_OPERATION_SESSION_INVALID"),
    text_confirmed: true,
    assembled_draft_id: assembledDraftId,
    image_resume: imageResume == null ? null : jsonClone(imageResume, "IMAGE_OPERATION_RESUME_INVALID"),
  };
}

function operationRecord(operation, { draftId, contentPackage, imageResume, assembledDraftId, updatedAt, createdAt }) {
  return createDraftRecord({
    draftId,
    contentPackage,
    generationSession: operationSession(operation, imageResume, assembledDraftId),
    createdAt,
    updatedAt,
  });
}

function evolvedOperation(operation, record) {
  return parseDraftBoundImageOperation({
    ...operation,
    expected_draft_token: draftRecordToken(record),
    record_snapshot: record,
  });
}

function operationCoordinator(value) {
  if (!value || typeof value.mergeDraftCas !== "function") throw new TypeError("IMAGE_OPERATION_COORDINATOR_INVALID");
  return value;
}

function stoppedOperationResult(receipt, operation) {
  return {
    ...receipt,
    action: "STOP",
    operation,
    recovered_draft_id: receipt.recovered_draft?.draft_id || null,
  };
}

export async function persistDraftBoundImageProgress({
  operation: value,
  coordinator: coordinatorValue,
  imageResume,
  updatedAt = new Date().toISOString(),
} = {}) {
  const operation = parseDraftBoundImageOperation(value);
  const coordinator = operationCoordinator(coordinatorValue);
  const timestamp = requiredString(updatedAt, "IMAGE_OPERATION_UPDATED_AT_INVALID");
  if (!imageResume || typeof imageResume !== "object" || Array.isArray(imageResume)) throw new TypeError("IMAGE_OPERATION_RESUME_INVALID");
  const recovered = operationRecord(operation, {
    draftId: operation.recovered_draft_id,
    contentPackage: operation.record_snapshot.content_package,
    imageResume,
    assembledDraftId: operation.record_snapshot.generation_session.assembled_draft_id,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const receipt = await coordinator.mergeDraftCas({
    draftId: operation.target_draft_id,
    expectedDraftToken: operation.expected_draft_token,
    buildDraft: (target) => operationRecord(operation, {
      draftId: target.draft_id,
      contentPackage: target.content_package,
      imageResume,
      assembledDraftId: operation.record_snapshot.generation_session.assembled_draft_id,
      createdAt: target.created_at,
      updatedAt: timestamp,
    }),
    onConflict: () => recovered,
    reason: `IMAGE_PARTIAL:${operation.operation_id}`,
  });
  if (!receipt.ok || receipt.disposition === "RECOVERED_SIBLING_COMMITTED" || receipt.recovered_draft) {
    return stoppedOperationResult(receipt, operation);
  }
  if (!receipt.target_draft) return stoppedOperationResult({ ...receipt, ok: false, code: "IMAGE_OPERATION_READBACK_MISSING" }, operation);
  return {
    ...receipt,
    action: "CONTINUE",
    operation: evolvedOperation(operation, receipt.target_draft),
    recovered_draft_id: null,
  };
}

function assertCompletedContent(operation, contentPackage) {
  if (contentPackage?.generation?.source_draft_id !== operation.text_draft_id) {
    throw new TypeError("IMAGE_OPERATION_RESULT_LINEAGE_MISMATCH");
  }
  if (!exactJson(confirmedCopyFromContent(contentPackage), operation.confirmed_copy)) {
    throw new TypeError("IMAGE_OPERATION_RESULT_COPY_MISMATCH");
  }
}

export async function persistDraftBoundImageCompletion({
  operation: value,
  coordinator: coordinatorValue,
  contentPackage,
  updatedAt = new Date().toISOString(),
} = {}) {
  const operation = parseDraftBoundImageOperation(value);
  const coordinator = operationCoordinator(coordinatorValue);
  const resultContent = jsonClone(contentPackage, "IMAGE_OPERATION_CONTENT_INVALID");
  assertCompletedContent(operation, resultContent);
  const timestamp = requiredString(updatedAt, "IMAGE_OPERATION_UPDATED_AT_INVALID");
  const recovered = operationRecord(operation, {
    draftId: operation.recovered_draft_id,
    contentPackage: resultContent,
    imageResume: null,
    assembledDraftId: operation.text_draft_id,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const receipt = await coordinator.mergeDraftCas({
    draftId: operation.target_draft_id,
    expectedDraftToken: operation.expected_draft_token,
    buildDraft: (target) => operationRecord(operation, {
      draftId: target.draft_id,
      contentPackage: resultContent,
      imageResume: null,
      assembledDraftId: operation.text_draft_id,
      createdAt: target.created_at,
      updatedAt: timestamp,
    }),
    onConflict: () => recovered,
    reason: `IMAGE_COMPLETE:${operation.operation_id}`,
  });
  if (!receipt.ok) return stoppedOperationResult(receipt, operation);
  const committedRecord = receipt.recovered_draft || receipt.target_draft;
  if (!committedRecord) return stoppedOperationResult({ ...receipt, ok: false, code: "IMAGE_OPERATION_READBACK_MISSING" }, operation);
  if (committedRecord.generation_session?.assembled_draft_id !== operation.text_draft_id || committedRecord.generation_session?.image_resume != null) {
    return stoppedOperationResult({ ...receipt, ok: false, code: "IMAGE_OPERATION_FINAL_READBACK_MISMATCH" }, operation);
  }
  return {
    ...receipt,
    action: "COMPLETE",
    operation: receipt.target_draft ? evolvedOperation(operation, receipt.target_draft) : operation,
    recovered_draft_id: receipt.recovered_draft?.draft_id || null,
    adopt_current_ui: receipt.recovered_draft == null && receipt.workspace?.active_draft_id === operation.target_draft_id,
  };
}

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

export function completeCoveredNarrativePublicImageRun(value) {
  const parsed = parsePublicImageRun(value);
  if (parsed.production_mode !== "narrative" || parsed.status === "IMAGE_CALL_IN_PROGRESS" || parsed.status === "COMPLETE" || parsed.status === "EXHAUSTED") return null;

  const assetByUnitId = new Map(parsed.assets.map((asset) => [asset.unit_id, asset]));
  const completedUnitIds = new Set(parsed.jobs.slice(0, parsed.next_job_index).flatMap((job) => job.units.map((unit) => unit.unit_id)));
  const selectedUnits = [];
  for (let pageIndex = 0; pageIndex < parsed.final_page_count; pageIndex += 1) {
    const candidates = parsed.illustration_units
      .filter((unit) => unit.page_index === pageIndex && completedUnitIds.has(unit.unit_id) && assetByUnitId.has(unit.unit_id))
      .sort((left, right) => {
        const leftHero = left.panel_index == null ? 0 : 1;
        const rightHero = right.panel_index == null ? 0 : 1;
        return leftHero - rightHero || Number(left.panel_index ?? -1) - Number(right.panel_index ?? -1);
      });
    if (!candidates.length) return null;
    selectedUnits.push(candidates[0]);
  }

  const selectedIds = new Set(selectedUnits.map((unit) => unit.unit_id));
  const droppedUnitIds = parsed.illustration_units.map((unit) => unit.unit_id).filter((unitId) => !selectedIds.has(unitId));
  if (!droppedUnitIds.length) return null;

  const jobs = [];
  const jobIndexMap = new Map();
  parsed.jobs.slice(0, parsed.next_job_index).forEach((job, oldIndex) => {
    const units = job.units.filter((unit) => selectedIds.has(unit.unit_id));
    if (!units.length) return;
    jobIndexMap.set(oldIndex, jobs.length);
    jobs.push({ ...job, units, unit_labels: Array.isArray(job.unit_labels) ? job.unit_labels.slice(0, units.length) : job.unit_labels });
  });
  if (!jobs.length) return null;

  const jobAttempts = parsed.job_attempts
    .filter((attempt) => jobIndexMap.has(attempt.job_index))
    .map((attempt) => {
      const jobIndex = jobIndexMap.get(attempt.job_index);
      const units = jobs[jobIndex].units;
      return {
        ...attempt,
        job_index: jobIndex,
        admitted_unit_ids: units.map((unit) => unit.unit_id),
        missing_unit_ids: [],
        decision: "ASSETS_ADMITTED",
        zero_provider_normalization: "NARRATIVE_ONE_ASSET_PER_PAGE",
        dropped_unit_ids: droppedUnitIds,
      };
    });

  const normalized = parsePublicImageRun({
    ...cloneWithoutSignature(parsed),
    final_pages: parsed.final_pages.map((page) => ({ ...page, panels: [] })),
    illustration_units: selectedUnits,
    jobs,
    next_job_index: jobs.length,
    assets: parsed.assets.filter((asset) => selectedIds.has(asset.unit_id)),
    job_attempts: jobAttempts,
    phase: "PRIMARY",
    status: "GENERATING",
    failure: null,
  });
  return completePublicImageRun(normalized);
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
