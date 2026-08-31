import assert from "node:assert/strict";
import test from "node:test";
import { generateContentPackage } from "../src/content-engine.mjs";
import { GENERATION_SESSION_SCHEMA } from "../src/generation-session.mjs";
import { createProfileV2 } from "../src/profile-v2.mjs";
import {
  AUTHORING_SESSION_SCHEMA,
  DRAFT_RECORD_SCHEMA,
  WORKSPACE_BACKUP_V2_SCHEMA,
  WORKSPACE_ENVELOPE_SCHEMA,
  activateDraftRecord,
  activeDraftRecord,
  beginNewDraft,
  buildWorkspaceBackupV2,
  legacyStateFromWorkspaceEnvelope,
  libraryContents,
  loadOrMigrateWorkspaceEnvelope,
  loadWorkspaceEnvelope,
  migrateLegacyWorkspaceState,
  parseWorkspaceBackup,
  parseWorkspaceBackupV2,
  persistWorkspaceEnvelope,
  persistDraftRecordWithReadback,
  saveActiveDraft,
} from "../src/workspace-state.mjs";

const T0 = "2026-08-31T06:00:00.000Z";
const T1 = "2026-08-31T06:05:00.000Z";
const KEYS = {
  envelope: "workspace-v2",
  content: "content-v1",
  library: "library-v1",
  profile: "profile-v1",
  generationSession: "generation-v1",
};

function content(topic, id) {
  return { ...generateContentPackage({ topic, pillar: "culture", goal: "save" }), ...(id ? { id, saved_at: T0 } : {}) };
}

function textDraft(id = "text-1", topic = "秋天先照顾好自己的节奏") {
  return {
    schema: "xiaoshimei.text-draft-response.v1",
    draft_id: id,
    created_at: T0,
    source_input: topic,
    text_requirements: "",
    prompt_context: {},
    pillar: "culture",
    goal: "save",
    titles: ["秋天先慢下来", "把节奏调回日常", "入秋后的三个小动作"],
    selected_title: "秋天先慢下来",
    body: "先把今天真正需要做的事情写下来，再给身体留一点缓冲。".repeat(16),
    tags: ["东方生活", "入秋日常", "节奏调整", "生活方式", "小师妹日常"],
    recommended_image_count: 5,
    facts: [],
    risks: [],
    generation: {},
  };
}

function fullSession(id = "text-1") {
  return {
    schema: GENERATION_SESSION_SCHEMA,
    topic: "秋天先照顾好自己的节奏",
    pillar: "culture",
    goal: "save",
    text_requirements: "",
    text_draft: textDraft(id),
    text_confirmed: true,
    assembled_draft_id: id,
    image_count_mode: "AUTO",
    custom_image_count: 5,
    production_mode: "smart",
    image_resume: { resume_run_id: "images-2026-08-31T060000Z-abcdef12", completed_mother_sheets: 1 },
  };
}

function assembledContent(session, id) {
  const draft = session.text_draft;
  return {
    ...generateContentPackage({ topic: draft.source_input, pillar: draft.pillar, goal: draft.goal }),
    id,
    saved_at: T0,
    source_input: draft.source_input,
    pillar: draft.pillar,
    goal: draft.goal,
    titles: draft.titles,
    selectedTitle: draft.selected_title,
    body: draft.body,
    tags: draft.tags,
  };
}

function sourceOnlySession(topic = "还没生成文字的原文") {
  return {
    schema: AUTHORING_SESSION_SCHEMA,
    topic,
    pillar: "wellness",
    goal: "save",
    text_requirements: "保留我的语气",
    text_draft: null,
    text_confirmed: false,
    assembled_draft_id: null,
    image_count_mode: "AUTO",
    custom_image_count: 5,
    production_mode: "smart",
    image_resume: null,
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("legacy split keys migrate once into one v2 draft authority without losing the active generation session", () => {
  const session = fullSession();
  const storage = memoryStorage({
    [KEYS.content]: JSON.stringify(assembledContent(session, "current")),
    [KEYS.library]: JSON.stringify([content("资产库旧稿", "library-1")]),
    [KEYS.profile]: JSON.stringify(createProfileV2()),
    [KEYS.generationSession]: JSON.stringify(session),
  });

  const loaded = loadOrMigrateWorkspaceEnvelope(storage, KEYS, { createdAt: T1 });
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.workspace.schema, WORKSPACE_ENVELOPE_SCHEMA);
  assert.equal(loaded.workspace.active_draft_id, "current");
  assert.equal(loaded.workspace.drafts.length, 2);
  assert.equal(activeDraftRecord(loaded.workspace).schema, DRAFT_RECORD_SCHEMA);
  assert.equal(activeDraftRecord(loaded.workspace).generation_session.schema, AUTHORING_SESSION_SCHEMA);
  assert.equal(activeDraftRecord(loaded.workspace).generation_session.text_draft.draft_id, "text-1");
  assert.ok(libraryContents(loaded.workspace).some((item) => item.id === "library-1"));
});

test("migration splits stale content A from unrelated authoring session B and makes B active", () => {
  const sessionB = fullSession("authoring-b");
  const workspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("处暑居家调养三步法", "content-a"),
    generationSession: sessionB,
    activeDraftId: "content-a",
    createdAt: T1,
  });

  assert.equal(workspace.active_draft_id, "authoring-b");
  assert.equal(workspace.drafts.length, 2);
  assert.equal(activeDraftRecord(workspace).generation_session.text_draft.draft_id, "authoring-b");
  assert.equal(activeDraftRecord(workspace).content_package.source_input, sessionB.topic);
  const preservedA = workspace.drafts.find((draft) => draft.draft_id === "content-a");
  assert.equal(preservedA.content_package.source_input, "处暑居家调养三步法");
  assert.equal(preservedA.generation_session, null);
  assert.equal(preservedA.content_package.saved_at, T0);
  assert.equal(libraryContents(workspace)[0].draft_record_id, "content-a");
});

test("asset projection includes a saved active draft and addresses records independently of duplicate content ids", () => {
  const workspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("当前已保存稿", "duplicate-id"),
    library: [content("另一篇历史稿", "duplicate-id")],
    activeDraftId: "duplicate-id",
    createdAt: T1,
  });
  const projected = libraryContents(workspace);
  assert.equal(projected.length, 2);
  assert.deepEqual(projected.map((item) => item.id), ["duplicate-id", "duplicate-id"]);
  assert.deepEqual(projected.map((item) => item.draft_record_id), ["duplicate-id", "duplicate-id-2"]);
  assert.ok(projected.some((item) => item.draft_record_id === workspace.active_draft_id));
});

test("new creation snapshots source-only work and returns a reversible previousDraftId", () => {
  const initial = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("旧的页面稿", "old"),
    library: [],
    activeDraftId: "old",
    createdAt: T0,
  });
  const original = structuredClone(initial);
  const switched = beginNewDraft(initial, {
    newDraftId: "new",
    currentContent: content("还没组装成页面，但原文不能丢", "old"),
    currentSession: sourceOnlySession("还没组装成页面，但原文不能丢"),
    savedAt: T1,
  });

  assert.deepEqual(initial, original, "pure transition must not mutate its input");
  assert.equal(switched.previousDraftId, "old");
  assert.equal(switched.workspace.active_draft_id, "new");
  assert.equal(switched.activeDraft.generation_session, null);
  const old = switched.workspace.drafts.find((draft) => draft.draft_id === "old");
  assert.equal(old.generation_session.text_draft, null);
  assert.equal(old.generation_session.topic, "还没组装成页面，但原文不能丢");

  const returned = activateDraftRecord(switched.workspace, switched.previousDraftId, { activatedAt: T1 });
  assert.equal(returned.previousDraftId, "new");
  assert.equal(returned.activeDraft.generation_session.topic, "还没组装成页面，但原文不能丢");
  assert.equal(returned.workspace.active_draft_id, "old");
});

test("saving one draft never leaks its text or image resume state into another draft", () => {
  const firstSession = fullSession("first-text");
  const initial = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: assembledContent(firstSession, "first"),
    generationSession: firstSession,
    activeDraftId: "first",
    createdAt: T0,
  });
  const { workspace: secondActive } = beginNewDraft(initial, { newDraftId: "second", savedAt: T1 });
  const savedSecond = saveActiveDraft(secondActive, {
    contentPackage: content("第二稿", "second"),
    generationSession: sourceOnlySession("第二稿只有原文"),
    savedAt: T1,
  });
  const firstAgain = activateDraftRecord(savedSecond, "first", { activatedAt: T1 });
  assert.equal(firstAgain.activeDraft.generation_session.text_draft.draft_id, "first-text");
  assert.equal(firstAgain.activeDraft.generation_session.image_resume.completed_mother_sheets, 1);
  const second = firstAgain.workspace.drafts.find((draft) => draft.draft_id === "second");
  assert.equal(second.generation_session.topic, "第二稿只有原文");
  assert.equal(second.generation_session.image_resume, null);
});

test("v2 backup restores every draft together with its generation session and imports no authority", () => {
  const session = fullSession("backup-text");
  let workspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: assembledContent(session, "backup-draft"),
    generationSession: session,
    activeDraftId: "backup-draft",
    createdAt: T0,
  });
  const authoritativeLooking = structuredClone(activeDraftRecord(workspace).content_package);
  authoritativeLooking.review = { source: "INDEPENDENT_EVIDENCE", decision: "KEEP", reviewed_at: T0, authority_effect: "EVIDENCE_ONLY" };
  workspace = saveActiveDraft(workspace, { contentPackage: authoritativeLooking, savedAt: T1 });

  const backup = buildWorkspaceBackupV2({ workspace, createdAt: T1 });
  assert.equal(backup.schema, WORKSPACE_BACKUP_V2_SCHEMA);
  const restored = parseWorkspaceBackupV2(JSON.stringify(backup));
  assert.equal(activeDraftRecord(restored).generation_session.text_draft.draft_id, "backup-text");
  assert.equal(activeDraftRecord(restored).content_package.review.source, "NONE");
  assert.equal(activeDraftRecord(restored).content_package.review.decision, "IMPORTED_LOCAL_DRAFT_REQUIRES_REVIEW");

  const compatible = parseWorkspaceBackup(JSON.stringify(backup));
  assert.equal(compatible.workspaceEnvelope.schema, WORKSPACE_ENVELOPE_SCHEMA);
  assert.equal(compatible.authoringSession.text_draft.draft_id, "backup-text");
  assert.equal(compatible.generationSession.schema, GENERATION_SESSION_SCHEMA);
});

test("persist writes the v2 authority and every legacy projection as one rollback-safe transaction", () => {
  const storage = memoryStorage();
  const session = fullSession();
  const workspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: assembledContent(session, "active"),
    library: [content("旧稿", "old")],
    generationSession: session,
    activeDraftId: "active",
    createdAt: T0,
  });
  const result = persistWorkspaceEnvelope(storage, workspace, KEYS);
  assert.deepEqual(result, { ok: true, code: "WORKSPACE_ENVELOPE_SAVED" });
  assert.equal(loadWorkspaceEnvelope(storage, KEYS.envelope).active_draft_id, "active");
  assert.equal(JSON.parse(storage.getItem(KEYS.content)).source_input, "秋天先照顾好自己的节奏");
  assert.ok(JSON.parse(storage.getItem(KEYS.library)).some((item) => item.id === "old"));
  assert.equal(JSON.parse(storage.getItem(KEYS.generationSession)).schema, GENERATION_SESSION_SCHEMA);
});

test("image progress is saved into the active DraftRecord and read back from the same workspace authority before continuation", () => {
  const storage = memoryStorage();
  const session = fullSession();
  const workspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: assembledContent(session, "active"),
    generationSession: session,
    activeDraftId: "active",
    createdAt: T0,
  });
  const progress = {
    resume_run_id: "images-2026-08-31T060000Z-abcdef12",
    completed_image_steps: 2,
    total_image_steps: 4,
    max_image_calls: 6,
    actual_image_calls: 2,
    remaining_image_calls: 4,
    resume_checkpoint: { signature: "a".repeat(64), max_image_calls: 6, actual_image_calls: 2 },
  };
  const result = persistDraftRecordWithReadback(storage, workspace, KEYS, {
    generationSession: { ...session, image_resume: progress },
    updatedAt: T1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "WORKSPACE_DRAFT_SAVED_AND_VERIFIED");
  assert.deepEqual(result.draft_record.generation_session.image_resume, progress);
  assert.deepEqual(activeDraftRecord(loadWorkspaceEnvelope(storage, KEYS.envelope)).generation_session.image_resume, progress);
});

test("image continuation fails closed when same-source readback drifts after a successful write", () => {
  const storage = memoryStorage();
  const normalGet = storage.getItem;
  let distortReadback = false;
  const normalSet = storage.setItem;
  storage.setItem = (key, value) => {
    normalSet(key, value);
    if (key === KEYS.generationSession) distortReadback = true;
  };
  storage.getItem = (key) => {
    const value = normalGet(key);
    if (!distortReadback || key !== KEYS.envelope || value == null) return value;
    const parsed = JSON.parse(value);
    parsed.updated_at = T0;
    return JSON.stringify(parsed);
  };
  const session = fullSession();
  const workspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: assembledContent(session, "active"),
    generationSession: session,
    activeDraftId: "active",
    createdAt: T0,
  });
  const result = persistDraftRecordWithReadback(storage, workspace, KEYS, {
    generationSession: { ...session, image_resume: { ...session.image_resume, completed_mother_sheets: 2 } },
    updatedAt: T1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKSPACE_READBACK_MISMATCH");
});

test("a failure in any projected write restores every preimage, including the old generation session", () => {
  const initial = {
    [KEYS.envelope]: "old-envelope",
    [KEYS.content]: "old-content",
    [KEYS.library]: "old-library",
    [KEYS.profile]: "old-profile",
    [KEYS.generationSession]: "old-generation",
  };
  const storage = memoryStorage(initial);
  let failed = false;
  const normalSet = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === KEYS.profile && !failed) {
      failed = true;
      throw new Error("quota exceeded");
    }
    normalSet(key, value);
  };
  const workspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("不能半写", "active"),
    generationSession: sourceOnlySession(),
    activeDraftId: "active",
    createdAt: T0,
  });

  const result = persistWorkspaceEnvelope(storage, workspace, KEYS);
  assert.equal(result.ok, false);
  assert.equal(result.code, "STORAGE_WRITE_FAILED");
  assert.deepEqual(Object.fromEntries(storage.values), initial);
});

test("a failed source-only legacy-session removal also rolls the whole transaction back", () => {
  const initial = {
    [KEYS.envelope]: "old-envelope",
    [KEYS.content]: "old-content",
    [KEYS.library]: "old-library",
    [KEYS.profile]: "old-profile",
    [KEYS.generationSession]: "old-generation",
  };
  const storage = memoryStorage(initial);
  let failed = false;
  const normalRemove = storage.removeItem;
  storage.removeItem = (key) => {
    if (key === KEYS.generationSession && !failed) {
      failed = true;
      throw new Error("remove denied");
    }
    normalRemove(key);
  };
  const workspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("只有原文", "active"),
    generationSession: sourceOnlySession("只有原文"),
    activeDraftId: "active",
    createdAt: T0,
  });
  const result = persistWorkspaceEnvelope(storage, workspace, KEYS);
  assert.equal(result.code, "STORAGE_WRITE_FAILED");
  assert.deepEqual(Object.fromEntries(storage.values), initial);
});

test("an empty installation can migrate from explicit fallbacks without inventing a second store", () => {
  const storage = memoryStorage();
  const loaded = loadOrMigrateWorkspaceEnvelope(storage, KEYS, {
    activeDraftId: "fresh",
    createdAt: T0,
    fallbackContent: generateContentPackage({ topic: "" }),
    fallbackProfile: createProfileV2(),
  });
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.workspace.active_draft_id, "fresh");
  assert.equal(activeDraftRecord(loaded.workspace).content_package.source_input, "");
  assert.equal(storage.values.size, 0, "load/migrate is pure; the caller controls the atomic persist boundary");
});

test("an existing v2 envelope wins over stale legacy keys on reload", () => {
  const workspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("v2 权威稿", "v2-active"),
    activeDraftId: "v2-active",
    createdAt: T0,
  });
  const storage = memoryStorage({
    [KEYS.envelope]: JSON.stringify(workspace),
    [KEYS.content]: JSON.stringify(content("过期 v1 稿", "stale")),
    [KEYS.library]: "[]",
    [KEYS.profile]: JSON.stringify(createProfileV2()),
  });
  const loaded = loadOrMigrateWorkspaceEnvelope(storage, KEYS, { createdAt: T1 });
  assert.equal(loaded.migrated, false);
  assert.equal(activeDraftRecord(loaded.workspace).content_package.source_input, "v2 权威稿");
});
