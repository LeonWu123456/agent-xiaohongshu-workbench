import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { generateContentPackage } from "../src/content-engine.mjs";
import { GENERATION_SESSION_SCHEMA } from "../src/generation-session.mjs";
import { createMediaAssetStore, createMemoryMediaDatabase } from "../src/media-asset-store.mjs";
import { createProfileV2 } from "../src/profile-v2.mjs";
import { canonicalImageGenerationInputPreimage } from "../src/provider-contract.mjs";
import {
  AUTHORING_SESSION_SCHEMA,
  DRAFT_RECORD_SCHEMA,
  DRAFT_RECORD_V3_SCHEMA,
  PENDING_IMAGE_OPERATION_SCHEMA,
  WORKSPACE_BACKUP_V2_SCHEMA,
  WORKSPACE_BACKUP_V3_SCHEMA,
  WORKSPACE_ABSENT_TOKEN,
  WORKSPACE_ENVELOPE_SCHEMA,
  WORKSPACE_ENVELOPE_V3_SCHEMA,
  WORKSPACE_V3_RECOVERY_PRECONDITION_SCHEMA,
  WORKSPACE_V3_ABSENT_TOKEN,
  activateDraftRecord,
  activateDraftRecordV3,
  activeDraftRecord,
  activeDraftRecordV3,
  beginNewDraft,
  beginNewDraftV3,
  buildWorkspaceBackup,
  buildWorkspaceEnvelope,
  buildWorkspaceBackupV2,
  buildWorkspaceBackupV3,
  createPendingImageOperation,
  createRestartablePendingImageOperationV3,
  createDraftRecord,
  createDraftRecordV3,
  createWorkspaceCoordinator,
  createWorkspaceV3Coordinator,
  commitDraftImageCompletionV3,
  commitDraftImagePlannerFailureV3,
  commitDraftImageProgressV3,
  draftRecordToken,
  legacyStateFromWorkspaceEnvelope,
  libraryContents,
  libraryContentsV3,
  loadOrMigrateWorkspaceEnvelope,
  loadWorkspaceEnvelope,
  migrateLegacyWorkspaceState,
  parseWorkspaceBackup,
  parseWorkspaceBackupV2,
  parseWorkspaceBackupV3,
  parseWorkspaceEnvelopeV3,
  hydrateWorkspaceV3View,
  materializePersistentMediaRefsV3,
  persistWorkspaceEnvelope,
  persistDraftRecordWithReadback,
  putAndReadbackMediaDelta,
  rebuildPendingImageStartV3,
  repairLegacyArkSourceProjections,
  restoreWorkspaceBackupV3,
  saveActiveDraft,
  saveDraftRecordV3,
  saveWorkspaceProfileV3,
  workspaceEnvelopeV3Token,
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

function imageOperationSnapshot(recordId, draft = textDraft()) {
  return {
    schema: "xiaoshimei.image-operation-snapshot.v1",
    draft_record_id: recordId,
    mutation_epoch: 1,
    confirmed_draft: {
      draft_id: draft.draft_id,
      source_input: draft.source_input,
      pillar: draft.pillar,
      goal: draft.goal,
      titles: draft.titles,
      selected_title: draft.selected_title,
      body: draft.body,
      tags: draft.tags,
      recommended_image_count: draft.recommended_image_count,
      facts: draft.facts,
      risks: draft.risks,
      content_type: draft.content_type || "knowledge_card",
      style_lock: draft.style_lock || null,
      prompt_context: draft.prompt_context || {},
    },
    page_count: Math.max(1, Math.min(8, draft.recommended_image_count)),
    production_mode: "smart",
    reference_note: "",
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

function exclusiveLocks() {
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  const calls = [];
  return {
    calls,
    get maxActive() { return maxActive; },
    request(name, options, callback) {
      calls.push({ name, options });
      const before = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      return before.then(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try { return await callback(); }
        finally { active -= 1; release(); }
      });
    },
  };
}

function verifiedMediaStore(initial = [], { events = [], failPut = false } = {}) {
  const assets = new Map(initial.map((asset) => [asset.media_ref, structuredClone(asset)]));
  return {
    assets,
    events,
    async putVerifiedMedia({ bytes, mime_type, mime, sha256, name = "media" }) {
      events.push("put");
      if (failPut) throw new TypeError("IDB_QUOTA_EXCEEDED");
      const exact = Buffer.from(bytes);
      const actual = createHash("sha256").update(exact).digest("hex");
      if (sha256 != null && sha256 !== actual) throw new TypeError("MEDIA_HASH_MISMATCH");
      const media_ref = `xiaoshimei-media://sha256/${actual}`;
      const asset = { media_ref, sha256: actual, size_bytes: exact.byteLength, mime: mime || mime_type, name, bytes: new Uint8Array(exact) };
      assets.set(media_ref, asset);
      return structuredClone(asset);
    },
    async readVerifiedMedia(refOrSha) {
      events.push("read");
      const ref = String(refOrSha).startsWith("xiaoshimei-media://")
        ? String(refOrSha)
        : `xiaoshimei-media://sha256/${refOrSha}`;
      const asset = assets.get(ref);
      if (!asset) throw new TypeError("MEDIA_NOT_FOUND");
      return structuredClone(asset);
    },
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

test("origin Web Locks serialize full-envelope CAS and the stale writer performs zero writes", async () => {
  const storage = memoryStorage();
  const locks = exclusiveLocks();
  const coordinatorA = createWorkspaceCoordinator({ storage, keys: KEYS, lockManager: locks });
  const coordinatorB = createWorkspaceCoordinator({ storage, keys: KEYS, lockManager: locks });
  const initial = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("共同前像 A", "record-a"),
    activeDraftId: "record-a",
    createdAt: T0,
  });
  const boot = await coordinatorA.fullCas({ expectedWorkspaceToken: WORKSPACE_ABSENT_TOKEN, workspace: initial, reason: "BOOT" });
  assert.equal(boot.ok, true);
  const expected = boot.workspace_token;
  const workspaceB = beginNewDraft(boot.workspace, { newDraftId: "record-b", savedAt: T1 }).workspace;
  const workspaceA = saveActiveDraft(boot.workspace, { contentPackage: content("A 的迟到整包保存", "record-a"), savedAt: T1 });

  const [createdB, staleA] = await Promise.all([
    coordinatorB.fullCas({ expectedWorkspaceToken: expected, workspace: workspaceB, reason: "NEW_B" }),
    coordinatorA.fullCas({ expectedWorkspaceToken: expected, workspace: workspaceA, reason: "STALE_A" }),
  ]);

  assert.equal(createdB.disposition, "COMMITTED");
  assert.equal(staleA.code, "WORKSPACE_CAS_CONFLICT");
  assert.equal(staleA.disposition, "NO_WRITE_CONFLICT");
  assert.equal(staleA.workspace.active_draft_id, "record-b");
  assert.ok(staleA.workspace.drafts.some((draft) => draft.draft_id === "record-a"));
  assert.ok(staleA.workspace.drafts.some((draft) => draft.draft_id === "record-b"));
  assert.equal(locks.maxActive, 1);
  assert.ok(locks.calls.every((call) => call.options.mode === "exclusive"));
});

test("target-record CAS merges A into the latest workspace without replacing active B, profile, or unrelated drafts", async () => {
  const storage = memoryStorage();
  const locks = exclusiveLocks();
  const coordinator = createWorkspaceCoordinator({ storage, keys: KEYS, lockManager: locks });
  const initial = migrateLegacyWorkspaceState({
    profile: createProfileV2({ displayName: "小师妹" }),
    currentContent: content("A 原稿", "record-a"),
    library: [content("无关旧稿", "record-old")],
    activeDraftId: "record-a",
    createdAt: T0,
  });
  const boot = await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_ABSENT_TOKEN, workspace: initial });
  const withB = beginNewDraft(boot.workspace, { newDraftId: "record-b", savedAt: T1 }).workspace;
  const switched = await coordinator.fullCas({ expectedWorkspaceToken: boot.workspace_token, workspace: withB });
  const aBefore = switched.workspace.drafts.find((draft) => draft.draft_id === "record-a");
  const bBefore = structuredClone(activeDraftRecord(switched.workspace));
  const oldBefore = structuredClone(switched.workspace.drafts.find((draft) => draft.draft_id === "record-old"));
  const profileBefore = structuredClone(switched.workspace.profile);
  const replacementA = createDraftRecord({
    draftId: "record-a",
    contentPackage: content("A 后台进度", "record-a"),
    generationSession: aBefore.generation_session,
    createdAt: aBefore.created_at,
    updatedAt: "2026-08-31T06:06:00.000Z",
  });

  const merged = await coordinator.mergeDraftCas({
    draftId: "record-a",
    expectedDraftToken: draftRecordToken(aBefore),
    replacementDraft: replacementA,
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.workspace.active_draft_id, "record-b");
  assert.deepEqual(activeDraftRecord(merged.workspace), bBefore);
  assert.deepEqual(merged.workspace.profile, profileBefore);
  assert.deepEqual(merged.workspace.drafts.find((draft) => draft.draft_id === "record-old"), oldBefore);
  assert.equal(merged.target_draft.content_package.source_input, "A 后台进度");

  const stale = await coordinator.mergeDraftCas({
    draftId: "record-a",
    expectedDraftToken: draftRecordToken(aBefore),
    replacementDraft: replacementA,
  });
  assert.equal(stale.code, "WORKSPACE_DRAFT_CAS_CONFLICT");
  assert.equal(stale.disposition, "NO_WRITE_CONFLICT");
  assert.equal(stale.workspace_token, merged.workspace_token);
});

test("an active-bound autosave and an installation without Web Locks both fail closed", async () => {
  const storage = memoryStorage();
  const locks = exclusiveLocks();
  const coordinator = createWorkspaceCoordinator({ storage, keys: KEYS, lockManager: locks });
  const initial = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("A", "record-a"),
    activeDraftId: "record-a",
    createdAt: T0,
  });
  const boot = await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_ABSENT_TOKEN, workspace: initial });
  const withB = beginNewDraft(boot.workspace, { newDraftId: "record-b", savedAt: T1 }).workspace;
  const switched = await coordinator.fullCas({ expectedWorkspaceToken: boot.workspace_token, workspace: withB });
  const a = switched.workspace.drafts.find((draft) => draft.draft_id === "record-a");
  const activeConflict = await coordinator.mergeDraftCas({
    draftId: "record-a",
    expectedDraftToken: draftRecordToken(a),
    requireActiveDraftId: "record-a",
    replacementDraft: createDraftRecord({
      draftId: "record-a",
      contentPackage: content("不应落盘的迟到 autosave", "record-a"),
      generationSession: a.generation_session,
      createdAt: a.created_at,
      updatedAt: T1,
    }),
  });
  assert.equal(activeConflict.code, "WORKSPACE_ACTIVE_DRAFT_CONFLICT");
  assert.equal(activeConflict.workspace_token, switched.workspace_token);

  let writes = 0;
  const normalSet = storage.setItem;
  storage.setItem = (key, value) => { writes += 1; normalSet(key, value); };
  const unavailable = createWorkspaceCoordinator({ storage, keys: KEYS, lockManager: null });
  const result = await unavailable.fullCas({ expectedWorkspaceToken: switched.workspace_token, workspace: initial });
  assert.equal(result.code, "WORKSPACE_LOCK_UNAVAILABLE");
  assert.equal(result.disposition, "NO_WRITE_LOCK_UNAVAILABLE");
  assert.equal(writes, 0);
});

test("the coordinator keeps the lock through same-source readback and fails closed on drift", async () => {
  const storage = memoryStorage();
  const coordinator = createWorkspaceCoordinator({ storage, keys: KEYS, lockManager: exclusiveLocks() });
  const initial = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("readback A", "record-a"),
    activeDraftId: "record-a",
    createdAt: T0,
  });
  const boot = await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_ABSENT_TOKEN, workspace: initial });
  const next = saveActiveDraft(boot.workspace, { contentPackage: content("readback B", "record-a"), savedAt: T1 });
  const normalGet = storage.getItem;
  const normalSet = storage.setItem;
  let distort = false;
  storage.setItem = (key, value) => {
    normalSet(key, value);
    if (key === KEYS.profile) distort = true;
  };
  storage.getItem = (key) => {
    const serialized = normalGet(key);
    if (!distort || key !== KEYS.envelope || serialized == null) return serialized;
    const parsed = JSON.parse(serialized);
    parsed.updated_at = T0;
    return JSON.stringify(parsed);
  };

  const result = await coordinator.fullCas({ expectedWorkspaceToken: boot.workspace_token, workspace: next });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKSPACE_READBACK_MISMATCH");
  assert.equal(result.disposition, "WRITE_READBACK_MISMATCH");
});

test("the exact legacy Ark source projection is repaired under full CAS without changing paid pages or images", async () => {
  const source = "久坐之后先活动肩颈，再慢慢调整呼吸。";
  const draft = textDraft("text-ark", source);
  const session = {
    ...fullSession("text-ark"),
    topic: source,
    text_draft: draft,
    assembled_draft_id: draft.draft_id,
  };
  const base = assembledContent(session, "record-ark");
  const arkContent = {
    ...base,
    source_input: source.slice(0, -1),
    generation: {
      ...base.generation,
      mode: "PROVIDER",
      provider: "volcengine-ark",
      production_mode: "smart",
      source_draft_id: draft.draft_id,
      strategy: "resumable_public_image_steps_v1",
      notice: "已付费 resumable producer",
    },
  };
  const workspace = buildWorkspaceEnvelope({
    profile: createProfileV2(),
    activeDraftId: "record-ark",
    drafts: [createDraftRecord({ draftId: "record-ark", contentPackage: arkContent, generationSession: session, createdAt: T0 })],
    updatedAt: T0,
  });
  const pagesBefore = JSON.stringify(activeDraftRecord(workspace).content_package.pages);
  const storage = memoryStorage();
  const coordinator = createWorkspaceCoordinator({ storage, keys: KEYS, lockManager: exclusiveLocks() });
  const boot = await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_ABSENT_TOKEN, workspace });
  const repaired = await coordinator.repairLegacyArkSourceCas({ expectedWorkspaceToken: boot.workspace_token, updatedAt: T1 });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.repaired, true);
  assert.deepEqual(repaired.repaired_draft_ids, ["record-ark"]);
  assert.equal(repaired.target_draft, null);
  assert.equal(activeDraftRecord(repaired.workspace).content_package.source_input, source);
  assert.equal(JSON.stringify(activeDraftRecord(repaired.workspace).content_package.pages), pagesBefore);
  assert.equal(loadWorkspaceEnvelope(storage, KEYS.envelope).drafts[0].content_package.source_input, source);
});

test("legacy Ark repair rejects body, provider, strategy, lineage and non-legacy source counterexamples", () => {
  const source = "原文最后保留句号。";
  const draft = textDraft("text-counter", source);
  const session = { ...fullSession("text-counter"), topic: source, text_draft: draft, assembled_draft_id: draft.draft_id };
  const base = assembledContent(session, "record-counter");
  const eligible = {
    ...base,
    source_input: source.slice(0, -1),
    generation: {
      ...base.generation,
      mode: "PROVIDER",
      provider: "volcengine-ark",
      production_mode: "smart",
      source_draft_id: draft.draft_id,
      strategy: "resumable_public_image_steps_v1",
      notice: "已付费 resumable producer",
    },
  };
  const variants = [
    { ...eligible, body: `${eligible.body}发生漂移` },
    { ...eligible, generation: { ...eligible.generation, provider: "other-provider" } },
    { ...eligible, generation: { ...eligible.generation, strategy: "other-strategy" } },
    { ...eligible, generation: { ...eligible.generation, source_draft_id: "other-text" } },
    { ...eligible, source_input: "不是旧清洗结果" },
  ];
  variants.forEach((candidate, index) => {
    const workspace = buildWorkspaceEnvelope({
      profile: createProfileV2(),
      activeDraftId: `record-${index}`,
      drafts: [createDraftRecord({ draftId: `record-${index}`, contentPackage: candidate, generationSession: session, createdAt: T0 })],
      updatedAt: T0,
    });
    const result = repairLegacyArkSourceProjections(workspace, { updatedAt: T1 });
    assert.equal(result.repaired, false);
    assert.equal(result.workspace.drafts[0].content_package.source_input, candidate.source_input);
  });
});

test("workspace v3 migrates media-first under the shared Web Lock while preserving the v2 rollback preimage byte-for-byte", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA", "base64");
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const session = fullSession("v3-text");
  session.image_resume = {
    ...session.image_resume,
    resume_checkpoint: {
      record_snapshot: { draft_id: "must-not-enter-v3", body: "旧累计 checkpoint 只允许变成 hash" },
      accumulated_assets: [{ src: "/legacy/checkpoint.png" }],
    },
  };
  const withEmbeddedMedia = assembledContent(session, "record-v3");
  withEmbeddedMedia.pages[0].image_style.src = dataUrl;
  const v2 = buildWorkspaceEnvelope({
    profile: createProfileV2(),
    activeDraftId: "record-v3",
    drafts: [createDraftRecord({ draftId: "record-v3", contentPackage: withEmbeddedMedia, generationSession: session, createdAt: T0 })],
    updatedAt: T0,
  });
  const exactV2 = JSON.stringify(v2);
  const keys = { envelope: "workspace-v2", envelopeV3: "workspace-v3" };
  const storage = memoryStorage({ [keys.envelope]: exactV2 });
  const mediaStore = verifiedMediaStore();
  const locks = exclusiveLocks();
  const coordinator = createWorkspaceV3Coordinator({ storage, keys, lockManager: locks, mediaStore });

  const migrated = await coordinator.bootstrap({ expectedV2Serialized: exactV2 });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.workspace.schema, WORKSPACE_ENVELOPE_V3_SCHEMA);
  assert.equal(migrated.active_draft.schema, DRAFT_RECORD_V3_SCHEMA);
  assert.match(migrated.active_draft.content_package.pages[0].image_style.src, /^xiaoshimei-media:\/\/sha256\/[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(migrated.workspace).includes("data:"), false);
  assert.equal(JSON.stringify(migrated.workspace).includes("record_snapshot"), false);
  assert.equal("resume_checkpoint" in migrated.active_draft.generation_session.image_resume, false);
  assert.match(migrated.active_draft.pending_image_operation.checkpoint_hash, /^[0-9a-f]{64}$/);
  assert.equal(storage.getItem(keys.envelope), exactV2, "v2 is an exact, read-only rollback preimage");
  assert.deepEqual(mediaStore.events, ["put", "read"]);
  assert.equal(locks.maxActive, 1);

  const pending = createPendingImageOperation({
    operationNonce: "1".repeat(64),
    operationSnapshot: imageOperationSnapshot("record-v3", session.text_draft),
    operationSnapshotHash: "a".repeat(64),
    inputHash: "b".repeat(64),
    orderedReferenceManifest: [],
    protocolState: "READY",
  });
  assert.equal(pending.schema, PENDING_IMAGE_OPERATION_SCHEMA);
  assert.throws(() => createPendingImageOperation({
    operationNonce: "2".repeat(64),
    operationSnapshot: imageOperationSnapshot("record-v3", session.text_draft),
    operationSnapshotHash: "a".repeat(64),
    inputHash: "b".repeat(64),
    orderedReferenceManifest: [{ media_ref: dataUrl, sha256: "c".repeat(64), size_bytes: 10, mime: "image/png", name: "bad" }],
    protocolState: "READY",
  }), /PENDING_IMAGE_OPERATION_INPUT_INVALID/);

  const oldTabRewrite = { ...v2, updated_at: T1 };
  storage.setItem(keys.envelope, JSON.stringify(oldTabRewrite));
  const rebootConflict = await coordinator.bootstrap();
  assert.equal(rebootConflict.ok, false);
  assert.equal(rebootConflict.code, "LEGACY_WRITER_CONFLICT", "boot must re-check the physical v2 even when v3 already exists");
  const current = migrated.active_draft;
  const replacement = createDraftRecordV3({
    draftId: current.draft_id,
    contentPackage: current.content_package,
    generationSession: current.generation_session,
    pendingImageOperation: pending,
    createdAt: current.created_at,
    updatedAt: T1,
  });
  const conflicted = await coordinator.mergeDraftCas({
    draftId: current.draft_id,
    expectedDraftToken: draftRecordToken(current),
    replacementDraft: replacement,
  });
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.code, "LEGACY_WRITER_CONFLICT");
  assert.equal(storage.getItem(keys.envelopeV3), JSON.stringify(migrated.workspace));
});

test("pending v3 reload reconstructs the exact START from its bounded snapshot, canonical manifest and IndexedDB bytes", async () => {
  const bytes = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const media_ref = `xiaoshimei-media://sha256/${sha256}`;
  const session = { ...fullSession("reload-text"), image_resume: null };
  const operationSnapshot = imageOperationSnapshot("reload-record", session.text_draft);
  operationSnapshot.mutation_epoch = 37;
  operationSnapshot.reference_note = "只参考动作关系，不复制人物";
  const referenceManifest = [{
    schema: "xiaoshimei.media-asset-manifest.v1",
    media_ref,
    sha256,
    size_bytes: bytes.byteLength,
    mime: "image/jpeg",
    name: "reload-reference.jpg",
    width: 1,
    height: 1,
  }];
  const canonicalInput = canonicalImageGenerationInputPreimage({ operation_snapshot: operationSnapshot, reference_manifest: referenceManifest });
  const canonicalOperationSnapshot = JSON.parse(canonicalInput).operation_snapshot;
  const operationSnapshotHash = createHash("sha256").update(JSON.stringify(canonicalOperationSnapshot)).digest("hex");
  const inputHash = createHash("sha256").update(canonicalInput).digest("hex");
  const nonce = createHash("sha256").update("reload-bootstrap-nonce").digest("hex");
  const pending = await createRestartablePendingImageOperationV3({
    operationNonce: nonce,
    operationSnapshot,
    operationSnapshotHash,
    inputHash,
    orderedReferenceManifest: referenceManifest,
    protocolState: "BOOTSTRAP",
  });
  const record = createDraftRecordV3({
    draftId: "reload-record",
    contentPackage: assembledContent(session, "reload-record"),
    generationSession: session,
    pendingImageOperation: pending,
    createdAt: T0,
  });
  const persisted = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    drafts: [record],
    legacy_v2_source: null,
  });
  const serialized = JSON.stringify(persisted);
  assert.equal(/(?:data|blob):|bytes_base64|record_snapshot/.test(serialized), false);
  const reloaded = parseWorkspaceEnvelopeV3(serialized);
  const store = verifiedMediaStore([{ media_ref, sha256, size_bytes: bytes.byteLength, mime: "image/jpeg", name: "reload-reference.jpg", bytes: new Uint8Array(bytes) }]);
  const start = await rebuildPendingImageStartV3({ pendingImageOperation: activeDraftRecordV3(reloaded).pending_image_operation, mediaStore: store });
  assert.deepEqual(start, {
    mode: "START",
    bootstrap_nonce: nonce,
    operation_snapshot: canonicalOperationSnapshot,
    input_sha256: inputHash,
    reference_manifest: referenceManifest,
    missing_reference_media: [{ media_ref, sha256, size_bytes: bytes.byteLength, mime: "image/jpeg", bytes_base64: bytes.toString("base64") }],
  });
  const backup = await buildWorkspaceBackupV3({ workspace: reloaded, mediaStore: store, createdAt: T1 });
  const parsedBackup = await parseWorkspaceBackupV3(JSON.stringify(backup));
  assert.deepEqual(activeDraftRecordV3(parsedBackup.workspace).pending_image_operation, pending, "backup must preserve the restartable pending snapshot exactly");
  const backupStart = await rebuildPendingImageStartV3({ pendingImageOperation: activeDraftRecordV3(parsedBackup.workspace).pending_image_operation, mediaStore: store });
  assert.deepEqual(backupStart, start);
});

test("workspace-backup.v3 is self-contained, deduplicated, exact-set verified, and restores media before refs", async () => {
  const bytes = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const media_ref = `xiaoshimei-media://sha256/${sha256}`;
  const mediaStore = verifiedMediaStore([{ media_ref, sha256, size_bytes: bytes.byteLength, mime: "image/jpeg", name: "shared.jpg", bytes: new Uint8Array(bytes) }]);
  const session = fullSession("backup-v3-text");
  const packageWithRefs = assembledContent(session, "backup-v3-record");
  packageWithRefs.stage = "FULL_DRAFT";
  packageWithRefs.visible_pages = packageWithRefs.pages.length;
  packageWithRefs.review = { source: "USER", decision: "READY_TO_PUBLISH", reviewed_at: T0, authority_effect: "EVIDENCE_ONLY" };
  packageWithRefs.generation = { mode: "PROVIDER", provider: "volcengine-ark", notice: "已绑定本地完成结果" };
  packageWithRefs.pages[0].image_style.src = media_ref;
  packageWithRefs.pages[1].image_style.src = media_ref;
  const record = createDraftRecordV3({
    draftId: "backup-v3-record",
    contentPackage: packageWithRefs,
    generationSession: { ...session, image_resume: null },
    createdAt: T0,
  });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    drafts: [record],
    legacy_v2_source: null,
  });

  const backup = await buildWorkspaceBackupV3({ workspace, mediaStore, createdAt: T1 });
  assert.equal(backup.schema, WORKSPACE_BACKUP_V3_SCHEMA);
  assert.equal(backup.media_assets.length, 1, "the same reachable bytes are embedded once");
  assert.deepEqual(backup.media_assets.map((asset) => asset.sha256), [sha256]);
  assert.equal(JSON.stringify(backup.workspace).includes("data:"), false);
  const parsed = await parseWorkspaceBackupV3(JSON.stringify(backup));
  assert.equal(parsed.media_assets[0].media_ref, media_ref);
  assert.deepEqual(parsed.workspace, backup.workspace, "v3 backup parse must not downgrade or rewrite the same local DraftRecord");

  const corrupt = structuredClone(backup);
  corrupt.media_assets[0].bytes_base64 = Buffer.from("ffd8ff00ffd9", "hex").toString("base64");
  await assert.rejects(() => parseWorkspaceBackupV3(JSON.stringify(corrupt)), /MEDIA_(HASH|SIZE)_MISMATCH/);

  const extraBytes = Buffer.from("ffd8ffe100014558545241ffd9", "hex");
  const extraSha = createHash("sha256").update(extraBytes).digest("hex");
  const extra = structuredClone(backup);
  extra.media_assets.push({
    schema: "xiaoshimei.media-asset-backup.v1",
    media_ref: `xiaoshimei-media://sha256/${extraSha}`,
    sha256: extraSha,
    size_bytes: extraBytes.byteLength,
    mime: "image/jpeg",
    name: "unreachable-extra.jpg",
    bytes_base64: extraBytes.toString("base64"),
  });
  extra.media_assets.sort((left, right) => left.sha256.localeCompare(right.sha256));
  await assert.rejects(() => parseWorkspaceBackupV3(JSON.stringify(extra)), /WORKSPACE_BACKUP_MEDIA_SET_MISMATCH/);

  const restoreStorage = memoryStorage();
  const restoreMedia = verifiedMediaStore();
  const coordinator = createWorkspaceV3Coordinator({
    storage: restoreStorage,
    keys: { envelope: "workspace-v2", envelopeV3: "workspace-v3" },
    lockManager: exclusiveLocks(),
    mediaStore: restoreMedia,
  });
  const restored = await restoreWorkspaceBackupV3({
    serialized: JSON.stringify(backup),
    coordinator,
    mediaStore: restoreMedia,
    expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN,
  });
  assert.equal(restored.ok, true);
  assert.deepEqual(restoreMedia.events, ["put", "read"]);
  assert.equal(restored.active_draft.content_package.pages[0].image_style.src, media_ref);

  const before = coordinator.snapshot().workspace_token;
  const exactWorkspaceBeforeFailure = restoreStorage.getItem("workspace-v3");
  await assert.rejects(() => restoreWorkspaceBackupV3({
    serialized: JSON.stringify(backup),
    coordinator,
    mediaStore: verifiedMediaStore([], { failPut: true }),
    expectedWorkspaceToken: before,
  }), /IDB_QUOTA_EXCEEDED/);
  assert.equal(restoreStorage.getItem("workspace-v3"), exactWorkspaceBeforeFailure, "media failure leaves the current workspace byte-for-byte unchanged");

  const missing = { ...backup, media_assets: [] };
  await assert.rejects(() => restoreWorkspaceBackupV3({
    serialized: JSON.stringify(missing),
    coordinator,
    mediaStore: restoreMedia,
    expectedWorkspaceToken: before,
  }), /WORKSPACE_BACKUP_MEDIA_SET_MISMATCH/);
  assert.equal(coordinator.snapshot().workspace_token, before, "invalid backup leaves the current workspace byte-for-byte unchanged");
});

test("an explicit corrupt-v3 backup recovery binds the exact raw preimage and legacy fence inside the Web Lock", async () => {
  const previous = createDraftRecordV3({ draftId: "recovery-previous", contentPackage: content("恢复前一稿", "recovery-previous"), createdAt: T0 });
  const current = createDraftRecordV3({ draftId: "recovery-current", contentPackage: content("恢复当前稿", "recovery-current"), createdAt: T1 });
  const backupWorkspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T1,
    profile: createProfileV2(),
    active_draft_id: current.draft_id,
    previous_draft_id: previous.draft_id,
    drafts: [current, previous],
    legacy_v2_source: null,
  });
  const backup = await buildWorkspaceBackupV3({ workspace: backupWorkspace, mediaStore: null, createdAt: T1 });
  const legacyWorkspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("旧标签页的精确回滚前像", "legacy-recovery"),
    activeDraftId: "legacy-recovery",
    createdAt: T0,
  });
  const rawLegacy = JSON.stringify(legacyWorkspace);
  const keys = { envelope: "workspace-v2", envelopeV3: "workspace-v3" };

  const rawCorrupt = "{\"schema\":\"xiaoshimei.workspace-envelope.v3\",\"truncated\":";
  const storage = memoryStorage({ [keys.envelope]: rawLegacy, [keys.envelopeV3]: rawCorrupt });
  const locks = exclusiveLocks();
  const coordinator = createWorkspaceV3Coordinator({ storage, keys, lockManager: locks });
  const recovery = await coordinator.recoverySnapshot();
  assert.equal(recovery.ok, true);
  assert.equal(recovery.code, "WORKSPACE_V3_CORRUPT_RECOVERY_READY");
  assert.equal(recovery.recovery_precondition.schema, WORKSPACE_V3_RECOVERY_PRECONDITION_SCHEMA);
  assert.equal(recovery.recovery_precondition.raw_v3_preimage, rawCorrupt);
  assert.match(recovery.recovery_precondition.raw_v3_sha256, /^[0-9a-f]{64}$/);
  assert.match(recovery.recovery_precondition.raw_v3_token, /^sha256:[0-9a-f]{64}:[1-9][0-9]*$/);
  assert.equal(recovery.recovery_precondition.legacy_v2_preimage, rawLegacy);

  const ordinary = await coordinator.fullCas({
    expectedWorkspaceToken: recovery.recovery_precondition.raw_v3_token,
    workspace: backupWorkspace,
  });
  assert.equal(ordinary.ok, false);
  assert.equal(ordinary.code, "WORKSPACE_V3_ENVELOPE_INVALID", "ordinary fullCas remains closed over corrupt state");
  assert.equal(storage.getItem(keys.envelopeV3), rawCorrupt);

  const restored = await restoreWorkspaceBackupV3({
    serialized: JSON.stringify(backup),
    coordinator,
    mediaStore: null,
    recoveryPrecondition: recovery.recovery_precondition,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.code, "WORKSPACE_BACKUP_V3_RECOVERED_AND_VERIFIED");
  assert.equal(restored.disposition, "CORRUPT_V3_RECOVERED");
  assert.equal(restored.workspace_token, workspaceEnvelopeV3Token(restored.workspace));
  assert.equal(restored.workspace.previous_draft_id, previous.draft_id);
  assert.equal(storage.getItem(keys.envelope), rawLegacy, "the legacy rollback preimage stays byte-for-byte unchanged");
  assert.deepEqual(parseWorkspaceEnvelopeV3(storage.getItem(keys.envelopeV3)), restored.workspace);
  assert.ok(locks.calls.length >= 3, "snapshot, rejected fullCas and recovery all use the shared Web Lock");

  const changedStorage = memoryStorage({ [keys.envelope]: rawLegacy, [keys.envelopeV3]: rawCorrupt });
  const changedCoordinator = createWorkspaceV3Coordinator({ storage: changedStorage, keys, lockManager: exclusiveLocks() });
  const changedPrecondition = (await changedCoordinator.recoverySnapshot()).recovery_precondition;
  const newInvalidRaw = `${rawCorrupt}0`;
  changedStorage.setItem(keys.envelopeV3, newInvalidRaw);
  const changed = await restoreWorkspaceBackupV3({
    serialized: backup,
    coordinator: changedCoordinator,
    mediaStore: null,
    recoveryPrecondition: changedPrecondition,
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, "WORKSPACE_V3_RECOVERY_PREIMAGE_CONFLICT");
  assert.equal(changedStorage.getItem(keys.envelopeV3), newInvalidRaw, "a changed invalid raw preimage is never overwritten");

  const legacyStorage = memoryStorage({ [keys.envelope]: rawLegacy, [keys.envelopeV3]: rawCorrupt });
  const legacyCoordinator = createWorkspaceV3Coordinator({ storage: legacyStorage, keys, lockManager: exclusiveLocks() });
  const legacyPrecondition = (await legacyCoordinator.recoverySnapshot()).recovery_precondition;
  legacyStorage.setItem(keys.envelope, JSON.stringify({ ...legacyWorkspace, updated_at: T1 }));
  const legacyConflict = await restoreWorkspaceBackupV3({
    serialized: backup,
    coordinator: legacyCoordinator,
    mediaStore: null,
    recoveryPrecondition: legacyPrecondition,
  });
  assert.equal(legacyConflict.ok, false);
  assert.equal(legacyConflict.code, "LEGACY_WRITER_CONFLICT");
  assert.equal(legacyStorage.getItem(keys.envelopeV3), rawCorrupt);
});

test("corrupt-v3 recovery persists media before refs and a media failure performs zero workspace writes", async () => {
  const bytes = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const media_ref = `xiaoshimei-media://sha256/${sha256}`;
  const session = fullSession("recovery-media-text");
  const packageWithRef = assembledContent(session, "recovery-media-record");
  packageWithRef.pages[0].image_style.src = media_ref;
  const record = createDraftRecordV3({ draftId: "recovery-media-record", contentPackage: packageWithRef, generationSession: session, pendingImageOperation: createPendingImageOperation({
    operationNonce: "a".repeat(64),
    operationSnapshot: imageOperationSnapshot("recovery-media-record", session.text_draft),
    operationSnapshotHash: "b".repeat(64),
    inputHash: "c".repeat(64),
    orderedReferenceManifest: [],
    protocolState: "PARTIAL",
  }), createdAt: T0 });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    drafts: [record],
    legacy_v2_source: null,
  });
  const sourceMedia = verifiedMediaStore([{ media_ref, sha256, size_bytes: bytes.byteLength, mime: "image/jpeg", name: "recovery.jpg", bytes: new Uint8Array(bytes) }]);
  const backup = await buildWorkspaceBackupV3({ workspace, mediaStore: sourceMedia, createdAt: T1 });
  const keys = { envelope: "workspace-v2", envelopeV3: "workspace-v3" };
  const rawCorrupt = "not-json-v3";
  const storage = memoryStorage({ [keys.envelopeV3]: rawCorrupt });
  let workspaceWrites = 0;
  const baseSet = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === keys.envelopeV3) workspaceWrites += 1;
    return baseSet(key, value);
  };
  const coordinator = createWorkspaceV3Coordinator({ storage, keys, lockManager: exclusiveLocks() });
  const recoveryPrecondition = (await coordinator.recoverySnapshot()).recovery_precondition;
  await assert.rejects(() => restoreWorkspaceBackupV3({
    serialized: backup,
    coordinator,
    mediaStore: verifiedMediaStore([], { failPut: true }),
    recoveryPrecondition,
  }), /IDB_QUOTA_EXCEEDED/);
  assert.equal(workspaceWrites, 0);
  assert.equal(storage.getItem(keys.envelopeV3), rawCorrupt);
});

test("legacy workspace-backup.v1 and v2 restore through bounded media-first migration without writing refs into the old v2 key", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const session = fullSession("legacy-backup-text");
  const packageWithLegacyMedia = assembledContent(session, "legacy-backup-record");
  packageWithLegacyMedia.pages[0].image_style.src = dataUrl;
  const v2Workspace = buildWorkspaceEnvelope({
    profile: createProfileV2(),
    activeDraftId: "legacy-backup-record",
    drafts: [createDraftRecord({ draftId: "legacy-backup-record", contentPackage: packageWithLegacyMedia, generationSession: session, createdAt: T0 })],
    updatedAt: T0,
  });
  const backups = [
    buildWorkspaceBackup({ profile: createProfileV2(), currentContent: packageWithLegacyMedia, createdAt: T1 }),
    buildWorkspaceBackupV2({ workspace: v2Workspace, createdAt: T1 }),
  ];
  for (const backup of backups) {
    const storage = memoryStorage();
    const mediaStore = verifiedMediaStore();
    const coordinator = createWorkspaceV3Coordinator({
      storage,
      keys: { envelope: "workspace-v2", envelopeV3: "workspace-v3" },
      lockManager: exclusiveLocks(),
      mediaStore,
    });
    const restored = await restoreWorkspaceBackupV3({
      serialized: JSON.stringify(backup),
      coordinator,
      mediaStore,
      expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.workspace.schema, WORKSPACE_ENVELOPE_V3_SCHEMA);
    assert.match(restored.active_draft.content_package.pages[0].image_style.src, /^xiaoshimei-media:\/\/sha256\/[0-9a-f]{64}$/);
    assert.equal(storage.getItem("workspace-v2"), null, "clean-origin legacy restore must not invent or rewrite a v2 preimage");
    assert.equal(storage.getItem("workspace-v3").includes("data:image"), false);
  }
});

test("a v3 restore onto a legacy-bearing origin binds the exact v2 preimage and detects a later legacy writer", async () => {
  const legacyWorkspace = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("旧标签页仍可能写入的 v2", "legacy-origin"),
    activeDraftId: "legacy-origin",
    createdAt: T0,
  });
  const exactLegacy = JSON.stringify(legacyWorkspace);
  const restoredRecord = createDraftRecordV3({
    draftId: "restored-v3",
    contentPackage: content("恢复进来的 v3", "restored-v3"),
    createdAt: T1,
  });
  const restoredWorkspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T1,
    profile: createProfileV2(),
    active_draft_id: restoredRecord.draft_id,
    drafts: [restoredRecord],
    legacy_v2_source: null,
  });
  const backup = await buildWorkspaceBackupV3({ workspace: restoredWorkspace, mediaStore: null, createdAt: T1 });
  const keys = { envelope: "workspace-v2", envelopeV3: "workspace-v3" };
  const storage = memoryStorage({ [keys.envelope]: exactLegacy });
  const coordinator = createWorkspaceV3Coordinator({ storage, keys, lockManager: exclusiveLocks() });

  const restored = await restoreWorkspaceBackupV3({
    serialized: JSON.stringify(backup),
    coordinator,
    mediaStore: null,
    expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN,
  });
  assert.equal(restored.ok, true);
  assert.match(restored.workspace.legacy_v2_source.token, /^sha256:[0-9a-f]{64}:[1-9][0-9]*$/);
  assert.equal(storage.getItem(keys.envelope), exactLegacy, "restore must preserve the rollback preimage byte-for-byte");
  const exactRestoredV3 = storage.getItem(keys.envelopeV3);

  storage.setItem(keys.envelope, JSON.stringify({ ...legacyWorkspace, updated_at: T1 }));
  const current = restored.active_draft;
  const replacement = createDraftRecordV3({
    draftId: current.draft_id,
    contentPackage: { ...current.content_package, body: `${current.content_package.body}\n旧写者冲突后不得落盘` },
    generationSession: current.generation_session,
    pendingImageOperation: current.pending_image_operation,
    createdAt: current.created_at,
    updatedAt: "2026-08-31T06:30:00.000Z",
  });
  const conflicted = await coordinator.mergeDraftCas({
    draftId: current.draft_id,
    expectedDraftToken: draftRecordToken(current),
    replacementDraft: replacement,
  });
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.code, "LEGACY_WRITER_CONFLICT");
  assert.equal(storage.getItem(keys.envelopeV3), exactRestoredV3, "legacy conflict must leave the v3 workspace byte-for-byte unchanged");
});

test("a v3 writer without origin Web Locks fails closed with zero writes", async () => {
  const record = createDraftRecordV3({ draftId: "no-lock-v3", contentPackage: content("没有锁就不写", "no-lock-v3"), createdAt: T0 });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    drafts: [record],
    legacy_v2_source: null,
  });
  const storage = memoryStorage();
  let writes = 0;
  const setItem = storage.setItem;
  storage.setItem = (key, value) => { writes += 1; setItem(key, value); };
  const coordinator = createWorkspaceV3Coordinator({
    storage,
    keys: { envelope: "workspace-v2", envelopeV3: "workspace-v3" },
    lockManager: null,
  });
  const result = await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN, workspace });
  assert.equal(result.ok, false);
  assert.equal(result.code, "WORKSPACE_LOCK_UNAVAILABLE");
  assert.equal(result.disposition, "NO_WRITE_LOCK_UNAVAILABLE");
  assert.equal(writes, 0);
});

test("bootstrap creates v3 directly from an in-memory fallback and treats a later physical v2 as a legacy conflict", async () => {
  const fallback = migrateLegacyWorkspaceState({
    profile: createProfileV2(),
    currentContent: content("全新安装的内存初稿", "fresh-fallback"),
    activeDraftId: "fresh-fallback",
    createdAt: T0,
  });
  const keys = { envelope: "workspace-v2", envelopeV3: "workspace-v3" };
  const storage = memoryStorage();
  const coordinator = createWorkspaceV3Coordinator({ storage, keys, lockManager: exclusiveLocks() });
  const boot = await coordinator.bootstrap({ fallbackWorkspaceV2: fallback });
  assert.equal(boot.ok, true);
  assert.equal(boot.workspace.schema, WORKSPACE_ENVELOPE_V3_SCHEMA);
  assert.equal(boot.workspace.legacy_v2_source, null);
  assert.equal(storage.getItem(keys.envelope), null, "bootstrap must not invent a v2 preimage or write legacy split keys");
  assert.ok(storage.getItem(keys.envelopeV3));

  storage.setItem(keys.envelope, JSON.stringify(fallback));
  const conflicted = await coordinator.bootstrap();
  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.code, "LEGACY_WRITER_CONFLICT");
});

test("v3 previous_draft_id survives reload and supports direct return without becoming active authority", () => {
  const first = createDraftRecordV3({
    draftId: "navigation-a",
    contentPackage: content("A 稿必须可返回", "navigation-a"),
    createdAt: T0,
  });
  const initial = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: first.draft_id,
    drafts: [first],
    legacy_v2_source: null,
  });
  assert.equal(initial.previous_draft_id, null, "old v3 envelopes normalize to a null navigation hint");

  const created = beginNewDraftV3(initial, {
    newDraftId: "navigation-b",
    currentContent: first.content_package,
    currentSession: null,
    savedAt: T1,
  });
  assert.equal(created.workspace.active_draft_id, "navigation-b");
  assert.equal(created.workspace.previous_draft_id, "navigation-a");
  assert.equal(created.previousDraftId, "navigation-a");

  const reloaded = parseWorkspaceEnvelopeV3(JSON.stringify(created.workspace));
  assert.equal(reloaded.active_draft_id, "navigation-b", "navigation hint must not grant active authority");
  assert.equal(reloaded.previous_draft_id, "navigation-a");
  const returned = activateDraftRecordV3(reloaded, reloaded.previous_draft_id, { activatedAt: "2026-08-31T06:06:00.000Z" });
  assert.equal(returned.workspace.active_draft_id, "navigation-a");
  assert.equal(returned.workspace.previous_draft_id, "navigation-b");
  assert.equal(returned.previousDraftId, "navigation-b");

  const sameActive = activateDraftRecordV3(returned.workspace, "navigation-a", { activatedAt: "2026-08-31T06:07:00.000Z" });
  assert.equal(sameActive.previousDraftId, "navigation-b", "same-active activation must not clear the return pointer in React");
  assert.equal(parseWorkspaceEnvelopeV3(JSON.stringify(sameActive.workspace)).previous_draft_id, "navigation-b");

  const saved = saveDraftRecordV3(sameActive.workspace, {
    contentPackage: { ...sameActive.activeDraft.content_package, body: `${sameActive.activeDraft.content_package.body}\n普通保存不清导航提示` },
    updatedAt: "2026-08-31T06:08:00.000Z",
  });
  assert.equal(saved.previous_draft_id, "navigation-b");
  const profiled = saveWorkspaceProfileV3(saved, { ...saved.profile, account_owner: "导航测试" }, { updatedAt: "2026-08-31T06:09:00.000Z" });
  assert.equal(profiled.previous_draft_id, "navigation-b");

  assert.throws(() => parseWorkspaceEnvelopeV3({ ...profiled, previous_draft_id: profiled.active_draft_id }), /different existing v3 draft/);
  assert.throws(() => parseWorkspaceEnvelopeV3({ ...profiled, previous_draft_id: "missing-draft" }), /different existing v3 draft/);
});

test("v3 explicit save persists id and saved_at even when the semantic draft token is unchanged", async () => {
  const record = createDraftRecordV3({
    draftId: "bookkeeping-save",
    contentPackage: generateContentPackage({ topic: "保存后必须出现在资产库", pillar: "culture", goal: "save" }),
    createdAt: T0,
  });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    drafts: [record],
    legacy_v2_source: null,
  });
  const keys = { ...KEYS, envelopeV3: "workspace-v3" };
  const storage = memoryStorage({ [keys.envelopeV3]: JSON.stringify(workspace) });
  const coordinator = createWorkspaceV3Coordinator({ storage, keys, lockManager: exclusiveLocks() });
  const desiredWorkspace = saveDraftRecordV3(workspace, {
    contentPackage: { ...record.content_package, id: "saved-entry", saved_at: T1 },
    updatedAt: T1,
  });
  const desiredRecord = activeDraftRecordV3(desiredWorkspace);
  assert.equal(draftRecordToken(desiredRecord), draftRecordToken(record), "bookkeeping fields intentionally stay outside the semantic CAS token");

  const receipt = await coordinator.mergeDraftCas({
    draftId: record.draft_id,
    expectedDraftToken: draftRecordToken(record),
    replacementDraft: desiredRecord,
    requireActiveDraftId: record.draft_id,
    reason: "SAVE_ACTIVE_DRAFT_V3",
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.disposition, "COMMITTED");
  assert.equal(receipt.target_draft.content_package.saved_at, T1);
  assert.equal(receipt.target_draft.content_package.id, "saved-entry");
  assert.deepEqual(libraryContentsV3(receipt.workspace).map((item) => item.draft_record_id), [record.draft_id]);
});

test("authoring action references persist as an ordered ref-only manifest through save, backup, restore and hydration", async () => {
  const bytes = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const media_ref = `xiaoshimei-media://sha256/${sha256}`;
  const manifest = {
    schema: "xiaoshimei.media-asset-manifest.v1",
    media_ref,
    sha256,
    size_bytes: bytes.byteLength,
    mime: "image/jpeg",
    name: "弓步参考.jpg",
    width: 640,
    height: 480,
  };
  const note = "只参考重心与出拳方向，人物和服装不要照搬。\n保持侧前方视角。";
  const session = {
    ...fullSession("action-reference-text"),
    image_resume: null,
    action_reference_manifest: [manifest],
    action_reference_note: note,
  };
  const previous = createDraftRecordV3({ draftId: "action-reference-previous", contentPackage: content("上一稿", "action-reference-previous"), createdAt: T0 });
  const record = createDraftRecordV3({
    draftId: "action-reference-current",
    contentPackage: assembledContent(session, "action-reference-current"),
    generationSession: session,
    createdAt: T0,
  });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    previous_draft_id: previous.draft_id,
    drafts: [record, previous],
    legacy_v2_source: null,
  });
  const normalizedSession = activeDraftRecordV3(workspace).generation_session;
  assert.equal(normalizedSession.schema, AUTHORING_SESSION_SCHEMA, "generation-session input migrates to the authoring schema");
  assert.deepEqual(normalizedSession.action_reference_manifest, [manifest]);
  assert.equal(normalizedSession.action_reference_note, note);
  assert.equal(/(?:data|blob):|"bytes(?:_base64)?"\s*:/.test(JSON.stringify(normalizedSession.action_reference_manifest)), false);

  const saved = saveDraftRecordV3(workspace, {
    contentPackage: { ...record.content_package, body: `${record.content_package.body}\n保存一次` },
    updatedAt: T1,
  });
  assert.deepEqual(activeDraftRecordV3(saved).generation_session.action_reference_manifest, [manifest]);
  assert.equal(saved.previous_draft_id, previous.draft_id);

  const mediaStore = verifiedMediaStore([{ ...manifest, bytes: new Uint8Array(bytes) }]);
  const backup = await buildWorkspaceBackupV3({ workspace: saved, mediaStore, createdAt: T1 });
  assert.deepEqual(backup.media_assets.map((asset) => asset.media_ref), [media_ref], "collectMediaRefs must include pre-generation session refs");
  const parsedBackup = await parseWorkspaceBackupV3(JSON.stringify(backup));
  assert.deepEqual(activeDraftRecordV3(parsedBackup.workspace).generation_session.action_reference_manifest, [manifest]);
  assert.equal(parsedBackup.workspace.previous_draft_id, previous.draft_id);

  const released = [];
  mediaStore.hydrateMedia = async (ref) => {
    if (!mediaStore.assets.has(ref)) throw new TypeError("MEDIA_READBACK_MISSING");
    return { media_ref: ref, url: `blob:https://studio.example/action-${ref.slice(-8)}` };
  };
  mediaStore.releaseHydratedMedia = (hydrated) => { released.push(hydrated.url); return true; };
  const view = await hydrateWorkspaceV3View({ workspace: parsedBackup.workspace, mediaStore });
  assert.equal(view.ok, true);
  assert.deepEqual(activeDraftRecordV3(view.workspace).generation_session.action_reference_manifest, [manifest], "hydration preserves ref authority instead of persisting blob URLs");
  assert.equal(view.workspace.previous_draft_id, previous.draft_id);
  assert.equal(view.hydrations.length, 1);
  view.release();
  assert.equal(released.length, 1);

  const restoreStorage = memoryStorage();
  const restoreMedia = verifiedMediaStore();
  const coordinator = createWorkspaceV3Coordinator({
    storage: restoreStorage,
    keys: { envelope: "workspace-v2", envelopeV3: "workspace-v3" },
    lockManager: exclusiveLocks(),
  });
  const restored = await restoreWorkspaceBackupV3({
    serialized: JSON.stringify(backup),
    coordinator,
    mediaStore: restoreMedia,
    expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN,
  });
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.active_draft.generation_session.action_reference_manifest, [manifest]);
  assert.equal(restored.active_draft.generation_session.action_reference_note, note);
  assert.equal(restored.workspace.previous_draft_id, previous.draft_id);

  const four = Array.from({ length: 4 }, () => manifest);
  assert.throws(() => createDraftRecordV3({
    draftId: "too-many-action-references",
    contentPackage: record.content_package,
    generationSession: { ...session, action_reference_manifest: four },
    createdAt: T0,
  }), /ACTION_REFERENCE_COUNT_EXCEEDED/);
  assert.throws(() => createDraftRecordV3({
    draftId: "inline-action-reference",
    contentPackage: record.content_package,
    generationSession: { ...session, action_reference_manifest: [{ ...manifest, media_ref: "data:image/jpeg;base64,AAAA" }] },
    createdAt: T0,
  }), /(?:ACTION_REFERENCE_|MEDIA_REF_INVALID)/);
});

test("v3 main mutation helpers preserve pending image authority across autosave, new draft, activation and profile changes", () => {
  const session = { ...fullSession("helper-text"), image_resume: null };
  const pending = createPendingImageOperation({
    operationNonce: "1".repeat(64),
    operationSnapshot: imageOperationSnapshot("helper-a", session.text_draft),
    operationSnapshotHash: "2".repeat(64),
    inputHash: "3".repeat(64),
    orderedReferenceManifest: [],
    protocolState: "READY",
  });
  const record = createDraftRecordV3({
    draftId: "helper-a",
    contentPackage: assembledContent(session, "helper-a"),
    generationSession: session,
    pendingImageOperation: pending,
    createdAt: T0,
  });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    drafts: [record],
    legacy_v2_source: null,
  });
  const savedContent = { ...record.content_package, body: `${record.content_package.body}\n本人补充的一句`, saved_at: T1 };
  const saved = saveDraftRecordV3(workspace, { contentPackage: savedContent, generationSession: session, updatedAt: T1 });
  assert.deepEqual(activeDraftRecordV3(saved).pending_image_operation, pending);
  assert.equal(libraryContentsV3(saved)[0].draft_record_id, record.draft_id);

  const created = beginNewDraftV3(saved, { newDraftId: "helper-b", currentContent: savedContent, currentSession: session, savedAt: "2026-08-31T06:06:00.000Z" });
  assert.equal(created.previousDraftId, record.draft_id);
  assert.equal(created.activeDraft.pending_image_operation, null);
  assert.deepEqual(created.workspace.drafts.find((draft) => draft.draft_id === record.draft_id).pending_image_operation, pending);
  const activated = activateDraftRecordV3(created.workspace, record.draft_id, { activatedAt: "2026-08-31T06:07:00.000Z" });
  assert.equal(activeDraftRecordV3(activated.workspace).draft_id, record.draft_id);
  const nextProfile = { ...activated.workspace.profile, account_owner: "小师妹本人" };
  const profiled = saveWorkspaceProfileV3(activated.workspace, nextProfile, { updatedAt: "2026-08-31T06:08:00.000Z" });
  assert.equal(profiled.profile.account_owner, "小师妹本人");
  assert.deepEqual(activeDraftRecordV3(profiled).pending_image_operation, pending);
  assert.match(workspaceEnvelopeV3Token(profiled), /workspace-envelope\.v3/);
});

test("READY and READY_DISCOVERY persist as planning-ready while only PARTIAL records produced image progress", async () => {
  const session = { ...fullSession("ready-text"), image_resume: null };
  const pending = createPendingImageOperation({
    operationNonce: "4".repeat(64),
    operationSnapshot: imageOperationSnapshot("ready-record", session.text_draft),
    operationSnapshotHash: "5".repeat(64),
    inputHash: "6".repeat(64),
    orderedReferenceManifest: [],
    protocolState: "BOOTSTRAP",
  });
  const record = createDraftRecordV3({
    draftId: "ready-record",
    contentPackage: assembledContent(session, "ready-record"),
    generationSession: session,
    pendingImageOperation: pending,
    createdAt: T0,
  });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    drafts: [record],
    legacy_v2_source: null,
  });
  const coordinator = createWorkspaceV3Coordinator({ storage: memoryStorage(), keys: { envelope: "workspace-v2", envelopeV3: "workspace-v3" }, lockManager: exclusiveLocks() });
  await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN, workspace });
  const ready = await commitDraftImageProgressV3({
    coordinator,
    mediaStore: null,
    draftId: record.draft_id,
    expectedDraftToken: draftRecordToken(record),
    operationSnapshot: record,
    recoveredDraftId: "ready-record-recovered",
    imageResume: { resume_run_id: "ready-run", completed_image_steps: 0, total_image_steps: 2 },
    responseStatus: "READY_DISCOVERY",
    mediaDelta: [],
    updatedAt: T1,
  });
  assert.equal(ready.action, "CONTINUE");
  assert.equal(ready.target_draft.pending_image_operation.protocol_state, "READY");
  assert.equal(ready.target_draft.pending_image_operation.completed_image_steps, 0);

  let writes = 0;
  await assert.rejects(() => commitDraftImageProgressV3({
    coordinator: { mergeDraftCas: async () => { writes += 1; } },
    mediaStore: null,
    draftId: record.draft_id,
    expectedDraftToken: draftRecordToken(record),
    operationSnapshot: record,
    recoveredDraftId: "ready-record-invalid",
    imageResume: { resume_run_id: "ready-run" },
    responseStatus: "COMPLETE",
  }), /IMAGE_TRANSACTION_RESPONSE_STATUS_INVALID/);
  assert.equal(writes, 0);
});

test("planner-only zero-image failure atomically releases the exact draft input lock and repeats idempotently", async () => {
  const session = { ...fullSession("planner-failed-text"), image_resume: null };
  const pending = createPendingImageOperation({
    operationNonce: "a".repeat(64),
    operationSnapshot: imageOperationSnapshot("planner-failed-record", session.text_draft),
    operationSnapshotHash: "b".repeat(64),
    inputHash: "c".repeat(64),
    orderedReferenceManifest: [],
    protocolState: "BOOTSTRAP",
  });
  const record = createDraftRecordV3({
    draftId: "planner-failed-record",
    contentPackage: assembledContent(session, "planner-failed-record"),
    generationSession: session,
    pendingImageOperation: pending,
    createdAt: T0,
  });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    drafts: [record],
    legacy_v2_source: null,
  });
  const coordinator = createWorkspaceV3Coordinator({ storage: memoryStorage(), keys: { envelope: "planner-v2", envelopeV3: "planner-v3" }, lockManager: exclusiveLocks() });
  await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN, workspace });

  const released = await commitDraftImagePlannerFailureV3({
    coordinator,
    draftId: record.draft_id,
    expectedDraftToken: draftRecordToken(record),
    operationSnapshot: record,
    updatedAt: T1,
  });
  assert.equal(released.action, "RELEASED");
  assert.equal(released.target_draft.pending_image_operation, null);
  assert.equal(released.target_draft.generation_session.image_resume, null);
  assert.equal(released.target_draft.generation_session.text_draft.draft_id, session.text_draft.draft_id);
  assert.deepEqual(released.target_draft.content_package, record.content_package);

  const stale = await commitDraftImagePlannerFailureV3({
    coordinator,
    draftId: record.draft_id,
    expectedDraftToken: draftRecordToken(record),
    operationSnapshot: record,
    updatedAt: "2026-08-31T06:10:00.000Z",
  });
  assert.equal(stale.action, "RELEASED");
  assert.equal(stale.target_draft.pending_image_operation, null);
});

test("workspace media-first adapter consumes the real media-store manifest-only put response and verifies bytes by a separate readback", async () => {
  const bytes = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const database = createMemoryMediaDatabase();
  const store = createMediaAssetStore({ database });
  const manifests = await putAndReadbackMediaDelta(store, [{ bytes, sha256, mime: "image/jpeg", name: "real-store.jpg" }]);
  assert.deepEqual(manifests, [{
    media_ref: `xiaoshimei-media://sha256/${sha256}`,
    sha256,
    size_bytes: bytes.byteLength,
    mime: "image/jpeg",
    name: "real-store.jpg",
  }]);
  assert.equal(database.stats.puts, 1);
  assert.ok(database.stats.gets >= 2, "put commit-readback plus an independent consumer readback both occurred");
});

test("UI data/blob media materialize before persistence and v3 hydration never exposes a raw ref on missing media", async () => {
  const firstBytes = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
  const secondBytes = Buffer.from("ffd8ffe100104a46494600010100000100010001ffd9", "hex");
  const draftContent = content("媒体边界", "media-boundary");
  draftContent.pages[0].image_style.src = `data:image/jpeg;base64,${firstBytes.toString("base64")}`;
  draftContent.pages[1].image_style.src = "blob:https://studio.example/local-selection";
  const store = verifiedMediaStore();
  const materialized = await materializePersistentMediaRefsV3({
    value: draftContent,
    mediaStore: store,
    resolveBlobUrl: async (url) => {
      assert.equal(url, "blob:https://studio.example/local-selection");
      return { bytes: secondBytes, mime: "image/jpeg", name: "local-selection.jpg" };
    },
  });
  assert.equal(/(?:data|blob):/.test(JSON.stringify(materialized.value)), false);
  assert.equal(materialized.media_manifest.length, 2);
  const refs = materialized.media_manifest.map((item) => item.media_ref);
  assert.equal(new Set(refs).size, 2);

  const record = createDraftRecordV3({ draftId: "media-boundary", contentPackage: materialized.value, createdAt: T0 });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: record.draft_id,
    drafts: [record],
    legacy_v2_source: null,
  });
  const released = [];
  let hydrationNumber = 0;
  store.hydrateMedia = async (mediaRef) => {
    if (!store.assets.has(mediaRef)) throw new TypeError("MEDIA_READBACK_MISSING");
    hydrationNumber += 1;
    return { media_ref: mediaRef, url: `blob:https://studio.example/hydrated-${hydrationNumber}` };
  };
  store.releaseHydratedMedia = (hydrated) => { released.push(hydrated.url); return true; };
  const view = await hydrateWorkspaceV3View({ workspace, mediaStore: store });
  assert.equal(view.ok, true);
  assert.equal(view.persistable, false);
  assert.match(view.workspace.drafts[0].content_package.pages[0].image_style.src, /^blob:/);
  assert.match(view.workspace.drafts[0].content_package.pages[1].image_style.src, /^blob:/);
  assert.equal(view.release(), true);
  assert.equal(view.release(), false);
  assert.equal(released.length, 2);

  const missingStore = { ...store, assets: new Map(store.assets) };
  missingStore.assets.delete(refs[0]);
  missingStore.hydrateMedia = async (mediaRef) => {
    if (!missingStore.assets.has(mediaRef)) throw new TypeError("MEDIA_READBACK_MISSING");
    return { media_ref: mediaRef, url: `blob:https://studio.example/only-${mediaRef.slice(-8)}` };
  };
  const failedView = await hydrateWorkspaceV3View({ workspace, mediaStore: missingStore });
  assert.equal(failedView.ok, false);
  assert.equal(failedView.code, "WORKSPACE_V3_MEDIA_HYDRATION_FAILED");
  assert.equal(failedView.workspace, null, "a failed view cannot hand raw xiaoshimei-media refs to the DOM");
  assert.deepEqual(failedView.missing_refs.map((item) => item.media_ref), [refs[0]]);
});

test("v3 image transactions persist media before refs, keep active B unchanged, and atomically finish A or a recovered sibling", async () => {
  const bytes = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const media_ref = `xiaoshimei-media://sha256/${sha256}`;
  const events = [];
  const mediaStore = verifiedMediaStore([], { events });
  const session = { ...fullSession("tx-text"), image_resume: null };
  const pending = createPendingImageOperation({
    operationNonce: "9".repeat(64),
    operationSnapshot: imageOperationSnapshot("record-a", session.text_draft),
    operationSnapshotHash: "a".repeat(64),
    inputHash: "b".repeat(64),
    orderedReferenceManifest: [],
    protocolState: "READY",
    runId: "images-2026-08-31T16-00-00-000Z-abcdef12",
    checkpointPreimageHash: "c".repeat(64),
    logicalStepId: "step-1",
  });
  const recordA = createDraftRecordV3({
    draftId: "record-a",
    contentPackage: assembledContent(session, "record-a"),
    generationSession: session,
    pendingImageOperation: pending,
    createdAt: T0,
  });
  const recordB = createDraftRecordV3({
    draftId: "record-b",
    contentPackage: content("B 前台稿", "record-b"),
    generationSession: null,
    createdAt: T0,
  });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: "record-b",
    previous_draft_id: "record-a",
    drafts: [recordA, recordB],
    legacy_v2_source: null,
  });
  const storage = memoryStorage();
  const baseCoordinator = createWorkspaceV3Coordinator({
    storage,
    keys: { envelope: "workspace-v2", envelopeV3: "workspace-v3" },
    lockManager: exclusiveLocks(),
    mediaStore,
  });
  const boot = await baseCoordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN, workspace });
  const bBefore = structuredClone(boot.active_draft);
  const coordinator = {
    async mergeDraftCas(input) {
      events.push("workspace");
      return baseCoordinator.mergeDraftCas(input);
    },
  };
  const progress = await commitDraftImageProgressV3({
    coordinator,
    mediaStore,
    draftId: recordA.draft_id,
    expectedDraftToken: draftRecordToken(recordA),
    operationSnapshot: recordA,
    recoveredDraftId: "record-a-recovered",
    imageResume: {
      resume_run_id: pending.run_id,
      checkpoint_preimage_hash: pending.checkpoint_preimage_hash,
      logical_step_id: pending.logical_step_id,
      completed_image_steps: 1,
      total_image_steps: 2,
      local_media_refs: [media_ref],
    },
    mediaDelta: [{ bytes, sha256, mime: "image/jpeg", name: "partial.jpg" }],
    updatedAt: T1,
  });
  assert.equal(progress.action, "CONTINUE");
  assert.deepEqual(events, ["put", "read", "read", "workspace"]);
  assert.deepEqual(progress.workspace.drafts.find((item) => item.draft_id === "record-b"), bBefore);
  assert.equal(progress.workspace.active_draft_id, "record-b");
  assert.equal(progress.workspace.previous_draft_id, "record-a", "image progress must not rewrite the navigation hint");
  assert.equal(progress.target_draft.pending_image_operation.protocol_state, "PARTIAL");

  const progressRetry = await commitDraftImageProgressV3({
    coordinator: baseCoordinator,
    mediaStore,
    draftId: recordA.draft_id,
    expectedDraftToken: draftRecordToken(recordA),
    operationSnapshot: recordA,
    recoveredDraftId: "record-a-recovered",
    imageResume: {
      resume_run_id: pending.run_id,
      checkpoint_preimage_hash: pending.checkpoint_preimage_hash,
      logical_step_id: pending.logical_step_id,
      completed_image_steps: 1,
      total_image_steps: 2,
      local_media_refs: [media_ref],
    },
    mediaDelta: [{ bytes, sha256, mime: "image/jpeg", name: "partial.jpg" }],
    updatedAt: "2026-08-31T06:07:00.000Z",
  });
  assert.equal(progressRetry.action, "CONTINUE", "response-loss replay must read back the already committed target");
  assert.equal(progressRetry.disposition, "NOOP_ALREADY_APPLIED");
  assert.equal(progressRetry.recovered_draft_id, null);
  assert.equal(progressRetry.workspace.drafts.length, 2, "response-loss replay must not create a recovered sibling");

  const finalContent = assembledContent(session, "record-a-finished");
  finalContent.pages[0].image_style.src = media_ref;
  finalContent.generation = {
    ...finalContent.generation,
    mode: "PROVIDER",
    provider: "volcengine-ark",
    production_mode: "smart",
    source_draft_id: session.text_draft.draft_id,
    strategy: "resumable_public_image_steps_v1",
    notice: "test final",
  };
  const completed = await commitDraftImageCompletionV3({
    coordinator: baseCoordinator,
    mediaStore,
    draftId: recordA.draft_id,
    expectedDraftToken: draftRecordToken(progress.target_draft),
    operationSnapshot: progress.target_draft,
    recoveredDraftId: "record-a-recovered",
    contentPackage: finalContent,
    mediaDelta: [],
    updatedAt: "2026-08-31T06:10:00.000Z",
  });
  assert.equal(completed.action, "COMPLETE");
  assert.equal(completed.adopt_current_ui, false);
  assert.equal(completed.target_draft.pending_image_operation, null);
  assert.equal(completed.target_draft.generation_session.image_resume, null);
  assert.equal(completed.target_draft.generation_session.assembled_draft_id, session.text_draft.draft_id);
  assert.deepEqual(completed.workspace.drafts.find((item) => item.draft_id === "record-b"), bBefore);
  assert.equal(completed.workspace.previous_draft_id, "record-a", "image completion must not rewrite the navigation hint");

  const completionRetry = await commitDraftImageCompletionV3({
    coordinator: baseCoordinator,
    mediaStore,
    draftId: recordA.draft_id,
    expectedDraftToken: draftRecordToken(progress.target_draft),
    operationSnapshot: progress.target_draft,
    recoveredDraftId: "record-a-recovered",
    contentPackage: finalContent,
    mediaDelta: [],
    updatedAt: "2026-08-31T06:12:00.000Z",
  });
  assert.equal(completionRetry.action, "COMPLETE", "completion response-loss replay must return the committed target");
  assert.equal(completionRetry.disposition, "NOOP_ALREADY_APPLIED");
  assert.equal(completionRetry.recovered_draft_id, null);
  assert.equal(completionRetry.workspace.drafts.length, 2, "completion replay must not fork a duplicate final draft");

  const failedEvents = [];
  const failedStore = verifiedMediaStore([], { events: failedEvents, failPut: true });
  let writes = 0;
  const failed = await commitDraftImageProgressV3({
    coordinator: { mergeDraftCas: async () => { writes += 1; throw new Error("must not write"); } },
    mediaStore: failedStore,
    draftId: recordA.draft_id,
    expectedDraftToken: draftRecordToken(recordA),
    operationSnapshot: recordA,
    recoveredDraftId: "record-a-recovered-failed",
    imageResume: { resume_run_id: pending.run_id, completed_image_steps: 1 },
    mediaDelta: [{ bytes, sha256, mime: "image/jpeg", name: "quota.jpg" }],
    updatedAt: T1,
  });
  assert.equal(failed.action, "STOP");
  assert.equal(failed.code, "IMAGE_OPERATION_MEDIA_PERSIST_FAILED");
  assert.equal(writes, 0);
});

test("a paid v3 PARTIAL that conflicts with edited A commits one recovered sibling and returns STOP", async () => {
  const session = { ...fullSession("partial-conflict-text"), image_resume: null };
  const pending = createPendingImageOperation({
    operationNonce: "7".repeat(64),
    operationSnapshot: imageOperationSnapshot("partial-a", session.text_draft),
    operationSnapshotHash: "7".repeat(64),
    inputHash: "8".repeat(64),
    orderedReferenceManifest: [],
    protocolState: "READY",
    runId: "images-2026-08-31T18-00-00-000Z-abcdef12",
  });
  const recordA = createDraftRecordV3({
    draftId: "partial-a",
    contentPackage: assembledContent(session, "partial-a"),
    generationSession: session,
    pendingImageOperation: pending,
    createdAt: T0,
  });
  const recordB = createDraftRecordV3({ draftId: "partial-b", contentPackage: content("B 继续前台编辑", "partial-b"), createdAt: T0 });
  const workspace = parseWorkspaceEnvelopeV3({
    schema: WORKSPACE_ENVELOPE_V3_SCHEMA,
    authority_effect: "LOCAL_EDITING_ONLY",
    updated_at: T0,
    profile: createProfileV2(),
    active_draft_id: recordB.draft_id,
    drafts: [recordA, recordB],
    legacy_v2_source: null,
  });
  const storage = memoryStorage();
  const coordinator = createWorkspaceV3Coordinator({
    storage,
    keys: { envelope: "workspace-v2", envelopeV3: "workspace-v3" },
    lockManager: exclusiveLocks(),
  });
  const boot = await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN, workspace });
  const bBefore = structuredClone(boot.active_draft);
  const editedA = createDraftRecordV3({
    draftId: recordA.draft_id,
    contentPackage: { ...recordA.content_package, body: "A 已被本人改成另一版，迟到结果只能进恢复副本" },
    generationSession: recordA.generation_session,
    pendingImageOperation: recordA.pending_image_operation,
    createdAt: recordA.created_at,
    updatedAt: T1,
  });
  const edited = await coordinator.mergeDraftCas({
    draftId: recordA.draft_id,
    expectedDraftToken: draftRecordToken(recordA),
    replacementDraft: editedA,
  });
  assert.equal(edited.ok, true);

  const result = await commitDraftImageProgressV3({
    coordinator,
    mediaStore: null,
    draftId: recordA.draft_id,
    expectedDraftToken: draftRecordToken(recordA),
    operationSnapshot: recordA,
    recoveredDraftId: "partial-a-recovered",
    imageResume: {
      resume_run_id: pending.run_id,
      completed_image_steps: 1,
      total_image_steps: 2,
    },
    mediaDelta: [],
    updatedAt: "2026-08-31T06:15:00.000Z",
  });
  assert.equal(result.action, "STOP");
  assert.equal(result.disposition, "RECOVERED_SIBLING_COMMITTED");
  assert.equal(result.recovered_draft.draft_id, "partial-a-recovered");
  assert.equal(result.recovered_draft.pending_image_operation.protocol_state, "PARTIAL");
  assert.equal(result.workspace.drafts.find((item) => item.draft_id === recordA.draft_id).content_package.body, editedA.content_package.body);
  assert.equal(result.workspace.active_draft_id, recordB.draft_id);
  assert.deepEqual(result.active_draft, bBefore);
});

test("v3 image completion never overwrites edited A and commits one final recovered sibling without changing active B", async () => {
  const session = { ...fullSession("conflict-text"), image_resume: null };
  const pending = createPendingImageOperation({
    operationNonce: "d".repeat(64),
    operationSnapshot: imageOperationSnapshot("conflict-a", session.text_draft),
    operationSnapshotHash: "d".repeat(64),
    inputHash: "e".repeat(64),
    orderedReferenceManifest: [],
    protocolState: "READY",
  });
  const recordA = createDraftRecordV3({ draftId: "conflict-a", contentPackage: assembledContent(session, "conflict-a"), generationSession: session, pendingImageOperation: pending, createdAt: T0 });
  const recordB = createDraftRecordV3({ draftId: "conflict-b", contentPackage: content("B 不受影响", "conflict-b"), createdAt: T0 });
  const workspace = parseWorkspaceEnvelopeV3({ schema: WORKSPACE_ENVELOPE_V3_SCHEMA, authority_effect: "LOCAL_EDITING_ONLY", updated_at: T0, profile: createProfileV2(), active_draft_id: recordB.draft_id, drafts: [recordA, recordB], legacy_v2_source: null });
  const coordinator = createWorkspaceV3Coordinator({ storage: memoryStorage(), keys: { envelope: "workspace-v2", envelopeV3: "workspace-v3" }, lockManager: exclusiveLocks() });
  const boot = await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_V3_ABSENT_TOKEN, workspace });
  const bBefore = structuredClone(boot.active_draft);
  const editedA = createDraftRecordV3({
    draftId: recordA.draft_id,
    contentPackage: { ...recordA.content_package, body: "另一标签已编辑 A，付费结果不能覆盖这里" },
    generationSession: recordA.generation_session,
    pendingImageOperation: recordA.pending_image_operation,
    createdAt: recordA.created_at,
    updatedAt: T1,
  });
  const edited = await coordinator.mergeDraftCas({ draftId: recordA.draft_id, expectedDraftToken: draftRecordToken(recordA), replacementDraft: editedA });
  assert.equal(edited.ok, true);
  const finalContent = assembledContent(session, "conflict-final");
  finalContent.generation = { ...finalContent.generation, mode: "PROVIDER", provider: "volcengine-ark", source_draft_id: session.text_draft.draft_id, strategy: "resumable_public_image_steps_v1" };
  const completed = await commitDraftImageCompletionV3({
    coordinator,
    mediaStore: null,
    draftId: recordA.draft_id,
    expectedDraftToken: draftRecordToken(recordA),
    operationSnapshot: recordA,
    recoveredDraftId: "conflict-a-recovered",
    contentPackage: finalContent,
    mediaDelta: [],
    updatedAt: "2026-08-31T06:20:00.000Z",
  });
  assert.equal(completed.action, "COMPLETE");
  assert.equal(completed.disposition, "RECOVERED_SIBLING_COMMITTED");
  assert.equal(completed.recovered_draft.draft_id, "conflict-a-recovered");
  assert.equal(completed.recovered_draft.pending_image_operation, null);
  assert.equal(completed.workspace.drafts.find((item) => item.draft_id === recordA.draft_id).content_package.body, editedA.content_package.body);
  assert.equal(completed.workspace.active_draft_id, recordB.draft_id);
  assert.deepEqual(completed.active_draft, bBefore);
});
