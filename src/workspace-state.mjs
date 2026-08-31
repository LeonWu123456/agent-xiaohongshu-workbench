import { generateContentPackage, importLocalEditableDraft, parseContentPackage } from "./content-engine.mjs";
import { GENERATION_SESSION_SCHEMA, parseGenerationSession } from "./generation-session.mjs";
import { normalizeProfileV2, parseProfileV2 } from "./profile-v2.mjs";

export const WORKSPACE_BACKUP_SCHEMA = "xiaoshimei.workspace-backup.v1";
export const WORKSPACE_BACKUP_V2_SCHEMA = "xiaoshimei.workspace-backup.v2";
export const WORKSPACE_ENVELOPE_SCHEMA = "xiaoshimei.workspace-envelope.v2";
export const DRAFT_RECORD_SCHEMA = "xiaoshimei.draft-record.v2";
export const AUTHORING_SESSION_SCHEMA = "xiaoshimei.authoring-session.v2";

const LOCAL_AUTHORITY_EFFECT = "LOCAL_EDITING_ONLY";
// v1 allowed one current draft plus 50 library entries. A mismatched legacy
// content/session pair needs one extra record during repair; never evict either
// side merely to fit the old split-store limit.
const MAX_DRAFT_RECORDS = 100;

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
    if (source.text_draft != null) {
      const parsed = parseGenerationSession({ ...source, schema: GENERATION_SESSION_SCHEMA });
      return { ...parsed, schema: AUTHORING_SESSION_SCHEMA };
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

export function activeDraftRecord(value) {
  const workspace = parseWorkspaceEnvelope(value);
  return workspace.drafts.find((draft) => draft.draft_id === workspace.active_draft_id);
}

function libraryContentsFromNormalized(workspace) {
  return workspace.drafts
    .filter((draft) => Boolean(draft.content_package.saved_at))
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
