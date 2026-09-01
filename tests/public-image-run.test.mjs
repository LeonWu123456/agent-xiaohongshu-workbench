import assert from "node:assert/strict";
import test from "node:test";
import {
  admitPublicImageJob,
  appendPublicImageJobs,
  claimDraftBoundImageOperation,
  completePublicImageRun,
  createDraftBoundImageOperation,
  createPublicImageRun,
  failPublicImageJob,
  markPublicImageBudgetExhausted,
  parsePublicImageRun,
  persistDraftBoundImageCompletion,
  persistDraftBoundImageProgress,
  PUBLIC_IMAGE_CALL_LIMIT,
  publicImageRunProgress,
  startPublicImageJob,
  unresolvedPublicImageUnitIds,
} from "../src/public-image-run.mjs";
import { generateContentPackage } from "../src/content-engine.mjs";
import { createProfileV2 } from "../src/profile-v2.mjs";
import {
  AUTHORING_SESSION_SCHEMA,
  WORKSPACE_ABSENT_TOKEN,
  activeDraftRecord,
  beginNewDraft,
  buildWorkspaceEnvelope,
  createDraftRecord,
  createWorkspaceCoordinator,
  draftRecordToken,
  loadWorkspaceEnvelope,
} from "../src/workspace-state.mjs";

const WORKSPACE_KEYS = {
  envelope: "workspace-v2",
  content: "content-v1",
  library: "library-v1",
  profile: "profile-v1",
  generationSession: "generation-v1",
};

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function exclusiveLocks() {
  let tail = Promise.resolve();
  return {
    request(_name, _options, callback) {
      const before = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      return before.then(callback).finally(release);
    },
  };
}

function operationTextDraft(id = "text-a") {
  const source = "久坐后肩颈发紧，想在工位做三分钟舒缓。";
  return {
    schema: "xiaoshimei.text-draft-response.v1",
    draft_id: id,
    created_at: "2026-08-31T14:00:00.000Z",
    source_input: source,
    text_requirements: "",
    prompt_context: {},
    pillar: "wellness",
    goal: "save",
    titles: ["久坐肩颈发紧 三分钟工位舒缓", "工位三分钟 慢慢松开肩颈", "坐久了先做这三个舒缓动作"],
    selected_title: "久坐肩颈发紧 三分钟工位舒缓",
    body: "先把身体坐稳，双脚踩实地面，再缓慢转头到舒适范围。接着让肩胛骨轻轻向后靠拢，保持自然呼吸。动作不追求幅度，也不要憋气或突然发力；如果疼痛明显、手臂麻木或越做越不舒服，应当立即停止并咨询专业人士。把这三分钟当成工作间隙的放松，不用硬撑，也不要拿日常舒缓替代正规诊疗。".repeat(2),
    tags: ["肩颈舒缓", "久坐办公", "工位拉伸", "日常放松", "小师妹养生"],
    recommended_image_count: 3,
    facts: [],
    risks: [],
    generation: {},
  };
}

function operationSession(draft) {
  return {
    schema: AUTHORING_SESSION_SCHEMA,
    topic: draft.source_input,
    pillar: draft.pillar,
    goal: draft.goal,
    text_requirements: draft.text_requirements,
    text_draft: draft,
    text_confirmed: true,
    assembled_draft_id: null,
    image_count_mode: "CUSTOM",
    custom_image_count: 3,
    production_mode: "infographic",
    image_resume: null,
  };
}

function startContent(id = "start-a") {
  return { ...generateContentPackage({ topic: "旧画布等待确认文字配图", pillar: "wellness", goal: "save" }), id };
}

function finalContent(draft, id = "finished-a") {
  const content = generateContentPackage({ topic: draft.source_input, pillar: draft.pillar, goal: draft.goal });
  return {
    ...content,
    id,
    source_input: draft.source_input,
    pillar: draft.pillar,
    goal: draft.goal,
    titles: [...draft.titles],
    selectedTitle: draft.selected_title,
    body: draft.body,
    tags: [...draft.tags],
    generation: {
      ...content.generation,
      mode: "PROVIDER",
      provider: "volcengine-ark",
      production_mode: "infographic",
      source_draft_id: draft.draft_id,
      strategy: "resumable_public_image_steps_v1",
      notice: "测试中的已付费结果",
    },
  };
}

async function operationFixture() {
  const storage = memoryStorage();
  const coordinator = createWorkspaceCoordinator({ storage, keys: WORKSPACE_KEYS, lockManager: exclusiveLocks() });
  const draft = operationTextDraft();
  const session = operationSession(draft);
  const record = createDraftRecord({
    draftId: "record-a",
    contentPackage: startContent(),
    generationSession: session,
    createdAt: "2026-08-31T14:00:00.000Z",
  });
  const workspace = buildWorkspaceEnvelope({
    profile: createProfileV2(),
    activeDraftId: record.draft_id,
    drafts: [record],
    updatedAt: record.updated_at,
  });
  const boot = await coordinator.fullCas({ expectedWorkspaceToken: WORKSPACE_ABSENT_TOKEN, workspace });
  const operation = createDraftBoundImageOperation({
    operationId: "image-op-a",
    sourceDraftRecord: boot.active_draft,
    recoveredDraftId: "record-a-recovered-image-op-a",
    requestSnapshot: { production_mode: "infographic", image_count: 3, reference_images: [], reference_note: "" },
  });
  return { storage, coordinator, draft, session, workspace: boot.workspace, operation };
}

function tile(unitId, seed = "a") {
  return {
    unit_id: unitId,
    page_index: Number(unitId.split("-")[1]) - 1,
    panel_index: null,
    src: `data:image/jpeg;base64,${Buffer.from(`image-${unitId}`).toString("base64")}`,
    sha256: seed.repeat(64),
    size_bytes: 2048,
    width: 720,
    height: 960,
  };
}

function base() {
  const units = [1, 2].map((page) => ({ unit_id: `page-${page}-hero`, page_index: page - 1, panel_index: null }));
  return createPublicImageRun({
    runId: "images-2026-08-31T08-00-00-000Z-abcdef12",
    draftId: "draft-1",
    draftSha256: "d".repeat(64),
    productionMode: "smart",
    finalPages: [{ title: "第一页" }, { title: "第二页" }],
    illustrationUnits: units,
    planAttempts: [{ attempt: 1, status: "PASS" }],
    referenceFingerprint: "f".repeat(64),
    jobs: [{ sheet_id: "mother-sheet-1", sheet_index: 0, template: "grid-3x3", units, job_kind: "mother_sheet" }],
  });
}

test("public image run admits one paid step, preserves good assets, and appends only missing repairs", () => {
  let run = startPublicImageJob(base());
  assert.equal(run.actual_image_calls, 1);
  run = admitPublicImageJob(run, { assets: [tile("page-1-hero")], attempt: { image_sha256: "1".repeat(64) } });
  assert.deepEqual(unresolvedPublicImageUnitIds(run), ["page-2-hero"]);
  assert.deepEqual(publicImageRunProgress(run), {
    resume_run_id: run.run_id,
    completed_pages: 1,
    total_pages: 2,
    completed_image_steps: 1,
    total_image_steps: 1,
    failed_image_step: null,
    max_image_calls: 6,
    actual_image_calls: 1,
    remaining_image_calls: 5,
    plan_exceeds_remaining_budget: false,
    estimated_image_cost_cny: 0.22,
  });
  run = appendPublicImageJobs(run, { phase: "STANDALONE_REPAIR", jobs: [{ sheet_id: "standalone-page-2", sheet_index: 1, units: [run.illustration_units[1]], job_kind: "standalone" }] });
  run = startPublicImageJob(run);
  run = admitPublicImageJob(run, { assets: [tile("page-2-hero", "b")] });
  run = completePublicImageRun(run);
  assert.equal(run.status, "COMPLETE");
  assert.equal(run.actual_image_calls, 2);
  assert.deepEqual(unresolvedPublicImageUnitIds(run), []);
});

test("a failed public image step is resumable at the same job without losing earlier assets", () => {
  let run = startPublicImageJob(base());
  run = failPublicImageJob(run, { code: "MOTHER_SHEET_1_CALL_FAILED:timeout" });
  assert.equal(run.status, "PARTIAL_FAILURE_RESUMABLE");
  assert.equal(run.next_job_index, 0);
  assert.equal(run.actual_image_calls, 1);
  assert.equal(publicImageRunProgress(run).failed_image_step, 1);
  run = startPublicImageJob(run);
  run = admitPublicImageJob(run, { assets: [tile("page-1-hero"), tile("page-2-hero", "b")] });
  assert.equal(run.next_job_index, 1);
  assert.equal(run.actual_image_calls, 2);
  assert.equal(run.assets.length, 2);
});

test("public image checkpoint rejects lineage drift and duplicate assets", () => {
  const run = base();
  assert.equal(parsePublicImageRun(run, { draftId: "draft-1", draftSha256: "d".repeat(64), finalPageCount: 2 }).run_id, run.run_id);
  assert.throws(() => parsePublicImageRun(run, { draftId: "draft-2" }), /DRAFT_ID_MISMATCH/);
  assert.throws(() => parsePublicImageRun({ ...run, assets: [tile("page-1-hero"), tile("page-1-hero")] }), /ASSET_DUPLICATE/);
});

test("the signed run budget makes a seventh upstream image call impossible", () => {
  let run = base();
  assert.equal(run.max_image_calls, PUBLIC_IMAGE_CALL_LIMIT);
  for (let call = 1; call <= PUBLIC_IMAGE_CALL_LIMIT; call += 1) {
    run = startPublicImageJob(run);
    run = failPublicImageJob(run, { code: `TEST_FAILURE_${call}` });
  }
  assert.equal(run.actual_image_calls, 6);
  assert.equal(publicImageRunProgress(run).remaining_image_calls, 0);
  assert.equal(publicImageRunProgress(run).plan_exceeds_remaining_budget, true);
  assert.throws(() => startPublicImageJob(run), /IMAGE_CALL_BUDGET_EXHAUSTED/);
  const exhausted = markPublicImageBudgetExhausted(run);
  assert.equal(exhausted.status, "PARTIAL_FAILURE_RESUMABLE");
  assert.equal(exhausted.failure.code, "IMAGE_CALL_BUDGET_EXHAUSTED");
  assert.equal(exhausted.actual_image_calls, 6);
});

test("checkpoint parsing rejects a browser-raised or reset image-call budget", () => {
  const run = base();
  assert.throws(() => parsePublicImageRun({ ...run, max_image_calls: 60 }), /CALL_LIMIT_INVALID/);
  assert.throws(() => parsePublicImageRun({ ...run, actual_image_calls: 7 }), /CALL_EVIDENCE_INVALID/);
});

test("a draft-bound image operation is immutable and COMPLETE is durable before immediate reload", async () => {
  const fixture = await operationFixture();
  assert.equal(Object.isFrozen(fixture.operation), true);
  assert.equal(Object.isFrozen(fixture.operation.record_snapshot), true);
  assert.equal(claimDraftBoundImageOperation(null, fixture.operation).operation_id, "image-op-a");
  assert.throws(() => claimDraftBoundImageOperation(fixture.operation, fixture.operation), /IMAGE_GENERATION_ALREADY_RUNNING/);

  const partial = await persistDraftBoundImageProgress({
    operation: fixture.operation,
    coordinator: fixture.coordinator,
    imageResume: { resume_run_id: "images-2026-08-31T14-00-01-000Z-abcdef12", completed_image_steps: 1, total_image_steps: 2 },
    updatedAt: "2026-08-31T14:00:01.000Z",
  });
  assert.equal(partial.action, "CONTINUE");
  assert.notEqual(partial.operation.expected_draft_token, fixture.operation.expected_draft_token);

  const completed = await persistDraftBoundImageCompletion({
    operation: partial.operation,
    coordinator: fixture.coordinator,
    contentPackage: finalContent(fixture.draft),
    updatedAt: "2026-08-31T14:00:02.000Z",
  });
  assert.equal(completed.action, "COMPLETE");
  assert.equal(completed.adopt_current_ui, true);
  assert.equal(completed.target_draft.generation_session.assembled_draft_id, fixture.draft.draft_id);
  assert.equal(completed.target_draft.generation_session.image_resume, null);
  const reloaded = loadWorkspaceEnvelope(fixture.storage, WORKSPACE_KEYS.envelope);
  assert.equal(activeDraftRecord(reloaded).content_package.id, "finished-a");
  assert.equal(activeDraftRecord(reloaded).generation_session.assembled_draft_id, fixture.draft.draft_id);
  assert.equal(activeDraftRecord(reloaded).generation_session.image_resume, null);
});

test("PARTIAL and COMPLETE update A in the background while active B remains byte-for-byte unchanged", async () => {
  const fixture = await operationFixture();
  const withB = beginNewDraft(fixture.workspace, {
    newDraftId: "record-b",
    savedAt: "2026-08-31T14:00:01.000Z",
    contentPackage: generateContentPackage({ topic: "B 稿保持独立", pillar: "culture", goal: "save" }),
  }).workspace;
  const switched = await fixture.coordinator.fullCas({
    expectedWorkspaceToken: fixture.coordinator.snapshot().workspace_token,
    workspace: withB,
  });
  const bBefore = structuredClone(activeDraftRecord(switched.workspace));
  const partial = await persistDraftBoundImageProgress({
    operation: fixture.operation,
    coordinator: fixture.coordinator,
    imageResume: { resume_run_id: "images-2026-08-31T14-00-02-000Z-abcdef12", completed_image_steps: 1, total_image_steps: 2 },
    updatedAt: "2026-08-31T14:00:02.000Z",
  });
  assert.equal(partial.action, "CONTINUE");
  assert.equal(partial.workspace.active_draft_id, "record-b");
  assert.deepEqual(activeDraftRecord(partial.workspace), bBefore);
  assert.equal(partial.target_draft.generation_session.image_resume.completed_image_steps, 1);

  const completed = await persistDraftBoundImageCompletion({
    operation: partial.operation,
    coordinator: fixture.coordinator,
    contentPackage: finalContent(fixture.draft),
    updatedAt: "2026-08-31T14:00:03.000Z",
  });
  assert.equal(completed.action, "COMPLETE");
  assert.equal(completed.adopt_current_ui, false);
  assert.equal(completed.workspace.active_draft_id, "record-b");
  assert.deepEqual(activeDraftRecord(completed.workspace), bBefore);
  assert.equal(completed.target_draft.content_package.id, "finished-a");
  assert.equal(completed.target_draft.generation_session.image_resume, null);
});

test("a paid PARTIAL that conflicts with edited A creates a recovered sibling and returns STOP", async () => {
  const fixture = await operationFixture();
  const originalA = fixture.workspace.drafts.find((draft) => draft.draft_id === "record-a");
  const editedA = createDraftRecord({
    draftId: "record-a",
    contentPackage: { ...originalA.content_package, body: "用户在另一标签页改过 A，旧结果不能覆盖这里" },
    generationSession: originalA.generation_session,
    createdAt: originalA.created_at,
    updatedAt: "2026-08-31T14:00:01.000Z",
  });
  const edited = await fixture.coordinator.mergeDraftCas({
    draftId: "record-a",
    expectedDraftToken: draftRecordToken(originalA),
    replacementDraft: editedA,
  });
  assert.equal(edited.ok, true);

  let providerCalls = 1;
  const partial = await persistDraftBoundImageProgress({
    operation: fixture.operation,
    coordinator: fixture.coordinator,
    imageResume: { resume_run_id: "images-2026-08-31T14-00-02-000Z-abcdef12", completed_image_steps: 1, total_image_steps: 3 },
    updatedAt: "2026-08-31T14:00:02.000Z",
  });
  if (partial.action !== "STOP") providerCalls += 1;
  assert.equal(partial.action, "STOP");
  assert.equal(providerCalls, 1, "STOP is the provider-client directive; no next paid step may be requested");
  assert.equal(partial.disposition, "RECOVERED_SIBLING_COMMITTED");
  assert.equal(partial.recovered_draft.draft_id, fixture.operation.recovered_draft_id);
  assert.equal(partial.recovered_draft.generation_session.image_resume.completed_image_steps, 1);
  assert.equal(partial.workspace.drafts.find((draft) => draft.draft_id === "record-a").content_package.body, editedA.content_package.body);
});

test("a paid COMPLETE that conflicts with edited A commits one final recovered sibling without changing A", async () => {
  const fixture = await operationFixture();
  const originalA = fixture.workspace.drafts[0];
  const editedA = createDraftRecord({
    draftId: originalA.draft_id,
    contentPackage: { ...originalA.content_package, selectedTitle: originalA.content_package.titles[1] },
    generationSession: originalA.generation_session,
    createdAt: originalA.created_at,
    updatedAt: "2026-08-31T14:00:01.000Z",
  });
  const edited = await fixture.coordinator.mergeDraftCas({
    draftId: originalA.draft_id,
    expectedDraftToken: draftRecordToken(originalA),
    replacementDraft: editedA,
  });
  const withB = beginNewDraft(edited.workspace, {
    newDraftId: "record-b",
    savedAt: "2026-08-31T14:00:01.500Z",
    contentPackage: generateContentPackage({ topic: "B 正在前台编辑", pillar: "culture", goal: "save" }),
  }).workspace;
  const switched = await fixture.coordinator.fullCas({
    expectedWorkspaceToken: edited.workspace_token,
    workspace: withB,
  });
  const bBefore = structuredClone(activeDraftRecord(switched.workspace));
  const completed = await persistDraftBoundImageCompletion({
    operation: fixture.operation,
    coordinator: fixture.coordinator,
    contentPackage: finalContent(fixture.draft, "paid-final-recovered"),
    updatedAt: "2026-08-31T14:00:02.000Z",
  });
  assert.equal(completed.action, "COMPLETE");
  assert.equal(completed.disposition, "RECOVERED_SIBLING_COMMITTED");
  assert.equal(completed.recovered_draft.content_package.id, "paid-final-recovered");
  assert.equal(completed.recovered_draft.generation_session.assembled_draft_id, fixture.draft.draft_id);
  assert.equal(completed.recovered_draft.generation_session.image_resume, null);
  assert.equal(completed.workspace.active_draft_id, "record-b");
  assert.deepEqual(activeDraftRecord(completed.workspace), bBefore);
  assert.equal(completed.workspace.drafts.find((draft) => draft.draft_id === "record-a").content_package.selectedTitle, editedA.content_package.selectedTitle);
});

test("invalid final lineage and unavailable Web Locks both stop without mutating the target record", async () => {
  const fixture = await operationFixture();
  const before = fixture.coordinator.snapshot().workspace_token;
  const mismatch = finalContent(fixture.draft);
  mismatch.body = "不是启动时确认的正文";
  await assert.rejects(() => persistDraftBoundImageCompletion({
    operation: fixture.operation,
    coordinator: fixture.coordinator,
    contentPackage: mismatch,
  }), /IMAGE_OPERATION_RESULT_COPY_MISMATCH/);
  assert.equal(fixture.coordinator.snapshot().workspace_token, before);

  const noLockCoordinator = createWorkspaceCoordinator({ storage: fixture.storage, keys: WORKSPACE_KEYS, lockManager: null });
  const stopped = await persistDraftBoundImageProgress({
    operation: fixture.operation,
    coordinator: noLockCoordinator,
    imageResume: { resume_run_id: "images-2026-08-31T14-00-03-000Z-abcdef12", completed_image_steps: 1 },
  });
  assert.equal(stopped.action, "STOP");
  assert.equal(stopped.code, "WORKSPACE_LOCK_UNAVAILABLE");
  assert.equal(noLockCoordinator.snapshot().workspace_token, before);
});
