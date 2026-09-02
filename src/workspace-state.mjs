import { generateContentPackage, importLocalEditableDraft, parseContentPackage } from "./content-engine.mjs";
import { assertActionReferenceManifestBatch } from "./action-reference-media.mjs";
import { GENERATION_SESSION_SCHEMA, parseGenerationSession } from "./generation-session.mjs";
import { normalizeProfileV2, parseProfileV2 } from "./profile-v2.mjs";
import { canonicalImageGenerationInputPreimage } from "./provider-contract.mjs";

export const WORKSPACE_BACKUP_SCHEMA = "xiaoshimei.workspace-backup.v1";
export const WORKSPACE_BACKUP_V2_SCHEMA = "xiaoshimei.workspace-backup.v2";
export const WORKSPACE_BACKUP_V3_SCHEMA = "xiaoshimei.workspace-backup.v3";
export const WORKSPACE_ENVELOPE_SCHEMA = "xiaoshimei.workspace-envelope.v2";
export const WORKSPACE_ENVELOPE_V3_SCHEMA = "xiaoshimei.workspace-envelope.v3";
export const WORKSPACE_ENVELOPE_V3_STORAGE_KEY = "xiaoshimei-studio.workspace.v3";
export const DRAFT_RECORD_SCHEMA = "xiaoshimei.draft-record.v2";
export const DRAFT_RECORD_V3_SCHEMA = "xiaoshimei.draft-record.v3";
export const PENDING_IMAGE_OPERATION_SCHEMA = "xiaoshimei.pending-image-operation.v1";
export const AUTHORING_SESSION_SCHEMA = "xiaoshimei.authoring-session.v2";
export const WORKSPACE_V3_RECOVERY_PRECONDITION_SCHEMA = "xiaoshimei.workspace-v3-recovery-precondition.v1";
export const WORKSPACE_LOCK_NAME = "xiaoshimei.workspace-envelope.v2.writer";
export const WORKSPACE_ABSENT_TOKEN = "xiaoshimei.workspace-envelope.absent";
export const WORKSPACE_V3_ABSENT_TOKEN = "xiaoshimei.workspace-envelope.v3.absent";

const LOCAL_AUTHORITY_EFFECT = "LOCAL_EDITING_ONLY";
// v1 allowed one current draft plus 50 library entries. A mismatched legacy
// content/session pair needs one extra record during repair; never evict either
// side merely to fit the old split-store limit.
const MAX_DRAFT_RECORDS = 100;

function normalizeAuthoringActionReferences(value, path) {
  try {
    return assertActionReferenceManifestBatch(value == null ? [] : value);
  } catch (error) {
    throw new TypeError(`${path}: ${error.message}`);
  }
}

function normalizeAuthoringActionReferenceNote(value, path) {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > 2_000) throw new TypeError(`${path}: ACTION_REFERENCE_NOTE_INVALID`);
  return value;
}

function checkedContent(value, path) {
  try { return parseContentPackage(JSON.stringify(value)); }
  catch (error) { throw new TypeError(`${path}: ${error.message}`); }
}

function importedContent(value, path) {
  try { return importLocalEditableDraft(JSON.stringify(value)); }
  catch (error) { throw new TypeError(`${path}: ${error.message}`); }
}

function checkedGenerationSession(value, path) {
  if (value == null) return null;
  let source = value;
  if (typeof value === "string") {
    try { source = JSON.parse(value); }
    catch { throw new TypeError(`${path}: generation session is not valid JSON`); }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError(`${path}: generation session is invalid`);
  try {
    const actionReferenceManifest = normalizeAuthoringActionReferences(
      source.action_reference_manifest,
      `${path}.action_reference_manifest`,
    );
    const actionReferenceNote = normalizeAuthoringActionReferenceNote(
      source.action_reference_note,
      `${path}.action_reference_note`,
    );
    if (source.text_draft != null) {
      const parsed = parseGenerationSession({ ...source, schema: GENERATION_SESSION_SCHEMA });
      return {
        ...parsed,
        schema: AUTHORING_SESSION_SCHEMA,
        action_reference_manifest: actionReferenceManifest,
        action_reference_note: actionReferenceNote,
      };
    }
    if (![AUTHORING_SESSION_SCHEMA, GENERATION_SESSION_SCHEMA].includes(source.schema)) {
      throw new TypeError("GENERATION_SESSION_INVALID");
    }
    if (source.image_resume != null) throw new TypeError("GENERATION_SESSION_RESUME_REQUIRES_TEXT_DRAFT");
    return {
      schema: AUTHORING_SESSION_SCHEMA,
      topic: String(source.topic || ""),
      pillar: String(source.pillar || "wellness"),
      goal: String(source.goal || "save"),
      text_requirements: String(source.text_requirements || ""),
      text_draft: null,
      text_confirmed: false,
      assembled_draft_id: null,
      image_count_mode: source.image_count_mode === "CUSTOM" ? "CUSTOM" : "AUTO",
      custom_image_count: Math.max(1, Math.min(8, Number(source.custom_image_count) || 5)),
      production_mode: ["smart", "narrative", "infographic"].includes(source.production_mode) ? source.production_mode : "smart",
      image_resume: null,
      action_reference_manifest: actionReferenceManifest,
      action_reference_note: actionReferenceNote,
    };
  } catch (error) {
    throw new TypeError(`${path}: ${error.message}`);
  }
}

function toLegacyGenerationSession(value) {
  const session = checkedGenerationSession(value, "generation_session");
  if (session == null || session.text_draft == null) return null;
  return parseGenerationSession({ ...session, schema: GENERATION_SESSION_SCHEMA });
}

export function normalizeAuthoringSession(value) {
  return checkedGenerationSession(value, "generation_session");
}

function requiredString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${path} is required`);
  return value.trim();
}

function normalizeDraftRecord(value, path, { importContent = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== DRAFT_RECORD_SCHEMA) {
    throw new TypeError(`${path} schema is not supported`);
  }
  const contentParser = importContent ? importedContent : checkedContent;
  return {
    schema: DRAFT_RECORD_SCHEMA,
    draft_id: requiredString(value.draft_id, `${path}.draft_id`),
    created_at: requiredString(value.created_at, `${path}.created_at`),
    updated_at: requiredString(value.updated_at, `${path}.updated_at`),
    content_package: contentParser(value.content_package, `${path}.content_package`),
    generation_session: checkedGenerationSession(value.generation_session, `${path}.generation_session`),
  };
}

function normalizeWorkspaceEnvelope(value, { importContent = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== WORKSPACE_ENVELOPE_SCHEMA) {
    throw new TypeError("workspace envelope schema is not supported");
  }
  if (value.authority_effect !== LOCAL_AUTHORITY_EFFECT) throw new TypeError("workspace envelope cannot carry authority");
  if (!Array.isArray(value.drafts) || value.drafts.length < 1 || value.drafts.length > MAX_DRAFT_RECORDS) {
    throw new TypeError(`workspace envelope must contain 1-${MAX_DRAFT_RECORDS} drafts`);
  }
  const drafts = value.drafts.map((draft, index) => normalizeDraftRecord(draft, `drafts[${index}]`, { importContent }));
  const ids = new Set(drafts.map((draft) => draft.draft_id));
  if (ids.size !== drafts.length) throw new TypeError("workspace envelope draft ids must be unique");
  const activeDraftId = requiredString(value.active_draft_id, "active_draft_id");
  if (!ids.has(activeDraftId)) throw new TypeError("active_draft_id must reference an existing draft");
  return {
    schema: WORKSPACE_ENVELOPE_SCHEMA,
    authority_effect: LOCAL_AUTHORITY_EFFECT,
    updated_at: requiredString(value.updated_at, "updated_at"),
    profile: normalizeProfileV2(value.profile),
    active_draft_id: activeDraftId,
    drafts,
  };
}

function workspaceFromNormalized({ profile, activeDraftId, drafts, updatedAt }) {
  return {
    schema: WORKSPACE_ENVELOPE_SCHEMA,
    authority_effect: LOCAL_AUTHORITY_EFFECT,
    updated_at: updatedAt,
    profile,
    active_draft_id: activeDraftId,
    drafts,
  };
}

export function createDraftRecord({
  draftId,
  contentPackage,
  generationSession = null,
  createdAt = new Date().toISOString(),
  updatedAt = createdAt,
}) {
  return normalizeDraftRecord({
    schema: DRAFT_RECORD_SCHEMA,
    draft_id: draftId,
    created_at: createdAt,
    updated_at: updatedAt,
    content_package: contentPackage,
    generation_session: generationSession,
  }, "draft_record");
}

export function buildWorkspaceEnvelope({ profile, activeDraftId, drafts, updatedAt = new Date().toISOString() }) {
  return normalizeWorkspaceEnvelope({
    schema: WORKSPACE_ENVELOPE_SCHEMA,
    authority_effect: LOCAL_AUTHORITY_EFFECT,
    updated_at: updatedAt,
    profile,
    active_draft_id: activeDraftId,
    drafts,
  });
}

export function parseWorkspaceEnvelope(value) {
  let source = value;
  if (typeof value === "string") {
    try { source = JSON.parse(value); }
    catch { throw new TypeError("workspace envelope is not valid JSON"); }
  }
  return normalizeWorkspaceEnvelope(source);
}

export function workspaceEnvelopeToken(value) {
  return value == null ? WORKSPACE_ABSENT_TOKEN : JSON.stringify(parseWorkspaceEnvelope(value));
}

export function draftRecordToken(value) {
  if (value == null) return null;
  const record = value?.schema === DRAFT_RECORD_V3_SCHEMA
    ? normalizeDraftRecordV3(value, "draft_record")
    : normalizeDraftRecord(value, "draft_record");
  const content = structuredClone(record.content_package);
  // DraftRecord identity lives in draft_id. Saving to the asset library may
  // add id/saved_at and refresh timestamps without changing the author's copy,
  // pages, generation parameters or resume state; those bookkeeping fields
  // must not turn ordinary navigation into a paid-result conflict.
  delete content.id;
  delete content.saved_at;
  return JSON.stringify({
    schema: record.schema,
    draft_id: record.draft_id,
    content_package: content,
    generation_session: record.generation_session,
    ...(record.schema === DRAFT_RECORD_V3_SCHEMA ? { pending_image_operation: record.pending_image_operation } : {}),
  });
}

function imageBootstrapComparableDraftTokenV3(value) {
  const record = parseDraftRecordV3(value);
  const generationSession = record.generation_session == null
    ? null
    : { ...record.generation_session, image_resume: null };
  return draftRecordToken(createDraftRecordV3({
    draftId: record.draft_id,
    contentPackage: record.content_package,
    generationSession,
    pendingImageOperation: null,
    createdAt: record.created_at,
    updatedAt: record.created_at,
  }));
}

export function imageBootstrapRebaseAllowedV3({ latestDraft, desiredDraft, targetDraftId, operationNonce } = {}) {
  try {
    const latest = parseDraftRecordV3(latestDraft);
    const desired = parseDraftRecordV3(desiredDraft);
    const targetId = requiredString(targetDraftId, "targetDraftId");
    const nonce = exactSha256(operationNonce, "operationNonce");
    if (latest.draft_id !== targetId || desired.draft_id !== targetId) return false;
    if (latest.pending_image_operation != null) return false;
    if (desired.pending_image_operation?.operation_nonce !== nonce) return false;
    return imageBootstrapComparableDraftTokenV3(latest) === imageBootstrapComparableDraftTokenV3(desired);
  } catch {
    return false;
  }
}

export function authoringSessionForDraftSnapshotV3({ generationSession, draftRecord } = {}) {
  const record = parseDraftRecordV3(draftRecord);
  if (generationSession == null) return null;
  const durableImageResume = record.pending_image_operation == null
    ? null
    : record.generation_session?.image_resume ?? null;
  return normalizeAuthoringSession({ ...generationSession, image_resume: durableImageResume });
}

export function draftContentWithPreservedBookkeepingV3({ contentPackage, draftRecord } = {}) {
  const desired = checkedContent(contentPackage, "contentPackage");
  const source = parseDraftRecordV3(draftRecord).content_package;
  const savedAt = [source.saved_at, desired.saved_at]
    .filter((value) => typeof value === "string" && value)
    .sort()
    .at(-1);
  return checkedContent({
    ...desired,
    ...(source.id || desired.id ? { id: source.id || desired.id } : {}),
    ...(savedAt ? { saved_at: savedAt } : {}),
  }, "contentPackage");
}

export function draftAutosaveRequiredV3({ baseDraft, candidateDraft } = {}) {
  const base = parseDraftRecordV3(baseDraft);
  const candidate = parseDraftRecordV3(candidateDraft);
  if (base.draft_id !== candidate.draft_id) throw new TypeError("AUTOSAVE_DRAFT_ID_MISMATCH");
  return draftRecordToken(base) !== draftRecordToken(candidate);
}

export function activeDraftRecord(value) {
  const workspace = parseWorkspaceEnvelope(value);
  return workspace.drafts.find((draft) => draft.draft_id === workspace.active_draft_id);
}

function libraryContentsFromNormalized(workspace) {
  return workspace.drafts
    .filter((draft) => Boolean(draft.content_package.saved_at) || (
      /^image-recovery-[0-9a-f]{32}$/.test(draft.draft_id)
      && draft.pending_image_operation == null
      && draft.generation_session?.text_confirmed === true
      && draft.content_package.generation?.source_draft_id === draft.generation_session?.assembled_draft_id
    ))
    .map((draft) => ({
      ...draft.content_package,
      draft_record_id: draft.draft_id,
      id: draft.content_package.id || draft.draft_id,
      saved_at: draft.content_package.saved_at || draft.updated_at,
    }));
}

export function libraryContents(value) {
  return libraryContentsFromNormalized(parseWorkspaceEnvelope(value));
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function sessionMatchesContent(session, contentPackage) {
  if (session == null) return true;
  if (session.text_draft == null) {
    return session.topic === contentPackage.source_input
      && session.pillar === contentPackage.pillar
      && session.goal === contentPackage.goal;
  }
  const draft = session.text_draft;
  return session.assembled_draft_id === draft.draft_id
    && draft.source_input === contentPackage.source_input
    && draft.pillar === contentPackage.pillar
    && draft.goal === contentPackage.goal
    && draft.selected_title === contentPackage.selectedTitle
    && draft.body === contentPackage.body
    && arraysEqual(draft.tags, contentPackage.tags);
}

function uniqueDraftId(candidate, usedIds) {
  const base = requiredString(candidate, "draftId");
  if (!usedIds.has(base)) return base;
  let suffix = 2;
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function authoringContentForSession(session) {
  const sourceInput = session.text_draft?.source_input || session.topic;
  const pillar = session.text_draft?.pillar || session.pillar;
  const goal = session.text_draft?.goal || session.goal;
  const blank = generateContentPackage({ topic: "", pillar, goal });
  return checkedContent({ ...blank, source_input: sourceInput, pillar, goal }, "authoring_content");
}

export function migrateLegacyWorkspaceState({
  profile,
  currentContent,
  library = [],
  generationSession = null,
  activeDraftId,
  createdAt = new Date().toISOString(),
}) {
  if (!Array.isArray(library) || library.length > 50) throw new TypeError("library must contain at most 50 drafts");
  const current = checkedContent(currentContent, "current_content");
  const session = checkedGenerationSession(generationSession, "generation_session");
  const requestedActiveId = requiredString(activeDraftId || current.id || session?.text_draft?.draft_id, "activeDraftId");
  const usedIds = new Set();
  const drafts = [];
  let resolvedActiveId;

  if (session != null && !sessionMatchesContent(session, current)) {
    const contentId = uniqueDraftId(current.id || `${requestedActiveId}-content`, usedIds);
    usedIds.add(contentId);
    const savedContent = checkedContent({
      ...current,
      id: current.id || contentId,
      saved_at: current.saved_at || createdAt,
    }, "current_content");
    const authoringId = uniqueDraftId(session.text_draft?.draft_id || `${requestedActiveId}-authoring`, usedIds);
    usedIds.add(authoringId);
    resolvedActiveId = authoringId;
    drafts.push(
      createDraftRecord({
        draftId: authoringId,
        contentPackage: authoringContentForSession(session),
        generationSession: session,
        createdAt,
        updatedAt: createdAt,
      }),
      createDraftRecord({
        draftId: contentId,
        contentPackage: savedContent,
        generationSession: null,
        createdAt: savedContent.saved_at,
        updatedAt: savedContent.saved_at,
      }),
    );
  } else {
    const currentId = uniqueDraftId(requestedActiveId, usedIds);
    usedIds.add(currentId);
    resolvedActiveId = currentId;
    drafts.push(createDraftRecord({
      draftId: currentId,
      contentPackage: current,
      generationSession: session,
      createdAt: current.saved_at || createdAt,
      updatedAt: current.saved_at || createdAt,
    }));
  }

  library.forEach((item, index) => {
    const content = checkedContent(item, `library[${index}]`);
    const sourceId = String(content.id || `legacy-library-${index + 1}`).trim();
    const duplicate = drafts.find((draft) => draft.draft_id === sourceId && draft.content_package.source_input === content.source_input);
    if (duplicate) return;
    const draftId = uniqueDraftId(sourceId, usedIds);
    usedIds.add(draftId);
    const savedContent = checkedContent({
      ...content,
      id: content.id || draftId,
      saved_at: content.saved_at || createdAt,
    }, `library[${index}]`);
    drafts.push(createDraftRecord({
      draftId,
      contentPackage: savedContent,
      generationSession: null,
      createdAt: savedContent.saved_at,
      updatedAt: savedContent.saved_at,
    }));
  });
  return buildWorkspaceEnvelope({ profile, activeDraftId: resolvedActiveId, drafts, updatedAt: createdAt });
}

export function legacyStateFromWorkspaceEnvelope(value) {
  const workspace = parseWorkspaceEnvelope(value);
  return legacyStateFromNormalized(workspace);
}

function legacyStateFromNormalized(workspace) {
  const active = workspace.drafts.find((draft) => draft.draft_id === workspace.active_draft_id);
  return {
    activeDraftId: workspace.active_draft_id,
    profile: workspace.profile,
    currentContent: active.content_package,
    // Existing consumers only understand generation-session.v1. A source-only
    // authoring session remains solely in the v2 envelope until text exists.
    generationSession: toLegacyGenerationSession(active.generation_session),
    authoringSession: active.generation_session,
    library: libraryContentsFromNormalized(workspace),
  };
}

export function beginNewDraft(value, {
  draftId,
  newDraftId,
  createdAt,
  savedAt,
  currentContent,
  currentSession,
  contentPackage = generateContentPackage({ topic: "", pillar: "wellness", goal: "save" }),
} = {}) {
  const timestamp = savedAt || createdAt || new Date().toISOString();
  let workspace = parseWorkspaceEnvelope(value);
  const currentRecord = workspace.drafts.find((draft) => draft.draft_id === workspace.active_draft_id);
  const snapshotContent = currentContent === undefined ? currentRecord.content_package : currentContent;
  const snapshotSession = currentSession === undefined ? currentRecord.generation_session : currentSession;
  const checkedSnapshotContent = checkedContent(snapshotContent, "current_content");
  const checkedSnapshotSession = checkedGenerationSession(snapshotSession, "generation_session");
  const hasWorkToPreserve = Boolean(
    checkedSnapshotContent.id
    || checkedSnapshotContent.saved_at
    || String(checkedSnapshotContent.source_input || "").trim()
    || checkedSnapshotContent.generation?.mode === "PROVIDER"
    || String(checkedSnapshotSession?.topic || "").trim()
    || checkedSnapshotSession?.text_draft
  );
  if (hasWorkToPreserve) {
    workspace = saveDraftRecord(workspace, {
      contentPackage: {
        ...checkedSnapshotContent,
        id: checkedSnapshotContent.id || currentRecord.draft_id,
        saved_at: checkedSnapshotContent.saved_at || timestamp,
      },
      generationSession: checkedSnapshotSession,
      updatedAt: timestamp,
    });
  }
  const nextDraftId = requiredString(newDraftId || draftId, "draftId");
  if (workspace.drafts.some((draft) => draft.draft_id === nextDraftId)) throw new TypeError("draftId already exists");
  if (workspace.drafts.length >= MAX_DRAFT_RECORDS) throw new TypeError("workspace draft limit reached");
  const fresh = createDraftRecord({
    draftId: nextDraftId,
    contentPackage,
    generationSession: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const nextWorkspace = workspaceFromNormalized({
    profile: workspace.profile,
    activeDraftId: nextDraftId,
    drafts: [fresh, ...workspace.drafts],
    updatedAt: timestamp,
  });
  return {
    workspace: nextWorkspace,
    previousDraftId: workspace.active_draft_id,
    activeDraft: fresh,
  };
}

export function activateDraftRecord(value, draftId, { activatedAt = new Date().toISOString() } = {}) {
  const workspace = parseWorkspaceEnvelope(value);
  const nextDraftId = requiredString(draftId, "draftId");
  const activeDraft = workspace.drafts.find((draft) => draft.draft_id === nextDraftId);
  if (!activeDraft) throw new TypeError("draftId does not exist");
  return {
    workspace: workspaceFromNormalized({
      profile: workspace.profile,
      activeDraftId: nextDraftId,
      drafts: workspace.drafts,
      updatedAt: activatedAt,
    }),
    previousDraftId: workspace.active_draft_id,
    activeDraft,
  };
}

export function saveDraftRecord(value, {
  draftId,
  contentPackage,
  generationSession,
  updatedAt = new Date().toISOString(),
}) {
  const workspace = parseWorkspaceEnvelope(value);
  const targetId = requiredString(draftId || workspace.active_draft_id, "draftId");
  const index = workspace.drafts.findIndex((draft) => draft.draft_id === targetId);
  if (index < 0) throw new TypeError("draftId does not exist");
  const previous = workspace.drafts[index];
  const replacement = createDraftRecord({
    draftId: targetId,
    contentPackage: contentPackage === undefined ? previous.content_package : contentPackage,
    generationSession: generationSession === undefined ? previous.generation_session : generationSession,
    createdAt: previous.created_at,
    updatedAt,
  });
  const drafts = [...workspace.drafts];
  drafts[index] = replacement;
  return workspaceFromNormalized({
    profile: workspace.profile,
    activeDraftId: workspace.active_draft_id,
    drafts,
    updatedAt,
  });
}

export function saveActiveDraft(value, { contentPackage, generationSession, savedAt = new Date().toISOString() }) {
  return saveDraftRecord(value, { contentPackage, generationSession, updatedAt: savedAt });
}

export const replaceActiveDraft = saveActiveDraft;

export function saveWorkspaceProfile(value, profile, { updatedAt = new Date().toISOString() } = {}) {
  const workspace = parseWorkspaceEnvelope(value);
  return workspaceFromNormalized({
    profile: normalizeProfileV2(profile),
    activeDraftId: workspace.active_draft_id,
    drafts: workspace.drafts,
    updatedAt,
  });
}

function legacyArkSourceProjection(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[。！？!?]+$/, "")
    .trim();
}

function exactStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function canRepairLegacyArkSource(record) {
  const content = record.content_package;
  const session = record.generation_session;
  const draft = session?.text_draft;
  const generation = content?.generation;
  if (!draft || session.text_confirmed !== true) return false;
  if (session.assembled_draft_id !== draft.draft_id) return false;
  if (generation?.mode !== "PROVIDER" || generation.provider !== "volcengine-ark") return false;
  if (generation.strategy !== "resumable_public_image_steps_v1") return false;
  if (generation.source_draft_id !== draft.draft_id) return false;
  if (
    content.pillar !== draft.pillar
    || content.goal !== draft.goal
    || content.selectedTitle !== draft.selected_title
    || content.body !== draft.body
    || !exactStringArray(content.tags, draft.tags)
  ) return false;
  if (content.source_input === draft.source_input) return false;
  return content.source_input === legacyArkSourceProjection(draft.source_input);
}

// Repairs only the one known, paid Ark producer projection bug. This is a pure
// transition: callers must commit it through fullCas so a concurrent workspace
// change produces zero writes.
export function repairLegacyArkSourceProjections(value, { updatedAt = new Date().toISOString() } = {}) {
  const workspace = parseWorkspaceEnvelope(value);
  const repairedDraftIds = [];
  const drafts = workspace.drafts.map((record) => {
    if (!canRepairLegacyArkSource(record)) return record;
    repairedDraftIds.push(record.draft_id);
    return createDraftRecord({
      draftId: record.draft_id,
      contentPackage: { ...record.content_package, source_input: record.generation_session.text_draft.source_input },
      generationSession: record.generation_session,
      createdAt: record.created_at,
      updatedAt,
    });
  });
  if (!repairedDraftIds.length) return { workspace, repaired: false, repaired_draft_ids: [] };
  return {
    workspace: workspaceFromNormalized({
      profile: workspace.profile,
      activeDraftId: workspace.active_draft_id,
      drafts,
      updatedAt,
    }),
    repaired: true,
    repaired_draft_ids: repairedDraftIds,
  };
}

export function buildWorkspaceBackupV2({ workspace, createdAt = new Date().toISOString() }) {
  const checked = parseWorkspaceEnvelope(workspace);
  return {
    schema: WORKSPACE_BACKUP_V2_SCHEMA,
    created_at: requiredString(createdAt, "createdAt"),
    authority_effect: LOCAL_AUTHORITY_EFFECT,
    workspace: checked,
  };
}

export function parseWorkspaceBackupV2(serialized) {
  let value = serialized;
  if (typeof serialized === "string") {
    try { value = JSON.parse(serialized); }
    catch { throw new TypeError("workspace backup is not valid JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== WORKSPACE_BACKUP_V2_SCHEMA) {
    throw new TypeError("workspace backup schema is not supported");
  }
  if (value.authority_effect !== LOCAL_AUTHORITY_EFFECT) throw new TypeError("workspace backup cannot carry authority");
  requiredString(value.created_at, "created_at");
  return normalizeWorkspaceEnvelope(value.workspace, { importContent: true });
}

export function buildWorkspaceBackup({ profile, currentContent, library = [], createdAt = new Date().toISOString() }) {
  if (!Array.isArray(library) || library.length > 50) throw new TypeError("library must contain at most 50 drafts");
  if (typeof createdAt !== "string" || !createdAt.trim()) throw new TypeError("createdAt is required");
  return {
    schema: WORKSPACE_BACKUP_SCHEMA,
    created_at: createdAt,
    authority_effect: "LOCAL_EDITING_ONLY",
    profile: normalizeProfileV2(profile),
    current_content: checkedContent(currentContent, "current_content"),
    library: library.map((item, index) => checkedContent(item, `library[${index}]`)),
  };
}

export function parseWorkspaceBackup(serialized) {
  let value;
  try { value = JSON.parse(serialized); }
  catch { throw new TypeError("workspace backup is not valid JSON"); }
  if (value?.schema === WORKSPACE_BACKUP_V2_SCHEMA) {
    const workspaceEnvelope = parseWorkspaceBackupV2(value);
    return { ...legacyStateFromWorkspaceEnvelope(workspaceEnvelope), workspaceEnvelope };
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== WORKSPACE_BACKUP_SCHEMA) {
    throw new TypeError("workspace backup schema is not supported");
  }
  if (value.authority_effect !== "LOCAL_EDITING_ONLY") throw new TypeError("workspace backup cannot carry authority");
  if (!Array.isArray(value.library) || value.library.length > 50) throw new TypeError("workspace backup library is invalid");
  const profile = parseProfileV2(JSON.stringify(value.profile));
  const currentContent = importLocalEditableDraft(JSON.stringify(value.current_content));
  const library = value.library.map((item) => importLocalEditableDraft(JSON.stringify(item)));
  return { profile, currentContent, library };
}

function atomicStorageWrite(storage, entries, successCode) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw new TypeError("storage adapter is invalid");
  }
  const keys = entries.map(({ key }) => requiredString(key, "storage key"));
  if (new Set(keys).size !== keys.length) throw new TypeError("storage keys must be unique");
  let before;
  try {
    // Read every preimage before the first mutation. A failed read therefore
    // cannot leave a half-written workspace.
    before = keys.map((key) => [key, storage.getItem(key)]);
  } catch (error) {
    return { ok: false, code: "STORAGE_READ_FAILED", message: String(error?.message || error) };
  }
  try {
    entries.forEach(({ key, serialized, remove = false }) => {
      if (remove) {
        if (typeof storage.removeItem !== "function") throw new TypeError("storage adapter cannot remove items");
        storage.removeItem(key);
      } else {
        storage.setItem(key, serialized);
      }
    });
    return { ok: true, code: successCode };
  } catch (error) {
    let rollbackFailed = false;
    [...before].reverse().forEach(([key, serialized]) => {
      try {
        if (serialized == null) {
          if (typeof storage.removeItem !== "function") throw new TypeError("storage adapter cannot remove items");
          storage.removeItem(key);
        } else {
          storage.setItem(key, serialized);
        }
      } catch { rollbackFailed = true; }
    });
    return {
      ok: false,
      code: rollbackFailed ? "STORAGE_ROLLBACK_FAILED" : "STORAGE_WRITE_FAILED",
      message: String(error?.message || error),
    };
  }
}

export function loadWorkspaceEnvelope(storage, key) {
  try { return parseWorkspaceEnvelope(storage?.getItem(key)); }
  catch { return null; }
}

function readStoredJson(storage, key, { fallback, required = false } = {}) {
  const serialized = storage.getItem(requiredString(key, "storage key"));
  if (serialized == null) {
    if (required) throw new TypeError(`${key} is missing`);
    return fallback;
  }
  try { return JSON.parse(serialized); }
  catch { throw new TypeError(`${key} is not valid JSON`); }
}

export function loadOrMigrateWorkspaceEnvelope(storage, keys, {
  activeDraftId,
  createdAt = new Date().toISOString(),
  fallbackContent,
  fallbackLibrary = [],
  fallbackProfile,
  fallbackGenerationSession = null,
} = {}) {
  if (!storage || typeof storage.getItem !== "function") throw new TypeError("storage adapter is invalid");
  if (!keys || typeof keys !== "object") throw new TypeError("workspace storage keys are required");
  const envelopeKey = requiredString(keys.envelope, "keys.envelope");
  const serializedEnvelope = storage.getItem(envelopeKey);
  if (serializedEnvelope != null) {
    return { workspace: parseWorkspaceEnvelope(serializedEnvelope), migrated: false, source: "V2_ENVELOPE" };
  }
  const currentContent = readStoredJson(storage, keys.content, { fallback: fallbackContent, required: fallbackContent === undefined });
  const library = readStoredJson(storage, keys.library, { fallback: fallbackLibrary });
  const profile = readStoredJson(storage, keys.profile, { fallback: fallbackProfile, required: fallbackProfile === undefined });
  const storedGenerationSession = storage.getItem(requiredString(keys.generationSession, "keys.generationSession"));
  const generationSession = storedGenerationSession == null
    ? fallbackGenerationSession
    : checkedGenerationSession(storedGenerationSession, "generation_session");
  return {
    workspace: migrateLegacyWorkspaceState({
      profile,
      currentContent,
      library,
      generationSession,
      activeDraftId: activeDraftId || currentContent?.id || "legacy-active-draft",
      createdAt,
    }),
    migrated: true,
    source: "LEGACY_SPLIT_KEYS",
  };
}

export const loadOrMigrateWorkspace = loadOrMigrateWorkspaceEnvelope;

export function persistWorkspaceEnvelope(storage, value, keys) {
  const workspace = parseWorkspaceEnvelope(value);
  if (!keys || typeof keys !== "object") throw new TypeError("workspace storage keys are required");
  const envelopeKey = requiredString(keys.envelope, "keys.envelope");
  const legacyNames = ["content", "library", "profile", "generationSession"];
  const suppliedLegacyNames = legacyNames.filter((name) => typeof keys[name] === "string" && keys[name].trim());
  if (suppliedLegacyNames.length > 0 && suppliedLegacyNames.length !== legacyNames.length) {
    throw new TypeError("legacy mirror requires content, library, profile and generationSession keys");
  }
  const entries = [{ key: envelopeKey, serialized: JSON.stringify(workspace) }];
  if (suppliedLegacyNames.length) {
    const legacy = legacyStateFromNormalized(workspace);
    entries.push(
      { key: keys.content, serialized: JSON.stringify(legacy.currentContent) },
      { key: keys.library, serialized: JSON.stringify(legacy.library) },
      { key: keys.profile, serialized: JSON.stringify(legacy.profile) },
      legacy.generationSession == null
        ? { key: keys.generationSession, remove: true }
        : { key: keys.generationSession, serialized: JSON.stringify(legacy.generationSession) },
    );
  }
  return atomicStorageWrite(storage, entries, "WORKSPACE_ENVELOPE_SAVED");
}

export function persistDraftRecordWithReadback(storage, value, keys, {
  draftId,
  contentPackage,
  generationSession,
  updatedAt = new Date().toISOString(),
} = {}) {
  const next = saveDraftRecord(value, {
    draftId,
    contentPackage,
    generationSession,
    updatedAt,
  });
  const persisted = persistWorkspaceEnvelope(storage, next, keys);
  if (!persisted.ok) return { ...persisted, workspace: null, draft_record: null };
  const readback = loadWorkspaceEnvelope(storage, keys.envelope);
  if (!readback) {
    return { ok: false, code: "WORKSPACE_READBACK_FAILED", workspace: null, draft_record: null };
  }
  if (JSON.stringify(readback) !== JSON.stringify(next)) {
    return { ok: false, code: "WORKSPACE_READBACK_MISMATCH", workspace: readback, draft_record: null };
  }
  const targetId = draftId || readback.active_draft_id;
  const record = readback.drafts.find((item) => item.draft_id === targetId) || null;
  if (!record) {
    return { ok: false, code: "WORKSPACE_DRAFT_READBACK_MISSING", workspace: readback, draft_record: null };
  }
  return {
    ok: true,
    code: "WORKSPACE_DRAFT_SAVED_AND_VERIFIED",
    workspace: readback,
    draft_record: record,
  };
}

export function readWorkspaceSnapshot(storage, envelopeKey) {
  if (!storage || typeof storage.getItem !== "function") {
    return { ok: false, code: "STORAGE_ADAPTER_INVALID", workspace: null, workspace_token: null };
  }
  let serialized;
  try {
    serialized = storage.getItem(requiredString(envelopeKey, "storage key"));
  } catch (error) {
    return {
      ok: false,
      code: "STORAGE_READ_FAILED",
      message: String(error?.message || error),
      workspace: null,
      workspace_token: null,
    };
  }
  if (serialized == null) {
    return { ok: true, code: "WORKSPACE_ABSENT", workspace: null, workspace_token: WORKSPACE_ABSENT_TOKEN };
  }
  try {
    const workspace = parseWorkspaceEnvelope(serialized);
    return {
      ok: true,
      code: "WORKSPACE_SNAPSHOT_READ",
      workspace,
      workspace_token: workspaceEnvelopeToken(workspace),
    };
  } catch (error) {
    return {
      ok: false,
      code: "WORKSPACE_ENVELOPE_INVALID",
      message: String(error?.message || error),
      workspace: null,
      workspace_token: null,
    };
  }
}

function transactionReceipt({ ok, code, disposition, snapshot, targetDraftId = null, recoveredDraftId = null, reason = null, message = null }) {
  const workspace = snapshot?.workspace || null;
  const activeDraft = workspace?.drafts.find((draft) => draft.draft_id === workspace.active_draft_id) || null;
  const targetDraft = targetDraftId == null
    ? null
    : workspace?.drafts.find((draft) => draft.draft_id === targetDraftId) || null;
  const recoveredDraft = recoveredDraftId == null
    ? null
    : workspace?.drafts.find((draft) => draft.draft_id === recoveredDraftId) || null;
  return {
    ok,
    code,
    disposition,
    reason,
    ...(message == null ? {} : { message }),
    workspace,
    workspace_token: snapshot?.workspace_token || null,
    active_draft: activeDraft,
    target_draft: targetDraft,
    target_draft_token: targetDraft == null ? null : draftRecordToken(targetDraft),
    recovered_draft: recoveredDraft,
  };
}

function syncBuilderResult(value, code) {
  if (value && typeof value.then === "function") throw new TypeError(code);
  return value;
}

function workspaceStorageKeys(keys) {
  if (!keys || typeof keys !== "object") throw new TypeError("workspace storage keys are required");
  const normalized = { ...keys, envelope: requiredString(keys.envelope, "keys.envelope") };
  const legacyNames = ["content", "library", "profile", "generationSession"];
  const supplied = legacyNames.filter((name) => typeof normalized[name] === "string" && normalized[name].trim());
  if (supplied.length > 0 && supplied.length !== legacyNames.length) {
    throw new TypeError("legacy mirror requires content, library, profile and generationSession keys");
  }
  return normalized;
}

// The coordinator is the only cross-tab-safe mutation surface. Web Locks
// serialize the complete read/check/write/readback critical section; the v2
// envelope remains the sole workspace authority.
export function createWorkspaceCoordinator({
  storage,
  keys,
  lockManager = globalThis.navigator?.locks,
  lockName = WORKSPACE_LOCK_NAME,
} = {}) {
  const normalizedKeys = workspaceStorageKeys(keys);
  const normalizedLockName = requiredString(lockName, "lockName");

  function snapshot() {
    return readWorkspaceSnapshot(storage, normalizedKeys.envelope);
  }

  async function underExclusiveLock(callback) {
    if (!lockManager || typeof lockManager.request !== "function") {
      return transactionReceipt({
        ok: false,
        code: "WORKSPACE_LOCK_UNAVAILABLE",
        disposition: "NO_WRITE_LOCK_UNAVAILABLE",
        snapshot: snapshot(),
      });
    }
    try {
      return await lockManager.request.call(lockManager, normalizedLockName, { mode: "exclusive" }, callback);
    } catch (error) {
      return transactionReceipt({
        ok: false,
        code: "WORKSPACE_LOCK_FAILED",
        disposition: "NO_WRITE_LOCK_FAILED",
        snapshot: snapshot(),
        message: String(error?.message || error),
      });
    }
  }

  function persistAndReadback(nextWorkspace, { targetDraftId = null, recoveredDraftId = null, reason = null, disposition = "COMMITTED" } = {}) {
    const expectedToken = workspaceEnvelopeToken(nextWorkspace);
    let persisted;
    try {
      persisted = persistWorkspaceEnvelope(storage, nextWorkspace, normalizedKeys);
    } catch (error) {
      return transactionReceipt({
        ok: false,
        code: "WORKSPACE_PERSIST_FAILED",
        disposition: "NO_WRITE_PERSIST_FAILED",
        snapshot: snapshot(),
        targetDraftId,
        recoveredDraftId,
        reason,
        message: String(error?.message || error),
      });
    }
    if (!persisted.ok) {
      return transactionReceipt({
        ok: false,
        code: persisted.code,
        disposition: "NO_WRITE_PERSIST_FAILED",
        snapshot: snapshot(),
        targetDraftId,
        recoveredDraftId,
        reason,
        message: persisted.message,
      });
    }
    const readback = snapshot();
    if (!readback.ok) {
      return transactionReceipt({
        ok: false,
        code: "WORKSPACE_READBACK_FAILED",
        disposition: "WRITE_READBACK_FAILED",
        snapshot: readback,
        targetDraftId,
        recoveredDraftId,
        reason,
        message: readback.message,
      });
    }
    if (readback.workspace_token !== expectedToken) {
      return transactionReceipt({
        ok: false,
        code: "WORKSPACE_READBACK_MISMATCH",
        disposition: "WRITE_READBACK_MISMATCH",
        snapshot: readback,
        targetDraftId,
        recoveredDraftId,
        reason,
      });
    }
    return transactionReceipt({
      ok: true,
      code: "WORKSPACE_COMMITTED_AND_VERIFIED",
      disposition,
      snapshot: readback,
      targetDraftId,
      recoveredDraftId,
      reason,
    });
  }

  async function fullCas({ expectedWorkspaceToken, workspace, buildWorkspace, reason = "FULL_CAS" } = {}) {
    if (typeof expectedWorkspaceToken !== "string" || !expectedWorkspaceToken) throw new TypeError("expectedWorkspaceToken is required");
    if (workspace === undefined && typeof buildWorkspace !== "function") throw new TypeError("workspace or buildWorkspace is required");
    return underExclusiveLock(() => {
      const latest = snapshot();
      if (!latest.ok) {
        return transactionReceipt({ ok: false, code: latest.code, disposition: "NO_WRITE_READ_FAILED", snapshot: latest, reason, message: latest.message });
      }
      if (latest.workspace_token !== expectedWorkspaceToken) {
        return transactionReceipt({ ok: false, code: "WORKSPACE_CAS_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason });
      }
      let candidate = workspace;
      if (typeof buildWorkspace === "function") {
        candidate = syncBuilderResult(buildWorkspace(latest.workspace), "WORKSPACE_ASYNC_BUILDER_FORBIDDEN");
      }
      const nextWorkspace = parseWorkspaceEnvelope(candidate);
      if (workspaceEnvelopeToken(nextWorkspace) === latest.workspace_token) {
        return transactionReceipt({ ok: true, code: "WORKSPACE_ALREADY_CURRENT", disposition: "NOOP_ALREADY_APPLIED", snapshot: latest, reason });
      }
      return persistAndReadback(nextWorkspace, { reason, disposition: "COMMITTED" });
    });
  }

  async function mergeDraftCas({
    draftId,
    expectedDraftToken,
    buildDraft,
    replacementDraft,
    requireActiveDraftId = null,
    onConflict = null,
    reason = "TARGET_MERGE",
  } = {}) {
    const targetId = requiredString(draftId, "draftId");
    if (typeof expectedDraftToken !== "string" || !expectedDraftToken) throw new TypeError("expectedDraftToken is required");
    if (replacementDraft === undefined && typeof buildDraft !== "function") throw new TypeError("replacementDraft or buildDraft is required");
    if (onConflict != null && typeof onConflict !== "function") throw new TypeError("onConflict must be a function");
    return underExclusiveLock(() => {
      const latest = snapshot();
      if (!latest.ok || !latest.workspace) {
        return transactionReceipt({ ok: false, code: latest.ok ? "WORKSPACE_MISSING" : latest.code, disposition: "NO_WRITE_READ_FAILED", snapshot: latest, targetDraftId: targetId, reason, message: latest.message });
      }
      if (requireActiveDraftId != null && latest.workspace.active_draft_id !== requireActiveDraftId) {
        return transactionReceipt({ ok: false, code: "WORKSPACE_ACTIVE_DRAFT_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, reason });
      }
      const targetIndex = latest.workspace.drafts.findIndex((draft) => draft.draft_id === targetId);
      const target = targetIndex < 0 ? null : latest.workspace.drafts[targetIndex];
      const targetMatches = target != null && draftRecordToken(target) === expectedDraftToken;

      if (!targetMatches) {
        if (onConflict == null) {
          return transactionReceipt({ ok: false, code: "WORKSPACE_DRAFT_CAS_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, reason });
        }
        const siblingValue = syncBuilderResult(onConflict({ workspace: latest.workspace, target_draft: target }), "WORKSPACE_ASYNC_CONFLICT_BUILDER_FORBIDDEN");
        if (siblingValue == null) {
          return transactionReceipt({ ok: false, code: "WORKSPACE_DRAFT_CAS_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, reason });
        }
        const sibling = normalizeDraftRecord(siblingValue, "recovered_draft");
        const existingSibling = latest.workspace.drafts.find((draft) => draft.draft_id === sibling.draft_id);
        if (existingSibling) {
          if (draftRecordToken(existingSibling) !== draftRecordToken(sibling)) {
            return transactionReceipt({ ok: false, code: "WORKSPACE_RECOVERED_DRAFT_COLLISION", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, recoveredDraftId: sibling.draft_id, reason });
          }
          return transactionReceipt({ ok: true, code: "WORKSPACE_RECOVERED_DRAFT_ALREADY_PRESENT", disposition: "NOOP_ALREADY_APPLIED", snapshot: latest, targetDraftId: targetId, recoveredDraftId: sibling.draft_id, reason });
        }
        if (latest.workspace.drafts.length >= MAX_DRAFT_RECORDS) {
          return transactionReceipt({ ok: false, code: "WORKSPACE_DRAFT_LIMIT_REACHED", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, recoveredDraftId: sibling.draft_id, reason });
        }
        const recoveredWorkspace = workspaceFromNormalized({
          profile: latest.workspace.profile,
          activeDraftId: latest.workspace.active_draft_id,
          drafts: [sibling, ...latest.workspace.drafts],
          updatedAt: sibling.updated_at,
        });
        return persistAndReadback(recoveredWorkspace, {
          targetDraftId: targetId,
          recoveredDraftId: sibling.draft_id,
          reason,
          disposition: "RECOVERED_SIBLING_COMMITTED",
        });
      }

      let candidate = replacementDraft;
      if (typeof buildDraft === "function") {
        candidate = syncBuilderResult(buildDraft(target, latest.workspace), "WORKSPACE_ASYNC_BUILDER_FORBIDDEN");
      }
      const replacement = normalizeDraftRecord(candidate, "replacement_draft");
      if (replacement.draft_id !== targetId) throw new TypeError("replacement draft identity cannot change");
      if (replacement.created_at !== target.created_at) throw new TypeError("replacement draft creation time cannot change");
      if (draftRecordToken(replacement) === expectedDraftToken) {
        return transactionReceipt({ ok: true, code: "WORKSPACE_DRAFT_ALREADY_CURRENT", disposition: "NOOP_ALREADY_APPLIED", snapshot: latest, targetDraftId: targetId, reason });
      }
      const drafts = [...latest.workspace.drafts];
      drafts[targetIndex] = replacement;
      const nextWorkspace = workspaceFromNormalized({
        profile: latest.workspace.profile,
        activeDraftId: latest.workspace.active_draft_id,
        drafts,
        updatedAt: replacement.updated_at,
      });
      return persistAndReadback(nextWorkspace, { targetDraftId: targetId, reason, disposition: "COMMITTED" });
    });
  }

  async function repairLegacyArkSourceCas({ expectedWorkspaceToken, updatedAt = new Date().toISOString() } = {}) {
    let repair = null;
    const receipt = await fullCas({
      expectedWorkspaceToken,
      reason: "LEGACY_ARK_SOURCE_REPAIR",
      buildWorkspace: (latest) => {
        if (latest == null) throw new TypeError("WORKSPACE_MISSING");
        repair = repairLegacyArkSourceProjections(latest, { updatedAt });
        return repair.workspace;
      },
    });
    return {
      ...receipt,
      repaired: Boolean(repair?.repaired && receipt.ok),
      repaired_draft_ids: receipt.ok ? (repair?.repaired_draft_ids || []) : [],
    };
  }

  return Object.freeze({
    snapshot,
    fullCas,
    mergeDraftCas,
    repairLegacyArkSourceCas,
  });
}

export function persistWorkspaceState(storage, state, keys) {
  const entries = [
    { key: keys.content, serialized: JSON.stringify(state.currentContent) },
    { key: keys.library, serialized: JSON.stringify(state.library) },
    { key: keys.profile, serialized: JSON.stringify(state.profile) },
  ];
  return atomicStorageWrite(storage, entries, "WORKSPACE_SAVED");
}

export function prepareFreshDraftWorkspace({ currentContent, library = [], profile, draftId, savedAt }) {
  if (!Array.isArray(library)) throw new TypeError("library must be an array");
  const current = checkedContent(currentContent, "current_content");
  const fresh = generateContentPackage({ topic: "", pillar: "wellness", goal: "save" });
  const hasWorkToPreserve = Boolean(
    current.id
    || current.saved_at
    || String(current.source_input || "").trim()
    || current.generation?.mode === "PROVIDER"
  );
  if (!hasWorkToPreserve) return { currentContent: fresh, library: [...library], profile, preservedPrevious: false };
  if (typeof draftId !== "string" || !draftId.trim()) throw new TypeError("draftId is required when preserving the current draft");
  if (typeof savedAt !== "string" || !savedAt.trim()) throw new TypeError("savedAt is required when preserving the current draft");
  const preserved = { ...current, id: current.id || draftId, saved_at: current.saved_at || savedAt };
  const nextLibrary = [preserved, ...library.filter((item) => item.id !== preserved.id)].slice(0, 50);
  return { currentContent: fresh, library: nextLibrary, profile, preservedPrevious: true };
}

// D36 workspace v3 is intentionally parallel to the v2 surface above. The v2
// localStorage key is a byte-for-byte rollback preimage; v3 writers never
// project refs or sessions back into it.
const MEDIA_REF_PREFIX = "xiaoshimei-media://sha256/";
const MEDIA_REF_RE = /^xiaoshimei-media:\/\/sha256\/([0-9a-f]{64})$/;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const V3_IMAGE_CALL_LIMIT = 6;
const PENDING_PROTOCOL_STATES = new Set(["BOOTSTRAP", "PLANNING", "READY", "IN_FLIGHT", "PARTIAL", "UNKNOWN"]);
const PENDING_ALLOWED_KEYS = new Set([
  "schema",
  "operation_nonce",
  "operation_snapshot",
  "operation_snapshot_hash",
  "input_hash",
  "ordered_reference_manifest",
  "materialized_media_manifest",
  "protocol_state",
  "run_id",
  "checkpoint_preimage_hash",
  "checkpoint_hash",
  "logical_step_id",
  "attempt_nonce",
  "completed_image_steps",
  "total_image_steps",
  "updated_at",
]);
const V3_IMAGE_RESUME_ALLOWED_KEYS = new Set([
  "resume_run_id",
  "completed_mother_sheets",
  "completed_image_steps",
  "total_image_steps",
  "max_image_calls",
  "actual_image_calls",
  "remaining_image_calls",
  "checkpoint_preimage_hash",
  "checkpoint_hash",
  "logical_step_id",
  "attempt_nonce",
  "local_media_refs",
  "status",
  "failure_code",
]);

function optionalString(value, code, max = 240) {
  if (value == null || value === "") return null;
  const text = requiredString(value, code);
  if (text.length > max) throw new TypeError(code);
  return text;
}

function exactSha256(value, code) {
  const text = requiredString(value, code);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new TypeError(code);
  return text;
}

function assertPersistentRefOnly(value, code = "WORKSPACE_V3_INLINE_MEDIA_FORBIDDEN") {
  const visit = (node) => {
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (/^data:[a-z]+\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(trimmed) || /^blob:(?:https?:\/\/|null\/)/i.test(trimmed)) {
        throw new TypeError(code);
      }
      if (trimmed.startsWith("xiaoshimei-media://") && !MEDIA_REF_RE.test(trimmed)) {
        throw new TypeError("WORKSPACE_V3_MEDIA_REF_INVALID");
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) node.forEach(visit);
    else Object.values(node).forEach(visit);
  };
  visit(value);
}

function normalizeMediaManifest(value, path = "media_manifest") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path.toUpperCase()}_INVALID`);
  const mediaRef = requiredString(value.media_ref, `${path}.media_ref`);
  const match = MEDIA_REF_RE.exec(mediaRef);
  if (!match) throw new TypeError(`${path.toUpperCase()}_REFERENCE_INVALID`);
  const sha256 = exactSha256(value.sha256, `${path}.sha256`);
  if (match[1] !== sha256) throw new TypeError(`${path.toUpperCase()}_HASH_MISMATCH`);
  const sizeBytes = Number(value.size_bytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 20_000_000) throw new TypeError(`${path.toUpperCase()}_SIZE_INVALID`);
  const mime = requiredString(value.mime || value.mime_type, `${path}.mime`).toLowerCase();
  if (!IMAGE_MIMES.has(mime)) throw new TypeError(`${path.toUpperCase()}_MIME_INVALID`);
  const name = optionalString(value.name, `${path}.name`, 240) || `${sha256.slice(0, 12)}.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`;
  return { media_ref: mediaRef, sha256, size_bytes: sizeBytes, mime, name };
}

function normalizeManifestArray(value, path) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 64) throw new TypeError(`${path.toUpperCase()}_INVALID`);
  const manifests = value.map((item, index) => normalizeMediaManifest(item, `${path}[${index}]`));
  const refs = manifests.map((item) => item.media_ref);
  if (new Set(refs).size !== refs.length) throw new TypeError(`${path.toUpperCase()}_DUPLICATE`);
  return manifests;
}

function normalizePendingImageOperation(value, path = "pending_image_operation") {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== PENDING_IMAGE_OPERATION_SCHEMA) {
    throw new TypeError("PENDING_IMAGE_OPERATION_INVALID");
  }
  Object.keys(value).forEach((key) => {
    if (!PENDING_ALLOWED_KEYS.has(key)) throw new TypeError(`PENDING_IMAGE_OPERATION_FIELD_FORBIDDEN:${key}`);
  });
  const protocolState = requiredString(value.protocol_state, `${path}.protocol_state`);
  if (!PENDING_PROTOCOL_STATES.has(protocolState)) throw new TypeError("PENDING_IMAGE_OPERATION_STATE_INVALID");
  const completed = value.completed_image_steps == null ? null : Number(value.completed_image_steps);
  const total = value.total_image_steps == null ? null : Number(value.total_image_steps);
  if (completed != null && (!Number.isInteger(completed) || completed < 0)) throw new TypeError("PENDING_IMAGE_OPERATION_PROGRESS_INVALID");
  if (total != null && (!Number.isInteger(total) || total < 0 || (completed != null && completed > total))) {
    throw new TypeError("PENDING_IMAGE_OPERATION_PROGRESS_INVALID");
  }
  let canonicalInput;
  try {
    canonicalInput = JSON.parse(canonicalImageGenerationInputPreimage({
      operation_snapshot: value.operation_snapshot,
      reference_manifest: value.ordered_reference_manifest,
    }));
  } catch (error) {
    throw new TypeError(`PENDING_IMAGE_OPERATION_INPUT_INVALID:${error.message}`);
  }
  const normalized = {
    schema: PENDING_IMAGE_OPERATION_SCHEMA,
    operation_nonce: exactSha256(value.operation_nonce, `${path}.operation_nonce`),
    operation_snapshot: canonicalInput.operation_snapshot,
    operation_snapshot_hash: exactSha256(value.operation_snapshot_hash, `${path}.operation_snapshot_hash`),
    input_hash: exactSha256(value.input_hash, `${path}.input_hash`),
    ordered_reference_manifest: canonicalInput.reference_manifest,
    materialized_media_manifest: normalizeManifestArray(value.materialized_media_manifest, "pending_image_operation_media"),
    protocol_state: protocolState,
    run_id: optionalString(value.run_id, `${path}.run_id`, 160),
    checkpoint_preimage_hash: value.checkpoint_preimage_hash == null ? null : exactSha256(value.checkpoint_preimage_hash, `${path}.checkpoint_preimage_hash`),
    checkpoint_hash: value.checkpoint_hash == null ? null : exactSha256(value.checkpoint_hash, `${path}.checkpoint_hash`),
    logical_step_id: optionalString(value.logical_step_id, `${path}.logical_step_id`, 160),
    attempt_nonce: optionalString(value.attempt_nonce, `${path}.attempt_nonce`, 160),
    completed_image_steps: completed,
    total_image_steps: total,
    updated_at: optionalString(value.updated_at, `${path}.updated_at`, 80),
  };
  assertPersistentRefOnly(normalized, "PENDING_IMAGE_OPERATION_REFERENCE_INVALID");
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > 128_000) {
    throw new TypeError("PENDING_IMAGE_OPERATION_TOO_LARGE");
  }
  return normalized;
}

export function normalizeV3ImageResume(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("WORKSPACE_V3_IMAGE_RESUME_INVALID");
  Object.keys(value).forEach((key) => {
    if (!V3_IMAGE_RESUME_ALLOWED_KEYS.has(key)) throw new TypeError(`WORKSPACE_V3_IMAGE_RESUME_FIELD_FORBIDDEN:${key}`);
  });
  const normalized = {};
  const copyText = (key, max = 160) => {
    if (value[key] != null) {
      const text = requiredString(value[key], `image_resume.${key}`);
      if (text.length > max) throw new TypeError(`WORKSPACE_V3_IMAGE_RESUME_${key.toUpperCase()}_INVALID`);
      normalized[key] = text;
    }
  };
  const copyCount = (key) => {
    if (value[key] == null) return;
    const number = Number(value[key]);
    if (!Number.isInteger(number) || number < 0) throw new TypeError(`WORKSPACE_V3_IMAGE_RESUME_${key.toUpperCase()}_INVALID`);
    normalized[key] = number;
  };
  copyText("resume_run_id");
  ["completed_mother_sheets", "completed_image_steps", "total_image_steps", "max_image_calls", "actual_image_calls", "remaining_image_calls"].forEach(copyCount);
  if (normalized.max_image_calls != null && normalized.max_image_calls !== V3_IMAGE_CALL_LIMIT) {
    throw new TypeError("WORKSPACE_V3_IMAGE_RESUME_CALL_LIMIT_INVALID");
  }
  if (
    normalized.actual_image_calls != null
    && normalized.max_image_calls != null
    && normalized.actual_image_calls > normalized.max_image_calls
  ) throw new TypeError("WORKSPACE_V3_IMAGE_RESUME_CALL_EVIDENCE_INVALID");
  if (
    normalized.remaining_image_calls != null
    && normalized.max_image_calls != null
    && normalized.actual_image_calls != null
    && normalized.remaining_image_calls !== normalized.max_image_calls - normalized.actual_image_calls
  ) throw new TypeError("WORKSPACE_V3_IMAGE_RESUME_CALL_EVIDENCE_INVALID");
  ["checkpoint_preimage_hash", "checkpoint_hash"].forEach((key) => {
    if (value[key] != null) normalized[key] = exactSha256(value[key], `image_resume.${key}`);
  });
  ["logical_step_id", "attempt_nonce", "status", "failure_code"].forEach((key) => copyText(key, 240));
  if (value.local_media_refs != null) {
    if (!Array.isArray(value.local_media_refs) || value.local_media_refs.length > 64) throw new TypeError("WORKSPACE_V3_IMAGE_RESUME_REFS_INVALID");
    normalized.local_media_refs = value.local_media_refs.map((ref) => {
      const text = requiredString(ref, "image_resume.local_media_ref");
      if (!MEDIA_REF_RE.test(text)) throw new TypeError("WORKSPACE_V3_IMAGE_RESUME_REF_INVALID");
      return text;
    });
    if (new Set(normalized.local_media_refs).size !== normalized.local_media_refs.length) throw new TypeError("WORKSPACE_V3_IMAGE_RESUME_REFS_DUPLICATE");
  }
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > 64_000) throw new TypeError("WORKSPACE_V3_IMAGE_RESUME_TOO_LARGE");
  return normalized;
}

export function createPendingImageOperation({
  operationNonce,
  operationSnapshot,
  operationSnapshotHash,
  inputHash,
  orderedReferenceManifest = [],
  materializedMediaManifest = [],
  protocolState,
  runId = null,
  checkpointPreimageHash = null,
  checkpointHash = null,
  logicalStepId = null,
  attemptNonce = null,
  completedImageSteps = null,
  totalImageSteps = null,
  updatedAt = null,
} = {}) {
  return normalizePendingImageOperation({
    schema: PENDING_IMAGE_OPERATION_SCHEMA,
    operation_nonce: operationNonce,
    operation_snapshot: operationSnapshot,
    operation_snapshot_hash: operationSnapshotHash,
    input_hash: inputHash,
    ordered_reference_manifest: orderedReferenceManifest,
    materialized_media_manifest: materializedMediaManifest,
    protocol_state: protocolState,
    run_id: runId,
    checkpoint_preimage_hash: checkpointPreimageHash,
    checkpoint_hash: checkpointHash,
    logical_step_id: logicalStepId,
    attempt_nonce: attemptNonce,
    completed_image_steps: completedImageSteps,
    total_image_steps: totalImageSteps,
    updated_at: updatedAt,
  });
}

export async function createRestartablePendingImageOperationV3(input = {}) {
  const canonicalInput = canonicalImageGenerationInputPreimage({
    operation_snapshot: input.operationSnapshot,
    reference_manifest: input.orderedReferenceManifest || [],
  });
  const canonical = JSON.parse(canonicalInput);
  const operationSnapshotHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(canonical.operation_snapshot)));
  const inputHash = await sha256Hex(new TextEncoder().encode(canonicalInput));
  if (input.operationSnapshotHash != null && input.operationSnapshotHash !== operationSnapshotHash) {
    throw new TypeError("PENDING_IMAGE_OPERATION_SNAPSHOT_HASH_MISMATCH");
  }
  if (input.inputHash != null && input.inputHash !== inputHash) throw new TypeError("PENDING_IMAGE_OPERATION_INPUT_HASH_MISMATCH");
  return createPendingImageOperation({
    ...input,
    operationSnapshot: canonical.operation_snapshot,
    orderedReferenceManifest: canonical.reference_manifest,
    operationSnapshotHash,
    inputHash,
  });
}

function normalizeDraftRecordV3(value, path, { importContent = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== DRAFT_RECORD_V3_SCHEMA) {
    throw new TypeError(`${path} schema is not supported`);
  }
  const contentParser = importContent ? importedContent : checkedContent;
  const generationSession = checkedGenerationSession(value.generation_session, `${path}.generation_session`);
  const record = {
    schema: DRAFT_RECORD_V3_SCHEMA,
    draft_id: requiredString(value.draft_id, `${path}.draft_id`),
    created_at: requiredString(value.created_at, `${path}.created_at`),
    updated_at: requiredString(value.updated_at, `${path}.updated_at`),
    content_package: contentParser(value.content_package, `${path}.content_package`),
    generation_session: generationSession == null
      ? null
      : { ...generationSession, image_resume: normalizeV3ImageResume(generationSession.image_resume) },
    pending_image_operation: normalizePendingImageOperation(value.pending_image_operation, `${path}.pending_image_operation`),
  };
  if (record.generation_session?.image_resume != null && record.pending_image_operation == null) {
    throw new TypeError("WORKSPACE_V3_PENDING_OPERATION_REQUIRED");
  }
  assertPersistentRefOnly(record);
  return record;
}

export function createDraftRecordV3({
  draftId,
  contentPackage,
  generationSession = null,
  pendingImageOperation = null,
  createdAt = new Date().toISOString(),
  updatedAt = createdAt,
} = {}) {
  return normalizeDraftRecordV3({
    schema: DRAFT_RECORD_V3_SCHEMA,
    draft_id: draftId,
    created_at: createdAt,
    updated_at: updatedAt,
    content_package: contentPackage,
    generation_session: generationSession,
    pending_image_operation: pendingImageOperation,
  }, "draft_record");
}

export function parseDraftRecordV3(value) {
  return normalizeDraftRecordV3(value, "draft_record");
}

function normalizeLegacyV2Source(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("legacy_v2_source is invalid");
  const sha256 = exactSha256(value.sha256, "legacy_v2_source.sha256");
  const byteLength = Number(value.byte_length);
  if (!Number.isInteger(byteLength) || byteLength < 1) throw new TypeError("legacy_v2_source.byte_length is invalid");
  const token = requiredString(value.token, "legacy_v2_source.token");
  if (token !== `sha256:${sha256}:${byteLength}`) throw new TypeError("legacy_v2_source.token is invalid");
  return { token, sha256, byte_length: byteLength };
}

function normalizeWorkspaceEnvelopeV3(value, { importContent = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== WORKSPACE_ENVELOPE_V3_SCHEMA) {
    throw new TypeError("workspace v3 envelope schema is not supported");
  }
  if (value.authority_effect !== LOCAL_AUTHORITY_EFFECT) throw new TypeError("workspace v3 envelope cannot carry authority");
  if (!Array.isArray(value.drafts) || value.drafts.length < 1 || value.drafts.length > MAX_DRAFT_RECORDS) {
    throw new TypeError(`workspace v3 envelope must contain 1-${MAX_DRAFT_RECORDS} drafts`);
  }
  const drafts = value.drafts.map((draft, index) => normalizeDraftRecordV3(draft, `drafts[${index}]`, { importContent }));
  const ids = new Set(drafts.map((draft) => draft.draft_id));
  if (ids.size !== drafts.length) throw new TypeError("workspace v3 envelope draft ids must be unique");
  const activeDraftId = requiredString(value.active_draft_id, "active_draft_id");
  if (!ids.has(activeDraftId)) throw new TypeError("active_draft_id must reference an existing v3 draft");
  const previousDraftId = value.previous_draft_id == null
    ? null
    : requiredString(value.previous_draft_id, "previous_draft_id");
  if (previousDraftId != null && (!ids.has(previousDraftId) || previousDraftId === activeDraftId)) {
    throw new TypeError("previous_draft_id must reference a different existing v3 draft");
  }
  const workspace = {
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: LOCAL_AUTHORITY_EFFECT,
    updated_at: requiredString(value.updated_at, "updated_at"),
    profile: normalizeProfileV2(value.profile),
    active_draft_id: activeDraftId,
    previous_draft_id: previousDraftId,
    drafts,
    legacy_v2_source: normalizeLegacyV2Source(value.legacy_v2_source),
  };
  assertPersistentRefOnly(workspace);
  return workspace;
}

export function parseWorkspaceEnvelopeV3(value) {
  let source = value;
  if (typeof value === "string") {
    try { source = JSON.parse(value); }
    catch { throw new TypeError("workspace v3 envelope is not valid JSON"); }
  }
  return normalizeWorkspaceEnvelopeV3(source);
}

export function buildWorkspaceEnvelopeV3({
  profile,
  activeDraftId,
  previousDraftId = null,
  drafts,
  legacyV2Source = null,
  updatedAt = new Date().toISOString(),
}) {
  return normalizeWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: LOCAL_AUTHORITY_EFFECT,
    updated_at: updatedAt,
    profile,
    active_draft_id: activeDraftId,
    previous_draft_id: previousDraftId,
    drafts,
    legacy_v2_source: legacyV2Source,
  });
}

export function workspaceEnvelopeV3Token(value) {
  return value == null ? WORKSPACE_V3_ABSENT_TOKEN : JSON.stringify(parseWorkspaceEnvelopeV3(value));
}

export function activeDraftRecordV3(value) {
  const workspace = parseWorkspaceEnvelopeV3(value);
  return workspace.drafts.find((draft) => draft.draft_id === workspace.active_draft_id);
}

function imageRecoveryDraftIdV3(operationNonce) {
  return `image-recovery-${exactSha256(operationNonce, "operationNonce").slice(0, 32)}`;
}

export function imageOperationAuthorityV3(value, { activeDraftId = null } = {}) {
  const workspace = parseWorkspaceEnvelopeV3(value);
  const sourceId = requiredString(activeDraftId || workspace.active_draft_id, "activeDraftId");
  const active = workspace.drafts.find((draft) => draft.draft_id === sourceId);
  if (!active) throw new TypeError("IMAGE_OPERATION_SOURCE_DRAFT_MISSING");

  const recoveries = workspace.drafts.filter((draft) => {
    const pending = draft.pending_image_operation;
    return pending != null
      && draft.draft_id === imageRecoveryDraftIdV3(pending.operation_nonce)
      && pending.operation_snapshot?.draft_record_id === sourceId;
  });
  if (recoveries.length > 1) throw new TypeError("IMAGE_OPERATION_AUTHORITY_AMBIGUOUS");
  if (recoveries.length === 1) {
    const recovery = recoveries[0];
    if (active.pending_image_operation != null
      && active.pending_image_operation.operation_nonce !== recovery.pending_image_operation.operation_nonce) {
      throw new TypeError("IMAGE_OPERATION_AUTHORITY_AMBIGUOUS");
    }
    return Object.freeze({
      source_draft_id: sourceId,
      holder_draft_id: recovery.draft_id,
      location: active.pending_image_operation == null ? "RECOVERY" : "RECOVERY_DUPLICATE_SOURCE_PENDING",
      record: recovery,
    });
  }
  if (active.pending_image_operation == null) return null;
  return Object.freeze({
    source_draft_id: sourceId,
    holder_draft_id: sourceId,
    location: "ACTIVE",
    record: active,
  });
}

export function libraryContentsV3(value) {
  return libraryContentsFromNormalized(parseWorkspaceEnvelopeV3(value));
}

export function reconcilePersistentLibraryView({
  persistentLibrary = [],
  currentLibrary = [],
  activeDraftId = null,
  currentContent = null,
} = {}) {
  return persistentLibrary.map((item) => {
    const isActiveSavedRecord = item.draft_record_id === activeDraftId
      && currentContent?.saved_at === item.saved_at;
    if (isActiveSavedRecord) {
      return {
        ...currentContent,
        draft_record_id: item.draft_record_id,
        id: item.id,
        saved_at: item.saved_at,
      };
    }
    const cached = currentLibrary.find((entry) => entry.draft_record_id === item.draft_record_id);
    return cached?.saved_at === item.saved_at ? cached : item;
  });
}

function v3WorkspaceFromNormalized({
  workspace,
  activeDraftId = workspace.active_draft_id,
  previousDraftId = workspace.previous_draft_id,
  drafts = workspace.drafts,
  profile = workspace.profile,
  updatedAt,
}) {
  return buildWorkspaceEnvelopeV3({
    profile,
    activeDraftId,
    previousDraftId,
    drafts,
    legacyV2Source: workspace.legacy_v2_source,
    updatedAt,
  });
}

export function saveDraftRecordV3(value, options = {}) {
  const workspace = parseWorkspaceEnvelopeV3(value);
  const targetId = requiredString(options.draftId || workspace.active_draft_id, "draftId");
  const index = workspace.drafts.findIndex((draft) => draft.draft_id === targetId);
  if (index < 0) throw new TypeError("draftId does not exist");
  const previous = workspace.drafts[index];
  const updatedAt = options.updatedAt || new Date().toISOString();
  const replacement = createDraftRecordV3({
    draftId: targetId,
    contentPackage: options.contentPackage === undefined ? previous.content_package : options.contentPackage,
    generationSession: options.generationSession === undefined ? previous.generation_session : options.generationSession,
    pendingImageOperation: Object.prototype.hasOwnProperty.call(options, "pendingImageOperation")
      ? options.pendingImageOperation
      : previous.pending_image_operation,
    createdAt: previous.created_at,
    updatedAt,
  });
  const drafts = [...workspace.drafts];
  drafts[index] = replacement;
  return v3WorkspaceFromNormalized({ workspace, drafts, updatedAt });
}

export function beginNewDraftV3(value, {
  draftId,
  newDraftId,
  createdAt,
  savedAt,
  currentContent,
  currentSession,
  contentPackage = generateContentPackage({ topic: "", pillar: "wellness", goal: "save" }),
} = {}) {
  const timestamp = savedAt || createdAt || new Date().toISOString();
  let workspace = parseWorkspaceEnvelopeV3(value);
  const currentRecord = workspace.drafts.find((draft) => draft.draft_id === workspace.active_draft_id);
  const snapshotContent = currentContent === undefined ? currentRecord.content_package : currentContent;
  const snapshotSession = currentSession === undefined ? currentRecord.generation_session : currentSession;
  const checkedSnapshotContent = checkedContent(snapshotContent, "current_content");
  const checkedSnapshotSession = checkedGenerationSession(snapshotSession, "generation_session");
  const hasWorkToPreserve = Boolean(
    checkedSnapshotContent.id
    || checkedSnapshotContent.saved_at
    || String(checkedSnapshotContent.source_input || "").trim()
    || checkedSnapshotContent.generation?.mode === "PROVIDER"
    || String(checkedSnapshotSession?.topic || "").trim()
    || checkedSnapshotSession?.text_draft
  );
  if (hasWorkToPreserve) {
    workspace = saveDraftRecordV3(workspace, {
      contentPackage: {
        ...checkedSnapshotContent,
        id: checkedSnapshotContent.id || currentRecord.draft_id,
        saved_at: checkedSnapshotContent.saved_at || timestamp,
      },
      generationSession: checkedSnapshotSession,
      updatedAt: timestamp,
    });
  }
  const nextDraftId = requiredString(newDraftId || draftId, "draftId");
  if (workspace.drafts.some((draft) => draft.draft_id === nextDraftId)) throw new TypeError("draftId already exists");
  if (workspace.drafts.length >= MAX_DRAFT_RECORDS) throw new TypeError("workspace draft limit reached");
  const fresh = createDraftRecordV3({
    draftId: nextDraftId,
    contentPackage,
    generationSession: null,
    pendingImageOperation: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const nextWorkspace = v3WorkspaceFromNormalized({
    workspace,
    activeDraftId: nextDraftId,
    previousDraftId: workspace.active_draft_id,
    drafts: [fresh, ...workspace.drafts],
    updatedAt: timestamp,
  });
  return { workspace: nextWorkspace, previousDraftId: workspace.active_draft_id, activeDraft: fresh };
}

export function activateDraftRecordV3(value, draftId, { activatedAt = new Date().toISOString() } = {}) {
  const workspace = parseWorkspaceEnvelopeV3(value);
  const nextDraftId = requiredString(draftId, "draftId");
  const activeDraft = workspace.drafts.find((draft) => draft.draft_id === nextDraftId);
  if (!activeDraft) throw new TypeError("draftId does not exist");
  const previousDraftId = nextDraftId === workspace.active_draft_id
    ? workspace.previous_draft_id
    : workspace.active_draft_id;
  const nextWorkspace = v3WorkspaceFromNormalized({ workspace, activeDraftId: nextDraftId, previousDraftId, updatedAt: activatedAt });
  return {
    workspace: nextWorkspace,
    previousDraftId: nextWorkspace.previous_draft_id,
    activeDraft,
  };
}

export function saveWorkspaceProfileV3(value, profile, { updatedAt = new Date().toISOString() } = {}) {
  const workspace = parseWorkspaceEnvelopeV3(value);
  return v3WorkspaceFromNormalized({ workspace, profile: normalizeProfileV2(profile), updatedAt });
}

function bytesToUint8Array(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new TypeError("MEDIA_BYTES_INVALID");
}

async function exactBytes(value) {
  if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return bytesToUint8Array(value);
}

async function sha256Hex(bytes) {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.subtle?.digest) throw new TypeError("WEB_CRYPTO_UNAVAILABLE");
  const digest = await cryptoObject.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sniffImageMime(bytes) {
  if (
    bytes.length >= 4
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  ) return "image/jpeg";
  const ascii = (offset, text) => offset + text.length <= bytes.length
    && [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (
    bytes.length >= 24
    && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
    && bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 0x0d
    && ascii(12, "IHDR")
  ) return "image/png";
  if (
    bytes.length >= 20
    && ascii(0, "RIFF") && ascii(8, "WEBP")
    && (ascii(12, "VP8 ") || ascii(12, "VP8L") || ascii(12, "VP8X"))
  ) return "image/webp";
  throw new TypeError("MEDIA_MAGIC_BYTES_INVALID");
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const encoded = requiredString(value, "bytes_base64");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new TypeError("WORKSPACE_BACKUP_MEDIA_BASE64_INVALID");
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(encoded, "base64"));
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function mediaStoreAdapter(value) {
  if (!value || typeof value.putVerifiedMedia !== "function" || typeof value.readVerifiedMedia !== "function") {
    throw new TypeError("MEDIA_STORE_INVALID");
  }
  return value;
}

async function verifiedMediaReceipt(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("MEDIA_READBACK_INVALID");
  const bytes = await exactBytes(value.bytes);
  const sha256 = await sha256Hex(bytes);
  const mime = sniffImageMime(bytes);
  const mediaRef = `${MEDIA_REF_PREFIX}${sha256}`;
  if (expected.sha256 != null && expected.sha256 !== sha256) throw new TypeError("MEDIA_HASH_MISMATCH");
  if (value.sha256 != null && value.sha256 !== sha256) throw new TypeError("MEDIA_READBACK_HASH_MISMATCH");
  if (expected.media_ref != null && expected.media_ref !== mediaRef) throw new TypeError("MEDIA_REF_MISMATCH");
  if (value.media_ref != null && value.media_ref !== mediaRef) throw new TypeError("MEDIA_READBACK_REF_MISMATCH");
  if (value.ref != null && value.ref !== mediaRef) throw new TypeError("MEDIA_READBACK_REF_MISMATCH");
  const claimedMime = String(value.mime || value.mime_type || expected.mime || "").toLowerCase();
  if (claimedMime && claimedMime !== mime) throw new TypeError("MEDIA_MIME_MISMATCH");
  if (expected.mime != null && expected.mime !== mime) throw new TypeError("MEDIA_MIME_MISMATCH");
  if (value.size_bytes != null && Number(value.size_bytes) !== bytes.byteLength) throw new TypeError("MEDIA_READBACK_SIZE_MISMATCH");
  if (expected.size_bytes != null && Number(expected.size_bytes) !== bytes.byteLength) throw new TypeError("MEDIA_SIZE_MISMATCH");
  const name = optionalString(value.name || expected.name, "media.name", 240) || `${sha256.slice(0, 12)}.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`;
  return { media_ref: mediaRef, sha256, size_bytes: bytes.byteLength, mime, name, bytes };
}

export async function putAndReadbackMediaDelta(mediaStoreValue, mediaDelta = []) {
  if (!Array.isArray(mediaDelta)) throw new TypeError("MEDIA_DELTA_INVALID");
  if (!mediaDelta.length) return [];
  const store = mediaStoreAdapter(mediaStoreValue);
  const manifests = [];
  for (let index = 0; index < mediaDelta.length; index += 1) {
    const item = mediaDelta[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`MEDIA_DELTA_${index + 1}_INVALID`);
    const bytes = await exactBytes(item.bytes);
    const actualSha = await sha256Hex(bytes);
    const actualMime = sniffImageMime(bytes);
    if (item.sha256 != null && item.sha256 !== actualSha) throw new TypeError(`MEDIA_DELTA_${index + 1}_HASH_MISMATCH`);
    const requestedMime = String(item.mime || item.mime_type || actualMime).toLowerCase();
    if (requestedMime !== actualMime) throw new TypeError(`MEDIA_DELTA_${index + 1}_MIME_MISMATCH`);
    const expected = {
      media_ref: `${MEDIA_REF_PREFIX}${actualSha}`,
      sha256: actualSha,
      size_bytes: bytes.byteLength,
      mime: actualMime,
      name: optionalString(item.name, `media_delta[${index}].name`, 240) || `media-${index + 1}`,
    };
    const put = await store.putVerifiedMedia({
      bytes,
      mime_type: actualMime,
      mime: actualMime,
      sha256: actualSha,
      name: expected.name,
    });
    const putManifest = normalizeMediaManifest({ ...put, name: put?.name || expected.name }, `media_delta[${index}].put`);
    if (
      putManifest.media_ref !== expected.media_ref
      || putManifest.sha256 !== expected.sha256
      || putManifest.size_bytes !== expected.size_bytes
      || putManifest.mime !== expected.mime
    ) throw new TypeError(`MEDIA_DELTA_${index + 1}_PUT_MISMATCH`);
    const readback = await store.readVerifiedMedia(expected.media_ref);
    const verified = await verifiedMediaReceipt(readback, expected);
    manifests.push(normalizeMediaManifest(verified, `media_delta[${index}]`));
  }
  return manifests;
}

function collectMediaRefs(value) {
  const refs = new Set();
  const visit = (node) => {
    if (typeof node === "string") {
      const match = MEDIA_REF_RE.exec(node);
      if (match) refs.add(node);
      else if (node.startsWith("xiaoshimei-media://")) throw new TypeError("WORKSPACE_V3_MEDIA_REF_INVALID");
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) node.forEach(visit);
    else Object.values(node).forEach(visit);
  };
  visit(value);
  return [...refs].sort();
}

export async function verifyWorkspaceMediaRefs(value, mediaStoreValue) {
  const refs = collectMediaRefs(value);
  if (!refs.length) return [];
  const store = mediaStoreAdapter(mediaStoreValue);
  const manifests = [];
  for (const mediaRef of refs) {
    const readback = await store.readVerifiedMedia(mediaRef);
    const verified = await verifiedMediaReceipt(readback, { media_ref: mediaRef, sha256: MEDIA_REF_RE.exec(mediaRef)[1] });
    manifests.push(normalizeMediaManifest(verified, "workspace_media"));
  }
  return manifests;
}

export async function rebuildPendingImageStartV3({ pendingImageOperation, mediaStore } = {}) {
  const pending = normalizePendingImageOperation(pendingImageOperation);
  if (!pending) throw new TypeError("PENDING_IMAGE_OPERATION_REQUIRED");
  const canonicalInput = canonicalImageGenerationInputPreimage({
    operation_snapshot: pending.operation_snapshot,
    reference_manifest: pending.ordered_reference_manifest,
  });
  const operationSnapshotHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(pending.operation_snapshot)));
  const inputHash = await sha256Hex(new TextEncoder().encode(canonicalInput));
  if (operationSnapshotHash !== pending.operation_snapshot_hash) throw new TypeError("PENDING_IMAGE_OPERATION_SNAPSHOT_HASH_MISMATCH");
  if (inputHash !== pending.input_hash) throw new TypeError("PENDING_IMAGE_OPERATION_INPUT_HASH_MISMATCH");
  const missingReferenceMedia = [];
  if (pending.ordered_reference_manifest.length) {
    const store = mediaStoreAdapter(mediaStore);
    for (const manifest of pending.ordered_reference_manifest) {
      const readback = await store.readVerifiedMedia(manifest.media_ref);
      const verified = await verifiedMediaReceipt(readback, manifest);
      missingReferenceMedia.push({
        media_ref: manifest.media_ref,
        sha256: manifest.sha256,
        size_bytes: manifest.size_bytes,
        mime: manifest.mime,
        bytes_base64: bytesToBase64(verified.bytes),
      });
    }
  }
  return {
    mode: "START",
    bootstrap_nonce: exactSha256(pending.operation_nonce, "pending_image_operation.operation_nonce"),
    operation_snapshot: structuredClone(pending.operation_snapshot),
    input_sha256: pending.input_hash,
    reference_manifest: structuredClone(pending.ordered_reference_manifest),
    missing_reference_media: missingReferenceMedia,
  };
}

export async function materializePersistentMediaRefsV3({ value, mediaStore, resolveBlobUrl = null } = {}) {
  const memo = new Map();
  const manifests = [];
  const materialize = async (source, path) => {
    if (memo.has(source)) return memo.get(source);
    let bytes;
    let mime;
    let name = `${path.replace(/[^A-Za-z0-9_-]+/g, "-").slice(-100) || "ui-media"}`;
    if (/^data:/i.test(source)) {
      const decoded = decodeImageDataUrl(source);
      bytes = decoded.bytes;
      mime = decoded.mime;
    } else {
      if (typeof resolveBlobUrl !== "function") throw new TypeError("WORKSPACE_BLOB_MEDIA_RESOLVER_REQUIRED");
      const resolved = await resolveBlobUrl(source, { path });
      if (typeof Blob !== "undefined" && resolved instanceof Blob) {
        bytes = await exactBytes(resolved);
        mime = resolved.type;
      } else {
        if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) throw new TypeError("WORKSPACE_BLOB_MEDIA_RESOLUTION_INVALID");
        bytes = await exactBytes(resolved.bytes);
        mime = resolved.mime || resolved.mime_type;
        name = optionalString(resolved.name, "resolved_blob.name", 240) || name;
      }
    }
    const [manifest] = await putAndReadbackMediaDelta(mediaStore, [{ bytes, mime, name }]);
    memo.set(source, manifest.media_ref);
    manifests.push(manifest);
    return manifest.media_ref;
  };
  const visit = async (node, path = "value") => {
    if (typeof node === "string") {
      if (/^(?:data|blob):/i.test(node)) return materialize(node, path);
      return node;
    }
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      const result = [];
      for (let index = 0; index < node.length; index += 1) result.push(await visit(node[index], `${path}[${index}]`));
      return result;
    }
    const result = {};
    for (const [key, child] of Object.entries(node)) result[key] = await visit(child, `${path}.${key}`);
    return result;
  };
  const persistentValue = await visit(value);
  assertPersistentRefOnly(persistentValue);
  return { value: persistentValue, media_manifest: manifests };
}

function replaceWorkspaceMediaRefsForView(value, urls) {
  if (typeof value === "string") return urls.get(value) || value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => replaceWorkspaceMediaRefsForView(item, urls));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceWorkspaceMediaRefsForView(child, urls)]));
}

export async function hydrateWorkspaceV3View({ workspace, mediaStore } = {}) {
  const checked = parseWorkspaceEnvelopeV3(workspace);
  const sourceToken = workspaceEnvelopeV3Token(checked);
  // Content refs are projected to blob URLs for the canvas. Authoring-session
  // action references remain stable content-addressed refs so the caller can
  // hydrate previews independently without ever persisting blob URLs. Both
  // surfaces must nevertheless be present and verified before the view opens.
  const refs = collectMediaRefs(checked);
  const hydrations = [];
  let released = false;
  const release = () => {
    if (released) return false;
    released = true;
    if (mediaStore && typeof mediaStore.releaseHydratedMedia === "function") {
      hydrations.forEach((hydrated) => {
        try { mediaStore.releaseHydratedMedia(hydrated); } catch {}
      });
    }
    return true;
  };
  if (!refs.length) {
    return {
      ok: true,
      code: "WORKSPACE_V3_VIEW_READY",
      schema: "xiaoshimei.workspace-view.v1",
      persistable: false,
      source_workspace_token: sourceToken,
      workspace: structuredClone(checked),
      hydrations,
      missing_refs: [],
      corrupt_refs: [],
      release,
    };
  }
  if (!mediaStore || typeof mediaStore.hydrateMedia !== "function" || typeof mediaStore.releaseHydratedMedia !== "function") {
    return {
      ok: false,
      code: "WORKSPACE_V3_MEDIA_HYDRATION_UNAVAILABLE",
      schema: "xiaoshimei.workspace-view.v1",
      persistable: false,
      source_workspace_token: sourceToken,
      workspace: null,
      hydrations: [],
      missing_refs: [],
      corrupt_refs: refs.map((media_ref) => ({ media_ref, code: "MEDIA_HYDRATION_ADAPTER_INVALID" })),
      release,
    };
  }
  const urls = new Map();
  const missingRefs = [];
  const corruptRefs = [];
  for (const mediaRef of refs) {
    try {
      const hydrated = await mediaStore.hydrateMedia(mediaRef);
      if (!hydrated || hydrated.media_ref !== mediaRef || typeof hydrated.url !== "string" || !hydrated.url.startsWith("blob:")) {
        throw new TypeError("MEDIA_HYDRATION_READBACK_MISMATCH");
      }
      hydrations.push(hydrated);
      urls.set(mediaRef, hydrated.url);
    } catch (error) {
      const code = String(error?.message || error || "MEDIA_HYDRATION_FAILED");
      const target = code === "MEDIA_READBACK_MISSING" ? missingRefs : corruptRefs;
      target.push({ media_ref: mediaRef, code });
    }
  }
  if (missingRefs.length || corruptRefs.length) {
    release();
    return {
      ok: false,
      code: "WORKSPACE_V3_MEDIA_HYDRATION_FAILED",
      schema: "xiaoshimei.workspace-view.v1",
      persistable: false,
      source_workspace_token: sourceToken,
      workspace: null,
      hydrations: [],
      missing_refs: missingRefs,
      corrupt_refs: corruptRefs,
      release,
    };
  }
  const viewWorkspace = structuredClone(checked);
  viewWorkspace.drafts = viewWorkspace.drafts.map((draft) => ({
    ...draft,
    content_package: replaceWorkspaceMediaRefsForView(draft.content_package, urls),
  }));
  return {
    ok: true,
    code: "WORKSPACE_V3_VIEW_READY",
    schema: "xiaoshimei.workspace-view.v1",
    persistable: false,
    source_workspace_token: sourceToken,
    workspace: viewWorkspace,
    hydrations,
    missing_refs: [],
    corrupt_refs: [],
    release,
  };
}

async function legacySourceDescriptor(serialized) {
  if (typeof serialized !== "string" || serialized.length < 1) throw new TypeError("legacy v2 serialized workspace is required");
  return storageRawDescriptor(serialized);
}

async function storageRawDescriptor(serialized) {
  if (typeof serialized !== "string") throw new TypeError("serialized storage preimage is required");
  const bytes = new TextEncoder().encode(serialized);
  const sha256 = await sha256Hex(bytes);
  return { token: `sha256:${sha256}:${bytes.byteLength}`, sha256, byte_length: bytes.byteLength };
}

function decodeImageDataUrl(value) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(value);
  if (!match) throw new TypeError("LEGACY_MEDIA_DATA_URL_INVALID");
  return { mime: match[1].toLowerCase(), bytes: base64ToBytes(match[2]) };
}

async function migrateLegacyMediaValue(value, mediaStore, memo, path = "workspace") {
  if (typeof value === "string") {
    if (/^blob:/i.test(value)) throw new TypeError("LEGACY_BLOB_URL_NOT_RECOVERABLE");
    if (/^data:/i.test(value)) {
      if (memo.has(value)) return memo.get(value);
      const decoded = decodeImageDataUrl(value);
      const [manifest] = await putAndReadbackMediaDelta(mediaStore, [{
        bytes: decoded.bytes,
        mime: decoded.mime,
        name: `${path.replace(/[^A-Za-z0-9_-]+/g, "-").slice(-100) || "legacy-media"}`,
      }]);
      memo.set(value, manifest.media_ref);
      return manifest.media_ref;
    }
    if (value.startsWith("xiaoshimei-media://")) throw new TypeError("LEGACY_V2_MEDIA_REF_FORBIDDEN");
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      result.push(await migrateLegacyMediaValue(value[index], mediaStore, memo, `${path}[${index}]`));
    }
    return result;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = await migrateLegacyMediaValue(item, mediaStore, memo, `${path}.${key}`);
  }
  return result;
}

async function projectLegacyImageState(record, migratedContent, migratedSession, mediaStore) {
  const legacy = migratedSession?.image_resume;
  if (legacy == null) return { generationSession: migratedSession, pendingImageOperation: null };
  const projected = {};
  V3_IMAGE_RESUME_ALLOWED_KEYS.forEach((key) => {
    if (legacy[key] != null) projected[key] = structuredClone(legacy[key]);
  });
  const checkpointRefs = legacy.resume_checkpoint == null ? [] : collectMediaRefs(legacy.resume_checkpoint);
  if (checkpointRefs.length) projected.local_media_refs = [...new Set([...(projected.local_media_refs || []), ...checkpointRefs])];
  if (legacy.resume_checkpoint != null && projected.checkpoint_hash == null) {
    projected.checkpoint_hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(legacy.resume_checkpoint)));
  }
  if (projected.failure_code == null && legacy.failure?.code != null) projected.failure_code = String(legacy.failure.code);
  const imageResume = normalizeV3ImageResume(projected);
  const snapshotHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({
    draft_id: record.draft_id,
    content_package: migratedContent,
    generation_session: { ...migratedSession, image_resume: null },
  })));
  const textDraft = migratedSession?.text_draft;
  const safeIdentifier = (candidate, fallback) => {
    const normalized = String(candidate || "").replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
    return normalized || fallback;
  };
  const operationSnapshot = {
    schema: "xiaoshimei.image-operation-snapshot.v1",
    draft_record_id: safeIdentifier(record.draft_id, `legacy-${snapshotHash.slice(0, 24)}`),
    mutation_epoch: 0,
    confirmed_draft: {
      draft_id: safeIdentifier(textDraft?.draft_id, `legacy-text-${snapshotHash.slice(0, 20)}`),
      source_input: textDraft?.source_input || migratedContent.source_input,
      pillar: textDraft?.pillar || migratedContent.pillar,
      goal: textDraft?.goal || migratedContent.goal,
      titles: textDraft?.titles || migratedContent.titles,
      selected_title: textDraft?.selected_title || migratedContent.selectedTitle,
      body: textDraft?.body || migratedContent.body,
      tags: textDraft?.tags || migratedContent.tags,
      recommended_image_count: textDraft?.recommended_image_count || migratedContent.visible_pages,
      facts: Array.isArray(textDraft?.facts) ? textDraft.facts.filter((item) => typeof item === "string") : [],
      risks: Array.isArray(textDraft?.risks) ? textDraft.risks.filter((item) => typeof item === "string") : [],
      content_type: textDraft?.content_type || "knowledge_card",
      style_lock: textDraft?.style_lock || null,
      prompt_context: textDraft?.prompt_context || {},
    },
    page_count: Math.max(1, Math.min(8, Number(migratedContent.visible_pages) || migratedContent.pages.length || 1)),
    production_mode: migratedSession?.production_mode || "smart",
    reference_note: migratedSession?.action_reference_note || "",
  };
  const orderedReferenceManifest = migratedSession?.action_reference_manifest || [];
  const canonicalInput = canonicalImageGenerationInputPreimage({
    operation_snapshot: operationSnapshot,
    reference_manifest: orderedReferenceManifest,
  });
  const canonicalOperationSnapshot = JSON.parse(canonicalInput).operation_snapshot;
  const operationSnapshotHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(canonicalOperationSnapshot)));
  const inputHash = await sha256Hex(new TextEncoder().encode(canonicalInput));
  const materialized = collectMediaRefs({ image_resume: imageResume, action_reference_manifest: orderedReferenceManifest }).length
    ? await verifyWorkspaceMediaRefs({ image_resume: imageResume, action_reference_manifest: orderedReferenceManifest }, mediaStore)
    : [];
  const operationNonce = operationSnapshotHash;
  const pendingImageOperation = createPendingImageOperation({
    operationNonce,
    operationSnapshot: canonicalOperationSnapshot,
    operationSnapshotHash,
    inputHash,
    orderedReferenceManifest,
    materializedMediaManifest: materialized,
    protocolState: "PARTIAL",
    runId: imageResume?.resume_run_id || null,
    checkpointPreimageHash: imageResume?.checkpoint_preimage_hash || null,
    checkpointHash: imageResume?.checkpoint_hash || null,
    logicalStepId: imageResume?.logical_step_id || null,
    attemptNonce: imageResume?.attempt_nonce || null,
    completedImageSteps: imageResume?.completed_image_steps ?? imageResume?.completed_mother_sheets ?? null,
    totalImageSteps: imageResume?.total_image_steps ?? null,
    updatedAt: record.updated_at,
  });
  return {
    generationSession: { ...migratedSession, image_resume: imageResume },
    pendingImageOperation,
  };
}

export async function migrateWorkspaceEnvelopeV2ToV3({ workspace, serializedV2, mediaStore } = {}) {
  if (typeof serializedV2 !== "string" || serializedV2.length < 1) throw new TypeError("serializedV2 is required");
  const raw = serializedV2;
  const parsedRaw = parseWorkspaceEnvelope(raw);
  const parsed = workspace == null ? parsedRaw : parseWorkspaceEnvelope(workspace);
  if (workspaceEnvelopeToken(parsed) !== workspaceEnvelopeToken(parsedRaw)) {
    throw new TypeError("LEGACY_V2_PREIMAGE_MISMATCH");
  }
  const memo = new Map();
  const drafts = [];
  for (let index = 0; index < parsed.drafts.length; index += 1) {
    const record = parsed.drafts[index];
    const migratedContent = await migrateLegacyMediaValue(record.content_package, mediaStore, memo, `drafts[${index}].content_package`);
    const migratedSession = await migrateLegacyMediaValue(record.generation_session, mediaStore, memo, `drafts[${index}].generation_session`);
    const imageState = await projectLegacyImageState(record, migratedContent, migratedSession, mediaStore);
    drafts.push(createDraftRecordV3({
      draftId: record.draft_id,
      contentPackage: migratedContent,
      generationSession: imageState.generationSession,
      pendingImageOperation: imageState.pendingImageOperation,
      createdAt: record.created_at,
      updatedAt: record.updated_at,
    }));
  }
  return buildWorkspaceEnvelopeV3({
    profile: parsed.profile,
    activeDraftId: parsed.active_draft_id,
    drafts,
    legacyV2Source: await legacySourceDescriptor(raw),
    updatedAt: parsed.updated_at,
  });
}

function readWorkspaceV3Snapshot(storage, key) {
  if (!storage || typeof storage.getItem !== "function") {
    return { ok: false, code: "STORAGE_ADAPTER_INVALID", workspace: null, workspace_token: null };
  }
  let serialized;
  try { serialized = storage.getItem(requiredString(key, "storage key")); }
  catch (error) {
    return { ok: false, code: "STORAGE_READ_FAILED", message: String(error?.message || error), workspace: null, workspace_token: null };
  }
  if (serialized == null) {
    return { ok: true, code: "WORKSPACE_V3_ABSENT", workspace: null, workspace_token: WORKSPACE_V3_ABSENT_TOKEN };
  }
  try {
    const workspace = parseWorkspaceEnvelopeV3(serialized);
    return { ok: true, code: "WORKSPACE_V3_SNAPSHOT_READ", workspace, workspace_token: workspaceEnvelopeV3Token(workspace) };
  } catch (error) {
    return { ok: false, code: "WORKSPACE_V3_ENVELOPE_INVALID", message: String(error?.message || error), workspace: null, workspace_token: null };
  }
}

function v3TransactionReceipt({ ok, code, disposition, snapshot, targetDraftId = null, recoveredDraftId = null, reason = null, message = null }) {
  const workspace = snapshot?.workspace || null;
  const activeDraft = workspace?.drafts.find((draft) => draft.draft_id === workspace.active_draft_id) || null;
  const targetDraft = targetDraftId == null ? null : workspace?.drafts.find((draft) => draft.draft_id === targetDraftId) || null;
  const recoveredDraft = recoveredDraftId == null ? null : workspace?.drafts.find((draft) => draft.draft_id === recoveredDraftId) || null;
  return {
    ok,
    code,
    disposition,
    reason,
    ...(message == null ? {} : { message }),
    workspace,
    workspace_token: snapshot?.workspace_token || null,
    active_draft: activeDraft,
    target_draft: targetDraft,
    target_draft_token: targetDraft == null ? null : draftRecordToken(targetDraft),
    recovered_draft: recoveredDraft,
  };
}

function workspaceV3StorageKeys(keys) {
  if (!keys || typeof keys !== "object") throw new TypeError("workspace storage keys are required");
  return {
    ...keys,
    envelope: requiredString(keys.envelope, "keys.envelope"),
    envelopeV3: requiredString(keys.envelopeV3, "keys.envelopeV3"),
  };
}

async function workspaceV3RecoveryPreconditionFromRaw(rawV3, rawV2) {
  if (typeof rawV3 !== "string") throw new TypeError("WORKSPACE_V3_RECOVERY_RAW_REQUIRED");
  const descriptor = await storageRawDescriptor(rawV3);
  const legacySource = rawV2 == null ? null : await legacySourceDescriptor(rawV2);
  return {
    schema: WORKSPACE_V3_RECOVERY_PRECONDITION_SCHEMA,
    raw_v3_preimage: rawV3,
    raw_v3_sha256: descriptor.sha256,
    raw_v3_byte_length: descriptor.byte_length,
    raw_v3_token: descriptor.token,
    legacy_v2_preimage: rawV2 == null ? null : rawV2,
    legacy_v2_source: legacySource,
  };
}

async function normalizeWorkspaceV3RecoveryPrecondition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== WORKSPACE_V3_RECOVERY_PRECONDITION_SCHEMA) {
    throw new TypeError("WORKSPACE_V3_RECOVERY_PRECONDITION_INVALID");
  }
  if (typeof value.raw_v3_preimage !== "string") throw new TypeError("WORKSPACE_V3_RECOVERY_RAW_REQUIRED");
  if (value.legacy_v2_preimage != null && typeof value.legacy_v2_preimage !== "string") {
    throw new TypeError("WORKSPACE_V3_RECOVERY_LEGACY_RAW_INVALID");
  }
  const normalized = await workspaceV3RecoveryPreconditionFromRaw(
    value.raw_v3_preimage,
    value.legacy_v2_preimage == null ? null : value.legacy_v2_preimage,
  );
  if (
    value.raw_v3_sha256 !== normalized.raw_v3_sha256
    || Number(value.raw_v3_byte_length) !== normalized.raw_v3_byte_length
    || value.raw_v3_token !== normalized.raw_v3_token
    || JSON.stringify(value.legacy_v2_source ?? null) !== JSON.stringify(normalized.legacy_v2_source)
  ) throw new TypeError("WORKSPACE_V3_RECOVERY_PRECONDITION_MISMATCH");
  return normalized;
}

export function createWorkspaceV3Coordinator({
  storage,
  keys,
  lockManager = globalThis.navigator?.locks,
  lockName = WORKSPACE_LOCK_NAME,
  mediaStore = null,
} = {}) {
  const normalizedKeys = workspaceV3StorageKeys(keys);
  const normalizedLockName = requiredString(lockName, "lockName");

  function snapshot() {
    return readWorkspaceV3Snapshot(storage, normalizedKeys.envelopeV3);
  }

  async function underExclusiveLock(callback) {
    if (!lockManager || typeof lockManager.request !== "function") {
      return v3TransactionReceipt({
        ok: false,
        code: "WORKSPACE_LOCK_UNAVAILABLE",
        disposition: "NO_WRITE_LOCK_UNAVAILABLE",
        snapshot: snapshot(),
      });
    }
    try {
      return await lockManager.request.call(lockManager, normalizedLockName, { mode: "exclusive" }, callback);
    } catch (error) {
      return v3TransactionReceipt({
        ok: false,
        code: "WORKSPACE_LOCK_FAILED",
        disposition: "NO_WRITE_LOCK_FAILED",
        snapshot: snapshot(),
        message: String(error?.message || error),
      });
    }
  }

  async function legacyWriterCheck(workspace) {
    let raw;
    try { raw = storage.getItem(normalizedKeys.envelope); }
    catch (error) { return { ok: false, message: String(error?.message || error) }; }
    if (workspace?.legacy_v2_source == null) {
      return raw == null
        ? { ok: true }
        : { ok: false, message: "legacy v2 workspace appeared after clean v3 initialization" };
    }
    if (raw == null) return { ok: false, message: "legacy v2 rollback preimage is missing" };
    const actual = await legacySourceDescriptor(raw);
    return actual.token === workspace.legacy_v2_source.token && actual.sha256 === workspace.legacy_v2_source.sha256
      ? { ok: true }
      : { ok: false, message: "legacy v2 rollback preimage changed after v3 migration" };
  }

  function persistAndReadback(nextWorkspace, { targetDraftId = null, recoveredDraftId = null, reason = null, disposition = "COMMITTED" } = {}) {
    const normalized = parseWorkspaceEnvelopeV3(nextWorkspace);
    const expectedToken = workspaceEnvelopeV3Token(normalized);
    try { storage.setItem(normalizedKeys.envelopeV3, JSON.stringify(normalized)); }
    catch (error) {
      return v3TransactionReceipt({
        ok: false,
        code: "WORKSPACE_V3_PERSIST_FAILED",
        disposition: "NO_WRITE_PERSIST_FAILED",
        snapshot: snapshot(),
        targetDraftId,
        recoveredDraftId,
        reason,
        message: String(error?.message || error),
      });
    }
    const readback = snapshot();
    if (!readback.ok) {
      return v3TransactionReceipt({ ok: false, code: "WORKSPACE_V3_READBACK_FAILED", disposition: "WRITE_READBACK_FAILED", snapshot: readback, targetDraftId, recoveredDraftId, reason, message: readback.message });
    }
    if (readback.workspace_token !== expectedToken) {
      return v3TransactionReceipt({ ok: false, code: "WORKSPACE_V3_READBACK_MISMATCH", disposition: "WRITE_READBACK_MISMATCH", snapshot: readback, targetDraftId, recoveredDraftId, reason });
    }
    return v3TransactionReceipt({ ok: true, code: "WORKSPACE_V3_COMMITTED_AND_VERIFIED", disposition, snapshot: readback, targetDraftId, recoveredDraftId, reason });
  }

  async function fullCas({ expectedWorkspaceToken, workspace, buildWorkspace, reason = "FULL_CAS_V3" } = {}) {
    if (typeof expectedWorkspaceToken !== "string" || !expectedWorkspaceToken) throw new TypeError("expectedWorkspaceToken is required");
    if (workspace === undefined && typeof buildWorkspace !== "function") throw new TypeError("workspace or buildWorkspace is required");
    return underExclusiveLock(async () => {
      const latest = snapshot();
      if (!latest.ok) return v3TransactionReceipt({ ok: false, code: latest.code, disposition: "NO_WRITE_READ_FAILED", snapshot: latest, reason, message: latest.message });
      if (latest.workspace_token !== expectedWorkspaceToken) {
        return v3TransactionReceipt({ ok: false, code: "WORKSPACE_V3_CAS_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason });
      }
      if (latest.workspace) {
        const legacy = await legacyWriterCheck(latest.workspace);
        if (!legacy.ok) return v3TransactionReceipt({ ok: false, code: "LEGACY_WRITER_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason, message: legacy.message });
      }
      let candidate = workspace;
      if (typeof buildWorkspace === "function") candidate = syncBuilderResult(buildWorkspace(latest.workspace), "WORKSPACE_ASYNC_BUILDER_FORBIDDEN");
      let next = parseWorkspaceEnvelopeV3(candidate);
      if (!latest.workspace && next.legacy_v2_source == null) {
        let legacyRaw;
        try { legacyRaw = storage.getItem(normalizedKeys.envelope); }
        catch (error) {
          return v3TransactionReceipt({
            ok: false,
            code: "STORAGE_READ_FAILED",
            disposition: "NO_WRITE_READ_FAILED",
            snapshot: latest,
            reason,
            message: String(error?.message || error),
          });
        }
        if (legacyRaw != null) {
          next = buildWorkspaceEnvelopeV3({
            profile: next.profile,
            activeDraftId: next.active_draft_id,
            previousDraftId: next.previous_draft_id,
            drafts: next.drafts,
            legacyV2Source: await legacySourceDescriptor(legacyRaw),
            updatedAt: next.updated_at,
          });
        }
      }
      if (!latest.workspace && next.legacy_v2_source != null) {
        const legacy = await legacyWriterCheck(next);
        if (!legacy.ok) return v3TransactionReceipt({ ok: false, code: "LEGACY_WRITER_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason, message: legacy.message });
      }
      if (latest.workspace && JSON.stringify(next.legacy_v2_source) !== JSON.stringify(latest.workspace.legacy_v2_source)) {
        return v3TransactionReceipt({ ok: false, code: "WORKSPACE_V3_LEGACY_SOURCE_MUTATION_FORBIDDEN", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason });
      }
      if (workspaceEnvelopeV3Token(next) === latest.workspace_token) {
        return v3TransactionReceipt({ ok: true, code: "WORKSPACE_V3_ALREADY_CURRENT", disposition: "NOOP_ALREADY_APPLIED", snapshot: latest, reason });
      }
      return persistAndReadback(next, { reason });
    });
  }

  async function recoverySnapshot() {
    return underExclusiveLock(async () => {
      let rawV3;
      let rawV2;
      try {
        rawV3 = storage.getItem(normalizedKeys.envelopeV3);
        rawV2 = storage.getItem(normalizedKeys.envelope);
      } catch (error) {
        return {
          ok: false,
          code: "STORAGE_READ_FAILED",
          message: String(error?.message || error),
          recovery_precondition: null,
        };
      }
      if (rawV3 == null) {
        return { ok: false, code: "WORKSPACE_V3_RECOVERY_SOURCE_MISSING", recovery_precondition: null };
      }
      try {
        const workspace = parseWorkspaceEnvelopeV3(rawV3);
        return {
          ok: false,
          code: "WORKSPACE_V3_RECOVERY_NOT_REQUIRED",
          workspace,
          workspace_token: workspaceEnvelopeV3Token(workspace),
          recovery_precondition: null,
        };
      } catch (error) {
        const recoveryPrecondition = await workspaceV3RecoveryPreconditionFromRaw(rawV3, rawV2);
        return {
          ok: true,
          code: "WORKSPACE_V3_CORRUPT_RECOVERY_READY",
          parse_error: String(error?.message || error),
          workspace: null,
          workspace_token: null,
          recovery_precondition: recoveryPrecondition,
        };
      }
    });
  }

  async function recoverCorruptV3({
    recoveryPrecondition,
    workspace,
    reason = "RECOVER_CORRUPT_WORKSPACE_V3",
  } = {}) {
    const expected = await normalizeWorkspaceV3RecoveryPrecondition(recoveryPrecondition);
    const next = parseWorkspaceEnvelopeV3(workspace);
    return underExclusiveLock(async () => {
      let rawV3;
      let rawV2;
      try {
        rawV3 = storage.getItem(normalizedKeys.envelopeV3);
        rawV2 = storage.getItem(normalizedKeys.envelope);
      } catch (error) {
        return v3TransactionReceipt({
          ok: false,
          code: "STORAGE_READ_FAILED",
          disposition: "NO_WRITE_READ_FAILED",
          snapshot: snapshot(),
          reason,
          message: String(error?.message || error),
        });
      }
      if (rawV3 !== expected.raw_v3_preimage) {
        return v3TransactionReceipt({
          ok: false,
          code: "WORKSPACE_V3_RECOVERY_PREIMAGE_CONFLICT",
          disposition: "NO_WRITE_CONFLICT",
          snapshot: snapshot(),
          reason,
        });
      }
      const actualDescriptor = await storageRawDescriptor(rawV3);
      if (
        actualDescriptor.sha256 !== expected.raw_v3_sha256
        || actualDescriptor.byte_length !== expected.raw_v3_byte_length
        || actualDescriptor.token !== expected.raw_v3_token
      ) {
        return v3TransactionReceipt({
          ok: false,
          code: "WORKSPACE_V3_RECOVERY_PREIMAGE_CONFLICT",
          disposition: "NO_WRITE_CONFLICT",
          snapshot: snapshot(),
          reason,
        });
      }
      try {
        parseWorkspaceEnvelopeV3(rawV3);
        return v3TransactionReceipt({
          ok: false,
          code: "WORKSPACE_V3_RECOVERY_NOT_REQUIRED",
          disposition: "NO_WRITE_CONFLICT",
          snapshot: snapshot(),
          reason,
        });
      } catch {}
      if (rawV2 !== expected.legacy_v2_preimage) {
        return v3TransactionReceipt({
          ok: false,
          code: "LEGACY_WRITER_CONFLICT",
          disposition: "NO_WRITE_CONFLICT",
          snapshot: snapshot(),
          reason,
        });
      }
      const actualLegacySource = rawV2 == null ? null : await legacySourceDescriptor(rawV2);
      if (
        JSON.stringify(actualLegacySource) !== JSON.stringify(expected.legacy_v2_source)
        || JSON.stringify(next.legacy_v2_source) !== JSON.stringify(actualLegacySource)
      ) {
        return v3TransactionReceipt({
          ok: false,
          code: "LEGACY_WRITER_CONFLICT",
          disposition: "NO_WRITE_CONFLICT",
          snapshot: snapshot(),
          reason,
        });
      }
      const receipt = persistAndReadback(next, { reason, disposition: "CORRUPT_V3_RECOVERED" });
      return receipt.ok
        ? { ...receipt, code: "WORKSPACE_V3_RECOVERED_AND_VERIFIED" }
        : receipt;
    });
  }

  async function mergeDraftCas({
    draftId,
    expectedDraftToken,
    buildDraft,
    replacementDraft,
    requireActiveDraftId = null,
    isAlreadyApplied = null,
    isRecoveredAlreadyApplied = null,
    onConflict = null,
    reason = "TARGET_MERGE_V3",
  } = {}) {
    const targetId = requiredString(draftId, "draftId");
    if (typeof expectedDraftToken !== "string" || !expectedDraftToken) throw new TypeError("expectedDraftToken is required");
    if (replacementDraft === undefined && typeof buildDraft !== "function") throw new TypeError("replacementDraft or buildDraft is required");
    if (isAlreadyApplied != null && typeof isAlreadyApplied !== "function") throw new TypeError("isAlreadyApplied must be a function");
    if (isRecoveredAlreadyApplied != null && typeof isRecoveredAlreadyApplied !== "function") throw new TypeError("isRecoveredAlreadyApplied must be a function");
    if (onConflict != null && typeof onConflict !== "function") throw new TypeError("onConflict must be a function");
    return underExclusiveLock(async () => {
      const latest = snapshot();
      if (!latest.ok || !latest.workspace) {
        return v3TransactionReceipt({ ok: false, code: latest.ok ? "WORKSPACE_V3_MISSING" : latest.code, disposition: "NO_WRITE_READ_FAILED", snapshot: latest, targetDraftId: targetId, reason, message: latest.message });
      }
      const legacy = await legacyWriterCheck(latest.workspace);
      if (!legacy.ok) return v3TransactionReceipt({ ok: false, code: "LEGACY_WRITER_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, reason, message: legacy.message });
      if (requireActiveDraftId != null && latest.workspace.active_draft_id !== requireActiveDraftId) {
        return v3TransactionReceipt({ ok: false, code: "WORKSPACE_ACTIVE_DRAFT_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, reason });
      }
      const targetIndex = latest.workspace.drafts.findIndex((draft) => draft.draft_id === targetId);
      const target = targetIndex < 0 ? null : latest.workspace.drafts[targetIndex];
      const targetMatches = target != null && draftRecordToken(target) === expectedDraftToken;
      if (!targetMatches) {
        if (target != null && isAlreadyApplied != null) {
          const accepted = syncBuilderResult(
            isAlreadyApplied({ workspace: latest.workspace, target_draft: target }),
            "WORKSPACE_ASYNC_IDEMPOTENCY_CHECK_FORBIDDEN",
          );
          if (accepted === true) {
            return v3TransactionReceipt({
              ok: true,
              code: "WORKSPACE_DRAFT_ALREADY_APPLIED",
              disposition: "NOOP_ALREADY_APPLIED",
              snapshot: latest,
              targetDraftId: targetId,
              reason,
            });
          }
          if (accepted !== false) throw new TypeError("isAlreadyApplied must return a boolean");
        }
        if (onConflict == null) return v3TransactionReceipt({ ok: false, code: "WORKSPACE_DRAFT_CAS_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, reason });
        const siblingValue = syncBuilderResult(onConflict({ workspace: latest.workspace, target_draft: target }), "WORKSPACE_ASYNC_CONFLICT_BUILDER_FORBIDDEN");
        if (siblingValue == null) return v3TransactionReceipt({ ok: false, code: "WORKSPACE_DRAFT_CAS_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, reason });
        const sibling = normalizeDraftRecordV3(siblingValue, "recovered_draft");
        const existingSibling = latest.workspace.drafts.find((draft) => draft.draft_id === sibling.draft_id);
        if (existingSibling) {
          if (draftRecordToken(existingSibling) !== draftRecordToken(sibling)) {
            if (isRecoveredAlreadyApplied != null) {
              const accepted = syncBuilderResult(
                isRecoveredAlreadyApplied({ workspace: latest.workspace, existing_draft: existingSibling, desired_draft: sibling }),
                "WORKSPACE_ASYNC_RECOVERED_IDEMPOTENCY_CHECK_FORBIDDEN",
              );
              if (accepted === true) {
                return v3TransactionReceipt({
                  ok: true,
                  code: "WORKSPACE_RECOVERED_DRAFT_ALREADY_APPLIED",
                  disposition: "NOOP_ALREADY_APPLIED",
                  snapshot: latest,
                  targetDraftId: targetId,
                  recoveredDraftId: sibling.draft_id,
                  reason,
                });
              }
              if (accepted !== false) throw new TypeError("isRecoveredAlreadyApplied must return a boolean");
            }
            return v3TransactionReceipt({ ok: false, code: "WORKSPACE_RECOVERED_DRAFT_COLLISION", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, recoveredDraftId: sibling.draft_id, reason });
          }
          return v3TransactionReceipt({ ok: true, code: "WORKSPACE_RECOVERED_DRAFT_ALREADY_PRESENT", disposition: "NOOP_ALREADY_APPLIED", snapshot: latest, targetDraftId: targetId, recoveredDraftId: sibling.draft_id, reason });
        }
        if (latest.workspace.drafts.length >= MAX_DRAFT_RECORDS) {
          return v3TransactionReceipt({ ok: false, code: "WORKSPACE_DRAFT_LIMIT_REACHED", disposition: "NO_WRITE_CONFLICT", snapshot: latest, targetDraftId: targetId, recoveredDraftId: sibling.draft_id, reason });
        }
        const recoveredWorkspace = v3WorkspaceFromNormalized({
          workspace: latest.workspace,
          drafts: [sibling, ...latest.workspace.drafts],
          updatedAt: sibling.updated_at,
        });
        return persistAndReadback(recoveredWorkspace, { targetDraftId: targetId, recoveredDraftId: sibling.draft_id, reason, disposition: "RECOVERED_SIBLING_COMMITTED" });
      }
      let candidate = replacementDraft;
      if (typeof buildDraft === "function") candidate = syncBuilderResult(buildDraft(target, latest.workspace), "WORKSPACE_ASYNC_BUILDER_FORBIDDEN");
      const replacement = normalizeDraftRecordV3(candidate, "replacement_draft");
      if (replacement.draft_id !== targetId) throw new TypeError("replacement draft identity cannot change");
      if (replacement.created_at !== target.created_at) throw new TypeError("replacement draft creation time cannot change");
      if (JSON.stringify(replacement) === JSON.stringify(target)) {
        return v3TransactionReceipt({ ok: true, code: "WORKSPACE_DRAFT_ALREADY_CURRENT", disposition: "NOOP_ALREADY_APPLIED", snapshot: latest, targetDraftId: targetId, reason });
      }
      const drafts = [...latest.workspace.drafts];
      drafts[targetIndex] = replacement;
      const next = v3WorkspaceFromNormalized({ workspace: latest.workspace, drafts, updatedAt: replacement.updated_at });
      return persistAndReadback(next, { targetDraftId: targetId, reason });
    });
  }

  async function bootstrap({ fallbackWorkspaceV2 = null, expectedV2Serialized = null } = {}) {
    return underExclusiveLock(async () => {
      const latest = snapshot();
      if (!latest.ok) return v3TransactionReceipt({ ok: false, code: latest.code, disposition: "NO_WRITE_READ_FAILED", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3", message: latest.message });
      if (latest.workspace) {
        const legacy = await legacyWriterCheck(latest.workspace);
        return legacy.ok
          ? v3TransactionReceipt({ ok: true, code: "WORKSPACE_V3_ALREADY_CURRENT", disposition: "NOOP_ALREADY_APPLIED", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3" })
          : v3TransactionReceipt({ ok: false, code: "LEGACY_WRITER_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3", message: legacy.message });
      }
      let physicalV2;
      try { physicalV2 = storage.getItem(normalizedKeys.envelope); }
      catch (error) {
        return v3TransactionReceipt({ ok: false, code: "STORAGE_READ_FAILED", disposition: "NO_WRITE_READ_FAILED", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3", message: String(error?.message || error) });
      }
      if (expectedV2Serialized != null && physicalV2 !== expectedV2Serialized) {
        return v3TransactionReceipt({ ok: false, code: "LEGACY_WRITER_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3" });
      }
      let sourceWorkspace;
      let serializedSource;
      let hasPhysicalLegacy = false;
      if (physicalV2 != null) {
        try { sourceWorkspace = parseWorkspaceEnvelope(physicalV2); }
        catch (error) {
          return v3TransactionReceipt({ ok: false, code: "LEGACY_V2_WORKSPACE_INVALID", disposition: "NO_WRITE_MIGRATION_FAILED", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3", message: String(error?.message || error) });
        }
        serializedSource = physicalV2;
        hasPhysicalLegacy = true;
      } else if (fallbackWorkspaceV2 != null) {
        try { sourceWorkspace = parseWorkspaceEnvelope(fallbackWorkspaceV2); }
        catch (error) {
          return v3TransactionReceipt({ ok: false, code: "WORKSPACE_V3_FALLBACK_INVALID", disposition: "NO_WRITE_MIGRATION_FAILED", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3", message: String(error?.message || error) });
        }
        serializedSource = JSON.stringify(sourceWorkspace);
      } else {
        return v3TransactionReceipt({ ok: false, code: "WORKSPACE_V3_BOOTSTRAP_SOURCE_MISSING", disposition: "NO_WRITE_MIGRATION_FAILED", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3" });
      }
      try {
        let migrated = await migrateWorkspaceEnvelopeV2ToV3({ workspace: sourceWorkspace, serializedV2: serializedSource, mediaStore });
        if (hasPhysicalLegacy) {
          let readbackV2;
          try { readbackV2 = storage.getItem(normalizedKeys.envelope); }
          catch (error) {
            return v3TransactionReceipt({ ok: false, code: "STORAGE_READ_FAILED", disposition: "NO_WRITE_READ_FAILED", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3", message: String(error?.message || error) });
          }
          if (readbackV2 !== physicalV2) {
            return v3TransactionReceipt({ ok: false, code: "LEGACY_WRITER_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3" });
          }
        } else {
          migrated = buildWorkspaceEnvelopeV3({
            profile: migrated.profile,
            activeDraftId: migrated.active_draft_id,
            previousDraftId: migrated.previous_draft_id,
            drafts: migrated.drafts,
            legacyV2Source: null,
            updatedAt: migrated.updated_at,
          });
        }
        return persistAndReadback(migrated, { reason: "BOOTSTRAP_WORKSPACE_V3" });
      } catch (error) {
        return v3TransactionReceipt({ ok: false, code: "WORKSPACE_V3_MIGRATION_FAILED", disposition: "NO_WRITE_MIGRATION_FAILED", snapshot: latest, reason: "BOOTSTRAP_WORKSPACE_V3", message: String(error?.message || error) });
      }
    });
  }

  async function migrateFromV2({ expectedV2Serialized = null } = {}) {
    return underExclusiveLock(async () => {
      const latest = snapshot();
      if (!latest.ok) return v3TransactionReceipt({ ok: false, code: latest.code, disposition: "NO_WRITE_READ_FAILED", snapshot: latest, reason: "MIGRATE_V2_TO_V3", message: latest.message });
      if (latest.workspace) {
        const legacy = await legacyWriterCheck(latest.workspace);
        return legacy.ok
          ? v3TransactionReceipt({ ok: true, code: "WORKSPACE_V3_ALREADY_CURRENT", disposition: "NOOP_ALREADY_APPLIED", snapshot: latest, reason: "MIGRATE_V2_TO_V3" })
          : v3TransactionReceipt({ ok: false, code: "LEGACY_WRITER_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason: "MIGRATE_V2_TO_V3", message: legacy.message });
      }
      let raw;
      try { raw = storage.getItem(normalizedKeys.envelope); }
      catch (error) { return v3TransactionReceipt({ ok: false, code: "STORAGE_READ_FAILED", disposition: "NO_WRITE_READ_FAILED", snapshot: latest, reason: "MIGRATE_V2_TO_V3", message: String(error?.message || error) }); }
      if (raw == null) return v3TransactionReceipt({ ok: false, code: "LEGACY_V2_WORKSPACE_MISSING", disposition: "NO_WRITE_READ_FAILED", snapshot: latest, reason: "MIGRATE_V2_TO_V3" });
      if (expectedV2Serialized != null && raw !== expectedV2Serialized) {
        return v3TransactionReceipt({ ok: false, code: "LEGACY_WRITER_CONFLICT", disposition: "NO_WRITE_CONFLICT", snapshot: latest, reason: "MIGRATE_V2_TO_V3" });
      }
      try {
        const migrated = await migrateWorkspaceEnvelopeV2ToV3({ workspace: parseWorkspaceEnvelope(raw), serializedV2: raw, mediaStore });
        return persistAndReadback(migrated, { reason: "MIGRATE_V2_TO_V3" });
      } catch (error) {
        return v3TransactionReceipt({ ok: false, code: "WORKSPACE_V3_MIGRATION_FAILED", disposition: "NO_WRITE_MIGRATION_FAILED", snapshot: latest, reason: "MIGRATE_V2_TO_V3", message: String(error?.message || error) });
      }
    });
  }

  return Object.freeze({
    snapshot,
    recoverySnapshot,
    recoverCorruptV3,
    fullCas,
    fullReplace: fullCas,
    mergeDraftCas,
    bootstrap,
    migrateFromV2,
  });
}

function imageTransactionCoordinator(value) {
  if (!value || typeof value.mergeDraftCas !== "function") throw new TypeError("WORKSPACE_V3_COORDINATOR_INVALID");
  return value;
}

function imageTransactionSnapshot(value, draftId, expectedDraftToken) {
  const record = parseDraftRecordV3(value);
  if (record.draft_id !== draftId || draftRecordToken(record) !== expectedDraftToken) {
    throw new TypeError("IMAGE_TRANSACTION_SNAPSHOT_MISMATCH");
  }
  if (!record.pending_image_operation) throw new TypeError("IMAGE_TRANSACTION_PENDING_MISSING");
  return record;
}

function imageTransactionLogicalToken(value, { ignoreCreatedAt = false } = {}) {
  const record = parseDraftRecordV3(value);
  const logical = structuredClone(record);
  delete logical.updated_at;
  if (ignoreCreatedAt) delete logical.created_at;
  if (logical.pending_image_operation) delete logical.pending_image_operation.updated_at;
  return JSON.stringify(logical);
}

function sameImageTransactionResult(left, right, options) {
  return imageTransactionLogicalToken(left, options) === imageTransactionLogicalToken(right, options);
}

function mergedManifestList(existing, added) {
  const byRef = new Map([...(existing || []), ...(added || [])].map((manifest) => [manifest.media_ref, manifest]));
  return [...byRef.values()];
}

function pendingProtocolState(value = "PARTIAL") {
  if (value === "PARTIAL") return "PARTIAL";
  if (value === "READY" || value === "READY_DISCOVERY") return "READY";
  throw new TypeError("IMAGE_TRANSACTION_RESPONSE_STATUS_INVALID");
}

function pendingAfterProgress(pending, imageResume, mediaManifest, updatedAt, protocolState = "PARTIAL") {
  return createPendingImageOperation({
    operationNonce: pending.operation_nonce,
    operationSnapshot: pending.operation_snapshot,
    operationSnapshotHash: pending.operation_snapshot_hash,
    inputHash: pending.input_hash,
    orderedReferenceManifest: pending.ordered_reference_manifest,
    materializedMediaManifest: mergedManifestList(pending.materialized_media_manifest, mediaManifest),
    protocolState: pendingProtocolState(protocolState),
    runId: imageResume.resume_run_id || pending.run_id,
    checkpointPreimageHash: imageResume.checkpoint_preimage_hash || pending.checkpoint_preimage_hash,
    checkpointHash: imageResume.checkpoint_hash || pending.checkpoint_hash,
    logicalStepId: imageResume.logical_step_id || pending.logical_step_id,
    attemptNonce: imageResume.attempt_nonce || pending.attempt_nonce,
    completedImageSteps: imageResume.completed_image_steps ?? pending.completed_image_steps,
    totalImageSteps: imageResume.total_image_steps ?? pending.total_image_steps,
    updatedAt,
  });
}

function imageTransactionStopped({ code, message, receipt = null, operationSnapshot, mediaManifest = [] }) {
  return {
    ...(receipt || {}),
    ok: false,
    code,
    ...(message == null ? {} : { message }),
    action: "STOP",
    checkpointPersisted: false,
    operation_snapshot: operationSnapshot,
    media_manifest: mediaManifest,
  };
}

async function stageImageTransactionMedia({ mediaStore, mediaDelta, persistentValue }) {
  const mediaManifest = await putAndReadbackMediaDelta(mediaStore, mediaDelta);
  await verifyWorkspaceMediaRefs(persistentValue, mediaStore);
  return mediaManifest;
}

function samePendingImageAuthority(left, right) {
  return left != null
    && right != null
    && left.operation_nonce === right.operation_nonce
    && left.operation_snapshot_hash === right.operation_snapshot_hash
    && left.input_hash === right.input_hash;
}

function recoveryProgressCanAdvance(existing, desired) {
  if (!samePendingImageAuthority(existing?.pending_image_operation, desired?.pending_image_operation)) return false;
  const previous = Number(existing.pending_image_operation.completed_image_steps ?? 0);
  const next = Number(desired.pending_image_operation.completed_image_steps ?? 0);
  if (!Number.isInteger(previous) || !Number.isInteger(next) || next < previous) return false;
  if (next === previous && !sameImageTransactionResult(existing, desired, { ignoreCreatedAt: true })) return false;
  const previousRun = existing.pending_image_operation.run_id;
  const nextRun = desired.pending_image_operation.run_id;
  return previousRun == null || nextRun == null || previousRun === nextRun;
}

async function commitImageRecoveryMoveV3({
  coordinator,
  targetDraftId,
  recoveredDraftId,
  operationSnapshot,
  buildRecoveredDraft,
  mediaManifest,
  updatedAt,
  reason,
} = {}) {
  if (typeof coordinator?.snapshot !== "function" || typeof coordinator?.fullCas !== "function") {
    return imageTransactionStopped({
      code: "WORKSPACE_V3_COORDINATOR_ATOMIC_RECOVERY_UNAVAILABLE",
      operationSnapshot,
      mediaManifest,
    });
  }
  const operationPending = operationSnapshot.pending_image_operation;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = coordinator.snapshot();
    if (!latest.ok || !latest.workspace) {
      return imageTransactionStopped({ code: latest.code || "WORKSPACE_V3_READ_FAILED", operationSnapshot, mediaManifest });
    }
    const latestTarget = latest.workspace.drafts.find((draft) => draft.draft_id === targetDraftId) || null;
    const existingRecovered = latest.workspace.drafts.find((draft) => draft.draft_id === recoveredDraftId) || null;
    if (!latestTarget) {
      return imageTransactionStopped({ code: "WORKSPACE_DRAFT_CAS_CONFLICT", operationSnapshot, mediaManifest });
    }
    const targetStillOwnsOperation = samePendingImageAuthority(latestTarget.pending_image_operation, operationPending);
    if (latestTarget.pending_image_operation != null && !targetStillOwnsOperation) {
      return imageTransactionStopped({ code: "WORKSPACE_DRAFT_CAS_CONFLICT", operationSnapshot, mediaManifest });
    }
    if (existingRecovered?.pending_image_operation != null
      && !samePendingImageAuthority(existingRecovered.pending_image_operation, operationPending)) {
      return imageTransactionStopped({ code: "WORKSPACE_RECOVERED_DRAFT_COLLISION", operationSnapshot, mediaManifest });
    }

    const desiredRecovered = buildRecoveredDraft(existingRecovered);
    if (existingRecovered) {
      const exactReplay = sameImageTransactionResult(existingRecovered, desiredRecovered, { ignoreCreatedAt: true });
      const canAdvance = desiredRecovered.pending_image_operation == null
        ? existingRecovered.pending_image_operation != null
        : recoveryProgressCanAdvance(existingRecovered, desiredRecovered);
      if (!exactReplay && !canAdvance) {
        return imageTransactionStopped({ code: "WORKSPACE_RECOVERED_DRAFT_COLLISION", operationSnapshot, mediaManifest });
      }
      if (exactReplay && !targetStillOwnsOperation) {
        return {
          ...latest,
          ok: true,
          code: "WORKSPACE_RECOVERED_DRAFT_ALREADY_APPLIED",
          disposition: "NOOP_ALREADY_APPLIED",
          target_draft: latestTarget,
          target_draft_token: draftRecordToken(latestTarget),
          recovered_draft: existingRecovered,
          recovered_draft_id: existingRecovered.draft_id,
          operation_snapshot: existingRecovered,
          media_manifest: mediaManifest,
          action: desiredRecovered.pending_image_operation == null ? "COMPLETE" : "STOP",
          checkpointPersisted: true,
        };
      }
    } else if (latest.workspace.drafts.length >= MAX_DRAFT_RECORDS) {
      return imageTransactionStopped({ code: "WORKSPACE_DRAFT_LIMIT_REACHED", operationSnapshot, mediaManifest });
    }

    const releasedTarget = targetStillOwnsOperation
      ? createDraftRecordV3({
        draftId: latestTarget.draft_id,
        contentPackage: latestTarget.content_package,
        generationSession: latestTarget.generation_session == null
          ? null
          : { ...latestTarget.generation_session, image_resume: null },
        pendingImageOperation: null,
        createdAt: latestTarget.created_at,
        updatedAt,
      })
      : latestTarget;
    const drafts = latest.workspace.drafts
      .filter((draft) => draft.draft_id !== recoveredDraftId)
      .map((draft) => draft.draft_id === targetDraftId ? releasedTarget : draft);
    const nextWorkspace = v3WorkspaceFromNormalized({
      workspace: latest.workspace,
      drafts: [desiredRecovered, ...drafts],
      updatedAt,
    });
    const receipt = await coordinator.fullCas({
      expectedWorkspaceToken: latest.workspace_token,
      workspace: nextWorkspace,
      reason,
    });
    if (!receipt.ok) {
      if (attempt === 0 && receipt.code === "WORKSPACE_V3_CAS_CONFLICT") continue;
      return imageTransactionStopped({ code: receipt.code, receipt, operationSnapshot, mediaManifest });
    }
    const committedTarget = receipt.workspace?.drafts.find((draft) => draft.draft_id === targetDraftId) || null;
    const committedRecovered = receipt.workspace?.drafts.find((draft) => draft.draft_id === recoveredDraftId) || null;
    if (!committedTarget
      || committedTarget.pending_image_operation != null
      || !committedRecovered
      || (desiredRecovered.pending_image_operation != null
        && !samePendingImageAuthority(committedRecovered.pending_image_operation, operationPending))) {
      return imageTransactionStopped({ code: "IMAGE_OPERATION_RECOVERY_READBACK_MISMATCH", receipt, operationSnapshot, mediaManifest });
    }
    return {
      ...receipt,
      ok: true,
      disposition: existingRecovered ? "RECOVERY_LANE_ADVANCED" : "RECOVERED_SIBLING_COMMITTED",
      target_draft: committedTarget,
      target_draft_token: draftRecordToken(committedTarget),
      recovered_draft: committedRecovered,
      recovered_draft_id: recoveredDraftId,
      operation_snapshot: committedRecovered,
      media_manifest: mediaManifest,
      action: committedRecovered.pending_image_operation == null ? "COMPLETE" : "STOP",
      checkpointPersisted: true,
    };
  }
  return imageTransactionStopped({ code: "WORKSPACE_V3_CAS_CONFLICT", operationSnapshot, mediaManifest });
}

export async function commitDraftImageProgressV3({
  coordinator: coordinatorValue,
  mediaStore,
  draftId,
  expectedDraftToken,
  operationSnapshot,
  recoveredDraftId,
  imageResume,
  responseStatus = "PARTIAL",
  mediaDelta = [],
  forceRecovery = false,
  updatedAt = new Date().toISOString(),
} = {}) {
  const coordinator = imageTransactionCoordinator(coordinatorValue);
  const targetId = requiredString(draftId, "draftId");
  if (typeof expectedDraftToken !== "string" || !expectedDraftToken) throw new TypeError("expectedDraftToken is required");
  const snapshotRecord = imageTransactionSnapshot(operationSnapshot, targetId, expectedDraftToken);
  const recoveredId = requiredString(recoveredDraftId, "recoveredDraftId");
  const recoveryLane = recoveredId === targetId;
  const timestamp = requiredString(updatedAt, "updatedAt");
  let resume;
  try { resume = normalizeV3ImageResume(imageResume); }
  catch (error) { throw new TypeError(`IMAGE_TRANSACTION_RESUME_INVALID:${error.message}`); }
  if (resume == null) throw new TypeError("IMAGE_TRANSACTION_RESUME_INVALID");
  const nextProtocolState = pendingProtocolState(responseStatus);
  let mediaManifest;
  try {
    mediaManifest = await putAndReadbackMediaDelta(mediaStore, mediaDelta);
    const pendingProbe = pendingAfterProgress(snapshotRecord.pending_image_operation, resume, mediaManifest, timestamp, nextProtocolState);
    await verifyWorkspaceMediaRefs({ image_resume: resume, pending_image_operation: pendingProbe }, mediaStore);
  } catch (error) {
    return imageTransactionStopped({
      code: "IMAGE_OPERATION_MEDIA_PERSIST_FAILED",
      message: String(error?.message || error),
      operationSnapshot: snapshotRecord,
    });
  }
  const pending = pendingAfterProgress(snapshotRecord.pending_image_operation, resume, mediaManifest, timestamp, nextProtocolState);
  const buildRecord = ({ sourceRecord, draftId: nextId, createdAt }) => createDraftRecordV3({
    draftId: nextId,
    contentPackage: sourceRecord.content_package,
    generationSession: { ...sourceRecord.generation_session, image_resume: resume },
    pendingImageOperation: pending,
    createdAt,
    updatedAt: timestamp,
  });
  const desiredTarget = buildRecord({ sourceRecord: snapshotRecord, draftId: targetId, createdAt: snapshotRecord.created_at });
  if (recoveryLane) {
    const sourceDraftId = requiredString(
      snapshotRecord.pending_image_operation.operation_snapshot?.draft_record_id,
      "pending_image_operation.operation_snapshot.draft_record_id",
    );
    if (sourceDraftId === targetId) {
      return imageTransactionStopped({ code: "IMAGE_OPERATION_RECOVERY_SOURCE_INVALID", operationSnapshot: snapshotRecord, mediaManifest });
    }
    const recoveredReceipt = await commitImageRecoveryMoveV3({
      coordinator,
      targetDraftId: sourceDraftId,
      recoveredDraftId: targetId,
      operationSnapshot: snapshotRecord,
      buildRecoveredDraft: (existingRecovered) => {
        const sourceRecord = existingRecovered?.pending_image_operation == null ? snapshotRecord : existingRecovered;
        const recoveredPending = pendingAfterProgress(sourceRecord.pending_image_operation, resume, mediaManifest, timestamp, nextProtocolState);
        return createDraftRecordV3({
          draftId: targetId,
          contentPackage: sourceRecord.content_package,
          generationSession: { ...sourceRecord.generation_session, image_resume: resume },
          pendingImageOperation: recoveredPending,
          createdAt: existingRecovered?.created_at || snapshotRecord.created_at,
          updatedAt: timestamp,
        });
      },
      mediaManifest,
      updatedAt: timestamp,
      reason: `IMAGE_PARTIAL_RECOVERY_ADVANCE_V3:${pending.operation_nonce}`,
    });
    if (!recoveredReceipt.ok) return recoveredReceipt;
    if (!recoveredReceipt.recovered_draft || recoveredReceipt.recovered_draft.pending_image_operation?.protocol_state !== nextProtocolState) {
      return imageTransactionStopped({ code: "IMAGE_OPERATION_PROGRESS_READBACK_MISMATCH", receipt: recoveredReceipt, operationSnapshot: snapshotRecord, mediaManifest });
    }
    return {
      ...recoveredReceipt,
      action: "CONTINUE",
      checkpointPersisted: true,
      operation_snapshot: recoveredReceipt.recovered_draft,
      media_manifest: mediaManifest,
      recovered_draft_id: targetId,
    };
  }
  const receipt = forceRecovery
    ? { ok: false, code: "WORKSPACE_DRAFT_CAS_CONFLICT" }
    : await coordinator.mergeDraftCas({
    draftId: targetId,
    expectedDraftToken,
    buildDraft: (target) => buildRecord({ sourceRecord: target, draftId: target.draft_id, createdAt: target.created_at }),
    isAlreadyApplied: ({ target_draft: target }) => sameImageTransactionResult(target, desiredTarget),
    reason: `IMAGE_PARTIAL_V3:${pending.operation_nonce}`,
    });
  if (!receipt.ok && receipt.code === "WORKSPACE_DRAFT_CAS_CONFLICT") {
    return commitImageRecoveryMoveV3({
      coordinator,
      targetDraftId: targetId,
      recoveredDraftId: recoveredId,
      operationSnapshot: snapshotRecord,
      buildRecoveredDraft: (existingRecovered) => {
        const sourceRecord = existingRecovered?.pending_image_operation == null ? snapshotRecord : existingRecovered;
        const recoveredPending = pendingAfterProgress(sourceRecord.pending_image_operation, resume, mediaManifest, timestamp, nextProtocolState);
        return createDraftRecordV3({
          draftId: recoveredId,
          contentPackage: sourceRecord.content_package,
          generationSession: { ...sourceRecord.generation_session, image_resume: resume },
          pendingImageOperation: recoveredPending,
          createdAt: existingRecovered?.created_at || timestamp,
          updatedAt: timestamp,
        });
      },
      mediaManifest,
      updatedAt: timestamp,
      reason: `IMAGE_PARTIAL_RECOVERY_MOVE_V3:${pending.operation_nonce}`,
    });
  }
  if (!receipt.ok) {
    return imageTransactionStopped({ code: receipt.code, receipt, operationSnapshot: snapshotRecord, mediaManifest });
  }
  if (!receipt.target_draft || receipt.target_draft.pending_image_operation?.protocol_state !== nextProtocolState) {
    return imageTransactionStopped({ code: "IMAGE_OPERATION_PROGRESS_READBACK_MISMATCH", receipt, operationSnapshot: snapshotRecord, mediaManifest });
  }
  return {
    ...receipt,
    action: "CONTINUE",
    checkpointPersisted: true,
    operation_snapshot: receipt.target_draft,
    media_manifest: mediaManifest,
    recovered_draft_id: null,
  };
}

export async function commitDraftImagePlannerFailureV3({
  coordinator: coordinatorValue,
  draftId,
  expectedDraftToken,
  operationSnapshot,
  updatedAt = new Date().toISOString(),
} = {}) {
  const coordinator = imageTransactionCoordinator(coordinatorValue);
  const targetId = requiredString(draftId, "draftId");
  if (typeof expectedDraftToken !== "string" || !expectedDraftToken) throw new TypeError("expectedDraftToken is required");
  const snapshotRecord = imageTransactionSnapshot(operationSnapshot, targetId, expectedDraftToken);
  const timestamp = requiredString(updatedAt, "updatedAt");
  const finalSession = {
    ...snapshotRecord.generation_session,
    image_resume: null,
  };
  const buildRecord = (target) => createDraftRecordV3({
    draftId: target.draft_id,
    contentPackage: target.content_package,
    generationSession: finalSession,
    pendingImageOperation: null,
    createdAt: target.created_at,
    updatedAt: timestamp,
  });
  const desiredTarget = buildRecord(snapshotRecord);
  const receipt = await coordinator.mergeDraftCas({
    draftId: targetId,
    expectedDraftToken,
    buildDraft: (target) => buildRecord(target),
    isAlreadyApplied: ({ target_draft: target }) => sameImageTransactionResult(target, desiredTarget),
    reason: `IMAGE_PLANNER_FAILED_V3:${snapshotRecord.pending_image_operation.operation_nonce}`,
  });
  if (!receipt.ok) return imageTransactionStopped({ code: receipt.code, receipt, operationSnapshot: snapshotRecord });
  const committed = receipt.target_draft;
  if (!committed || committed.pending_image_operation != null || committed.generation_session?.image_resume != null) {
    return imageTransactionStopped({ code: "IMAGE_PLANNER_FAILURE_READBACK_MISMATCH", receipt, operationSnapshot: snapshotRecord });
  }
  return {
    ...receipt,
    action: "RELEASED",
    operation_snapshot: snapshotRecord,
  };
}

function exactStringList(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function confirmedDraftFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    draft_id: value.draft_id,
    source_input: value.source_input,
    pillar: value.pillar,
    goal: value.goal,
    titles: value.titles,
    selected_title: value.selected_title,
    body: value.body,
    tags: value.tags,
    recommended_image_count: value.recommended_image_count,
    facts: value.facts,
    risks: value.risks,
    content_type: value.content_type || "knowledge_card",
    style_lock: value.style_lock || null,
    prompt_context: value.prompt_context || {},
  };
}

function sameConfirmedDraft(left, right) {
  const normalizedLeft = confirmedDraftFields(left);
  const normalizedRight = confirmedDraftFields(right);
  return normalizedLeft != null
    && normalizedRight != null
    && JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function frozenImageTextDraft(snapshotRecord) {
  const currentTextDraft = snapshotRecord.generation_session?.text_draft;
  const frozen = snapshotRecord.pending_image_operation?.operation_snapshot?.confirmed_draft;
  if (!currentTextDraft || !frozen) throw new TypeError("IMAGE_TRANSACTION_TEXT_NOT_CONFIRMED");
  return {
    ...currentTextDraft,
    ...confirmedDraftFields(frozen),
    schema: currentTextDraft.schema,
    text_requirements: currentTextDraft.text_requirements,
  };
}

function assertFinalImageContent(textDraftValue, contentPackage) {
  const content = checkedContent(contentPackage, "content_package");
  const textDraft = textDraftValue;
  if (!textDraft) throw new TypeError("IMAGE_TRANSACTION_TEXT_NOT_CONFIRMED");
  if (content.generation?.source_draft_id !== textDraft.draft_id) throw new TypeError("IMAGE_TRANSACTION_RESULT_LINEAGE_MISMATCH");
  if (
    content.source_input !== textDraft.source_input
    || content.pillar !== textDraft.pillar
    || content.goal !== textDraft.goal
    || content.selectedTitle !== textDraft.selected_title
    || content.body !== textDraft.body
    || !exactStringList(content.tags, textDraft.tags)
  ) throw new TypeError("IMAGE_TRANSACTION_RESULT_COPY_MISMATCH");
  assertPersistentRefOnly(content);
  return { content, textDraft };
}

function completedImageTransactionResult({
  receipt,
  targetDraft,
  recoveredDraft,
  snapshotRecord,
  mediaManifest,
  textDraft,
}) {
  const committed = recoveredDraft || targetDraft;
  if (
    !committed
    || committed.pending_image_operation != null
    || committed.generation_session?.image_resume != null
    || committed.generation_session?.assembled_draft_id !== textDraft.draft_id
  ) return imageTransactionStopped({ code: "IMAGE_OPERATION_FINAL_READBACK_MISMATCH", receipt, operationSnapshot: snapshotRecord, mediaManifest });
  return {
    ...receipt,
    target_draft: targetDraft,
    target_draft_token: targetDraft == null ? null : draftRecordToken(targetDraft),
    recovered_draft: recoveredDraft,
    action: "COMPLETE",
    operation_snapshot: snapshotRecord,
    media_manifest: mediaManifest,
    recovered_draft_id: recoveredDraft?.draft_id || null,
    adopt_current_ui: recoveredDraft == null && receipt.workspace?.active_draft_id === targetDraft?.draft_id,
  };
}

export async function commitDraftImageCompletionV3({
  coordinator: coordinatorValue,
  mediaStore,
  draftId,
  expectedDraftToken,
  operationSnapshot,
  recoveredDraftId,
  contentPackage,
  mediaDelta = [],
  forceRecovery = false,
  updatedAt = new Date().toISOString(),
} = {}) {
  const coordinator = imageTransactionCoordinator(coordinatorValue);
  const targetId = requiredString(draftId, "draftId");
  if (typeof expectedDraftToken !== "string" || !expectedDraftToken) throw new TypeError("expectedDraftToken is required");
  const snapshotRecord = imageTransactionSnapshot(operationSnapshot, targetId, expectedDraftToken);
  const recoveredId = requiredString(recoveredDraftId, "recoveredDraftId");
  const recoveryLane = recoveredId === targetId;
  const timestamp = requiredString(updatedAt, "updatedAt");
  const frozenTextDraft = frozenImageTextDraft(snapshotRecord);
  const { content, textDraft } = assertFinalImageContent(frozenTextDraft, contentPackage);
  let mediaManifest;
  try {
    mediaManifest = await stageImageTransactionMedia({ mediaStore, mediaDelta, persistentValue: content });
    const reachable = new Set(collectMediaRefs(content));
    if (mediaManifest.some((manifest) => !reachable.has(manifest.media_ref))) throw new TypeError("IMAGE_TRANSACTION_UNUSED_MEDIA_DELTA");
  } catch (error) {
    return imageTransactionStopped({
      code: "IMAGE_OPERATION_MEDIA_PERSIST_FAILED",
      message: String(error?.message || error),
      operationSnapshot: snapshotRecord,
    });
  }
  const finalSession = {
    ...snapshotRecord.generation_session,
    topic: textDraft.source_input,
    pillar: textDraft.pillar,
    goal: textDraft.goal,
    text_requirements: textDraft.text_requirements,
    text_draft: textDraft,
    text_confirmed: true,
    assembled_draft_id: textDraft.draft_id,
    image_resume: null,
  };
  const buildRecord = ({ draftId: nextId, createdAt, saveToLibrary = false, sourceRecord = snapshotRecord }) => createDraftRecordV3({
    draftId: nextId,
    contentPackage: saveToLibrary
      ? { ...content, id: nextId, saved_at: timestamp }
      : draftContentWithPreservedBookkeepingV3({ contentPackage: content, draftRecord: sourceRecord }),
    generationSession: finalSession,
    pendingImageOperation: null,
    createdAt,
    updatedAt: timestamp,
  });
  const desiredTarget = buildRecord({
    draftId: targetId,
    createdAt: snapshotRecord.created_at,
    saveToLibrary: recoveryLane,
  });
  if (recoveryLane) {
    const sourceDraftId = requiredString(
      snapshotRecord.pending_image_operation.operation_snapshot?.draft_record_id,
      "pending_image_operation.operation_snapshot.draft_record_id",
    );
    if (sourceDraftId === targetId) {
      return imageTransactionStopped({ code: "IMAGE_OPERATION_RECOVERY_SOURCE_INVALID", operationSnapshot: snapshotRecord, mediaManifest });
    }
    const recoveredReceipt = await commitImageRecoveryMoveV3({
      coordinator,
      targetDraftId: sourceDraftId,
      recoveredDraftId: targetId,
      operationSnapshot: snapshotRecord,
      buildRecoveredDraft: (existingRecovered) => buildRecord({
        draftId: targetId,
        createdAt: existingRecovered?.created_at || snapshotRecord.created_at,
        saveToLibrary: true,
        sourceRecord: existingRecovered || snapshotRecord,
      }),
      mediaManifest,
      updatedAt: timestamp,
      reason: `IMAGE_COMPLETE_RECOVERY_ADVANCE_V3:${snapshotRecord.pending_image_operation.operation_nonce}`,
    });
    if (!recoveredReceipt.ok || recoveredReceipt.action !== "COMPLETE") return recoveredReceipt;
    return completedImageTransactionResult({
      receipt: recoveredReceipt,
      targetDraft: recoveredReceipt.target_draft,
      recoveredDraft: recoveredReceipt.recovered_draft,
      snapshotRecord,
      mediaManifest,
      textDraft,
    });
  }
  if (!recoveryLane && (forceRecovery || !sameConfirmedDraft(snapshotRecord.generation_session?.text_draft, frozenTextDraft))) {
    const recoveredReceipt = await commitImageRecoveryMoveV3({
      coordinator,
      targetDraftId: targetId,
      recoveredDraftId: recoveredId,
      operationSnapshot: snapshotRecord,
      buildRecoveredDraft: (existingRecovered) => buildRecord({
        draftId: recoveredId,
        createdAt: existingRecovered?.created_at || timestamp,
        saveToLibrary: true,
      }),
      mediaManifest,
      updatedAt: timestamp,
      reason: `IMAGE_COMPLETE_FROZEN_LINEAGE_RECOVERY_V3:${snapshotRecord.pending_image_operation.operation_nonce}`,
    });
    if (!recoveredReceipt.ok || recoveredReceipt.action !== "COMPLETE") return recoveredReceipt;
    return completedImageTransactionResult({
      receipt: recoveredReceipt,
      targetDraft: recoveredReceipt.target_draft,
      recoveredDraft: recoveredReceipt.recovered_draft,
      snapshotRecord,
      mediaManifest,
      textDraft,
    });
  }
  const receipt = await coordinator.mergeDraftCas({
    draftId: targetId,
    expectedDraftToken,
    buildDraft: (target) => buildRecord({
      draftId: target.draft_id,
      createdAt: target.created_at,
      saveToLibrary: recoveryLane,
      sourceRecord: target,
    }),
    isAlreadyApplied: ({ target_draft: target }) => sameImageTransactionResult(target, desiredTarget),
    reason: `IMAGE_COMPLETE_V3:${snapshotRecord.pending_image_operation.operation_nonce}`,
  });
  if (!receipt.ok && receipt.code === "WORKSPACE_DRAFT_CAS_CONFLICT" && !recoveryLane) {
    const recoveredReceipt = await commitImageRecoveryMoveV3({
      coordinator,
      targetDraftId: targetId,
      recoveredDraftId: recoveredId,
      operationSnapshot: snapshotRecord,
      buildRecoveredDraft: (existingRecovered) => buildRecord({
        draftId: recoveredId,
        createdAt: existingRecovered?.created_at || timestamp,
        saveToLibrary: true,
      }),
      mediaManifest,
      updatedAt: timestamp,
      reason: `IMAGE_COMPLETE_RECOVERY_MOVE_V3:${snapshotRecord.pending_image_operation.operation_nonce}`,
    });
    if (!recoveredReceipt.ok || recoveredReceipt.action !== "COMPLETE") return recoveredReceipt;
    return completedImageTransactionResult({
      receipt: recoveredReceipt,
      targetDraft: recoveredReceipt.target_draft,
      recoveredDraft: recoveredReceipt.recovered_draft,
      snapshotRecord,
      mediaManifest,
      textDraft,
    });
  }
  if (!receipt.ok) return imageTransactionStopped({ code: receipt.code, receipt, operationSnapshot: snapshotRecord, mediaManifest });
  return completedImageTransactionResult({
    receipt,
    targetDraft: receipt.target_draft,
    recoveredDraft: receipt.recovered_draft,
    snapshotRecord,
    mediaManifest,
    textDraft,
  });
}

async function backupMediaEntry(value, path = "media_asset") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} is invalid`);
  const manifest = normalizeMediaManifest(value, path);
  const bytes = base64ToBytes(value.bytes_base64);
  const verified = await verifiedMediaReceipt({ ...manifest, bytes }, manifest);
  if (bytesToBase64(verified.bytes) !== value.bytes_base64) throw new TypeError("WORKSPACE_BACKUP_MEDIA_BASE64_NON_CANONICAL");
  return {
    schema: "xiaoshimei.media-asset-backup.v1",
    ...normalizeMediaManifest(verified, path),
    bytes_base64: value.bytes_base64,
  };
}

function exactMediaSet(workspace, assets) {
  const reachable = collectMediaRefs(workspace);
  const embedded = assets.map((asset) => asset.media_ref);
  if (new Set(embedded).size !== embedded.length) throw new TypeError("WORKSPACE_BACKUP_MEDIA_DUPLICATE");
  if (JSON.stringify([...embedded].sort()) !== JSON.stringify(reachable)) {
    throw new TypeError("WORKSPACE_BACKUP_MEDIA_SET_MISMATCH");
  }
  return reachable;
}

export async function buildWorkspaceBackupV3({ workspace, mediaStore, createdAt = new Date().toISOString() } = {}) {
  const checked = parseWorkspaceEnvelopeV3(workspace);
  const refs = collectMediaRefs(checked);
  const store = refs.length ? mediaStoreAdapter(mediaStore) : null;
  const mediaAssets = [];
  for (const mediaRef of refs) {
    const readback = await store.readVerifiedMedia(mediaRef);
    const verified = await verifiedMediaReceipt(readback, { media_ref: mediaRef, sha256: MEDIA_REF_RE.exec(mediaRef)[1] });
    mediaAssets.push({
      schema: "xiaoshimei.media-asset-backup.v1",
      ...normalizeMediaManifest(verified, "backup_media"),
      bytes_base64: bytesToBase64(verified.bytes),
    });
  }
  mediaAssets.sort((left, right) => left.sha256.localeCompare(right.sha256));
  exactMediaSet(checked, mediaAssets);
  return {
    schema: WORKSPACE_BACKUP_V3_SCHEMA,
    created_at: requiredString(createdAt, "createdAt"),
    authority_effect: LOCAL_AUTHORITY_EFFECT,
    workspace: checked,
    media_assets: mediaAssets,
  };
}

export async function parseWorkspaceBackupV3(serialized) {
  let value = serialized;
  if (typeof serialized === "string") {
    try { value = JSON.parse(serialized); }
    catch { throw new TypeError("workspace backup is not valid JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== WORKSPACE_BACKUP_V3_SCHEMA) {
    throw new TypeError("workspace backup v3 schema is not supported");
  }
  if (value.authority_effect !== LOCAL_AUTHORITY_EFFECT) throw new TypeError("workspace backup cannot carry authority");
  const createdAt = requiredString(value.created_at, "created_at");
  // A v3 backup is a same-workspace authority snapshot, not an untrusted
  // external draft import. Re-parse the strict content contract without the
  // import downgrade so FULL_DRAFT, USER review and provider lineage survive
  // a byte-equivalent backup/restore round trip.
  const workspace = normalizeWorkspaceEnvelopeV3(value.workspace);
  if (!Array.isArray(value.media_assets)) throw new TypeError("workspace backup media_assets is invalid");
  const mediaAssets = [];
  for (let index = 0; index < value.media_assets.length; index += 1) {
    mediaAssets.push(await backupMediaEntry(value.media_assets[index], `media_assets[${index}]`));
  }
  const sorted = [...mediaAssets].sort((left, right) => left.sha256.localeCompare(right.sha256));
  if (JSON.stringify(sorted.map((item) => item.sha256)) !== JSON.stringify(mediaAssets.map((item) => item.sha256))) {
    throw new TypeError("WORKSPACE_BACKUP_MEDIA_ORDER_INVALID");
  }
  exactMediaSet(workspace, mediaAssets);
  return {
    schema: WORKSPACE_BACKUP_V3_SCHEMA,
    created_at: createdAt,
    authority_effect: LOCAL_AUTHORITY_EFFECT,
    workspace,
    media_assets: mediaAssets,
  };
}

async function legacyBackupWorkspace(serialized) {
  let value;
  try { value = typeof serialized === "string" ? JSON.parse(serialized) : structuredClone(serialized); }
  catch { throw new TypeError("workspace backup is not valid JSON"); }
  if (value?.schema === WORKSPACE_BACKUP_V2_SCHEMA) return parseWorkspaceBackupV2(value);
  if (value?.schema === WORKSPACE_BACKUP_SCHEMA) {
    const legacy = parseWorkspaceBackup(JSON.stringify(value));
    return migrateLegacyWorkspaceState({
      profile: legacy.profile,
      currentContent: legacy.currentContent,
      library: legacy.library,
      activeDraftId: legacy.currentContent?.id || "restored-v1-active",
      createdAt: value.created_at,
    });
  }
  return null;
}

export async function restoreWorkspaceBackupV3({
  serialized,
  coordinator,
  mediaStore,
  expectedWorkspaceToken,
  recoveryPrecondition = null,
} = {}) {
  if (!coordinator || typeof coordinator.fullCas !== "function" || typeof coordinator.snapshot !== "function") {
    throw new TypeError("WORKSPACE_V3_COORDINATOR_INVALID");
  }
  const recoveryMode = recoveryPrecondition != null;
  if (recoveryMode && typeof coordinator.recoverCorruptV3 !== "function") throw new TypeError("WORKSPACE_V3_RECOVERY_COORDINATOR_INVALID");
  if (!recoveryMode && (typeof expectedWorkspaceToken !== "string" || !expectedWorkspaceToken)) {
    throw new TypeError("expectedWorkspaceToken is required");
  }
  let value;
  try { value = typeof serialized === "string" ? JSON.parse(serialized) : structuredClone(serialized); }
  catch { throw new TypeError("workspace backup is not valid JSON"); }
  let restoredWorkspace;
  if (value?.schema === WORKSPACE_BACKUP_V3_SCHEMA) {
    const parsed = await parseWorkspaceBackupV3(value);
    await putAndReadbackMediaDelta(mediaStore, parsed.media_assets.map((asset) => ({
      bytes: base64ToBytes(asset.bytes_base64),
      sha256: asset.sha256,
      mime: asset.mime,
      name: asset.name,
    })));
    const current = coordinator.snapshot();
    restoredWorkspace = buildWorkspaceEnvelopeV3({
      profile: parsed.workspace.profile,
      activeDraftId: parsed.workspace.active_draft_id,
      previousDraftId: parsed.workspace.previous_draft_id,
      drafts: parsed.workspace.drafts,
      // A backup belongs to the target origin. Preserve the current origin's
      // legacy writer fence when replacing, and clear the source on clean-origin restore.
      legacyV2Source: recoveryMode
        ? (recoveryPrecondition.legacy_v2_source || null)
        : (current.workspace?.legacy_v2_source || null),
      updatedAt: parsed.workspace.updated_at,
    });
  } else {
    const v2 = await legacyBackupWorkspace(value);
    if (!v2) throw new TypeError("workspace backup schema is not supported");
    const raw = JSON.stringify(v2);
    const migrated = await migrateWorkspaceEnvelopeV2ToV3({ workspace: v2, serializedV2: raw, mediaStore });
    const current = coordinator.snapshot();
    restoredWorkspace = buildWorkspaceEnvelopeV3({
      profile: migrated.profile,
      activeDraftId: migrated.active_draft_id,
      previousDraftId: migrated.previous_draft_id,
      drafts: migrated.drafts,
      legacyV2Source: recoveryMode
        ? (recoveryPrecondition.legacy_v2_source || null)
        : (current.workspace?.legacy_v2_source || null),
      updatedAt: migrated.updated_at,
    });
  }
  const receipt = recoveryMode
    ? await coordinator.recoverCorruptV3({
      recoveryPrecondition,
      workspace: restoredWorkspace,
      reason: "RECOVER_WORKSPACE_BACKUP_V3",
    })
    : await coordinator.fullCas({
      expectedWorkspaceToken,
      workspace: restoredWorkspace,
      reason: "RESTORE_WORKSPACE_BACKUP_V3",
    });
  if (!receipt.ok) return receipt;
  // Every reachable asset was committed and read back before the workspace
  // transaction. fullCas performs the final same-origin workspace readback;
  // nothing fallible may run after that commit and turn a successful replace
  // into a reported failure with a changed preimage.
  return {
    ...receipt,
    code: recoveryMode
      ? "WORKSPACE_BACKUP_V3_RECOVERED_AND_VERIFIED"
      : "WORKSPACE_BACKUP_V3_RESTORED_AND_VERIFIED",
  };
}
