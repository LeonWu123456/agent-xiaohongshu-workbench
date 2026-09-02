import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainUrl = new URL("../src/main.jsx", import.meta.url);
const mainSource = readFileSync(mainUrl, "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start + startMarker.length, end);
}

function namedFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const parametersOpen = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < source.length; index += 1) {
    if (source[index] === "(") parameterDepth += 1;
    if (source[index] === ")") {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        parametersClose = index;
        break;
      }
    }
  }
  assert.notEqual(parametersClose, -1, `unterminated parameters for ${name}`);
  const open = source.indexOf("{", parametersClose);
  assert.notEqual(open, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

const runtimeSource = between(
  mainSource,
  "// MAIN_AUTHORITY_RUNTIME_START",
  "// MAIN_AUTHORITY_RUNTIME_END",
);
const authRuntimeSource = between(
  mainSource,
  "// MAIN_AUTH_TRANSACTION_START",
  "// MAIN_AUTH_TRANSACTION_END",
);
const identitySource = namedFunctionSource(mainSource, "pageSemanticIdentity");
const authoringLockSource = namedFunctionSource(mainSource, "authoringInputLockReason").replace(/^export\s+/, "");
const imageLaneLockSource = namedFunctionSource(mainSource, "imageLaneLockReason").replace(/^export\s+/, "");
const imageRecoveryModeSource = namedFunctionSource(mainSource, "imageRecoveryClickMode").replace(/^export\s+/, "");
const imageRecoveryResultMessageSource = namedFunctionSource(mainSource, "imageRecoveryResultMessage").replace(/^export\s+/, "");
const workbenchProjectionSource = namedFunctionSource(mainSource, "currentWorkbenchProjection").replace(/^export\s+/, "");
const boundedClipboardSource = namedFunctionSource(mainSource, "boundedClipboardAttempt").replace(/^export\s+/, "");
const runtimeModule = await import(`data:text/javascript;base64,${Buffer.from(`${runtimeSource}\n${authRuntimeSource}\n${identitySource}\n${authoringLockSource}\n${imageLaneLockSource}\n${imageRecoveryModeSource}\n${imageRecoveryResultMessageSource}\n${workbenchProjectionSource}\n${boundedClipboardSource}\nexport { pageSemanticIdentity, authoringInputLockReason, imageLaneLockReason, imageRecoveryClickMode, imageRecoveryResultMessage, currentWorkbenchProjection, boundedClipboardAttempt };`).toString("base64")}`);
const {
  createMainAuthorityRuntime,
  createMainAuthState,
  reduceMainAuthState,
  settleImageBootstrapPersistence,
  createMainTransitionLock,
  workspaceTransitionReceiptDisposition,
  postCasWorkspaceSettlementPlan,
  pageSemanticIdentity,
  authoringInputLockReason,
  imageLaneLockReason,
  imageRecoveryClickMode,
  imageRecoveryResultMessage,
  currentWorkbenchProjection,
  boundedClipboardAttempt,
} = runtimeModule;

function makeUiState() {
  return {
    activeDraftId: "draft-B",
    textDraft: "B text",
    content: "B content",
    candidates: ["B candidate"],
    fileReaderValue: "B file",
    editorValue: "B editor",
    generationState: "B idle",
    candidateState: "B idle",
    failureStorage: "B failure",
    preparedExport: "B prepared",
    toast: "B toast",
    clipboardCompletion: "B clipboard",
    zipFailureDiagnostic: "B diagnostic",
  };
}

test("same-draft semantic edit invalidates text/autosave work before the 400ms save", () => {
  const target = { draftId: "draft-A", pageId: "page-A-1" };
  const authority = createMainAuthorityRuntime(() => target);
  const textOperation = authority.capture("text-generation");
  const preEditAutosave = authority.capture("autosave");
  const state = { topic: "old topic", textDraft: null, persisted: "old" };

  // The edit is intentionally not persisted. The synchronous in-memory epoch is
  // the only thing allowed to make already-running work stale during this gap.
  state.topic = "new topic";
  authority.markSemanticMutation();

  const lateText = authority.commit(textOperation, () => {
    state.textDraft = "late old-topic result";
  });
  const lateAutosave = authority.commit(preEditAutosave, () => {
    state.persisted = "old-topic envelope";
  });

  assert.deepEqual(lateText, { applied: false, code: "STALE_MAIN_OPERATION" });
  assert.deepEqual(lateAutosave, { applied: false, code: "STALE_MAIN_OPERATION" });
  assert.deepEqual(state, { topic: "new topic", textDraft: null, persisted: "old" });

  const postEditAutosave = authority.capture("autosave");
  assert.equal(authority.commit(postEditAutosave, () => { state.persisted = "new-topic envelope"; }).applied, true);
  assert.equal(state.persisted, "new-topic envelope");
});

test("one auth transaction reducer rejects old health, business, catch and finally writes", () => {
  let state = createMainAuthState("CHECKING");
  const preLoginGeneration = state.generation;
  state = reduceMainAuthState(state, { type: "BEGIN_LOGIN" });
  const loginGeneration = state.generation;
  assert.equal(state.phase, "LOGIN_PENDING");

  const oldEvents = [
    { type: "BACKGROUND_CONFIG", generation: preLoginGeneration, providerMeta: { authenticated: false }, providerHealth: "OFFLINE" },
    { type: "BUSINESS_SUCCESS", generation: preLoginGeneration },
    { type: "BUSINESS_AUTH_REQUIRED", generation: preLoginGeneration, message: "old 401" },
    { type: "LOGIN_ERROR", generation: preLoginGeneration, message: "old finally" },
  ];
  for (const event of oldEvents) assert.equal(reduceMainAuthState(state, event), state);

  state = reduceMainAuthState(state, { type: "BEGIN_RECONCILE", generation: loginGeneration });
  assert.equal(state.phase, "CONFIG_RECONCILING");
  const intervalHealth = reduceMainAuthState(state, {
    type: "BACKGROUND_CONFIG",
    generation: loginGeneration,
    providerMeta: { authenticated: false, access_required: true, credential_mode: "SERVER_MANAGED" },
    providerHealth: "OFFLINE",
  });
  assert.equal(intervalHealth, state, "new interval health must also be a zero-write while reconciling");

  state = reduceMainAuthState(state, {
    type: "CONFIG_COMMIT",
    generation: loginGeneration,
    providerMeta: { authenticated: true, access_required: true, credential_mode: "SERVER_MANAGED" },
    providerHealth: "UNVERIFIED",
  });
  assert.equal(state.phase, "AUTHENTICATED");
  assert.equal(state.accessRequired, false);
  assert.equal(state.accessBusy, false);

  const staleAfterCommit = reduceMainAuthState(state, { type: "LOGIN_ERROR", generation: preLoginGeneration, message: "late old login" });
  assert.equal(staleAfterCommit, state);
});

test("authenticated background config cannot erase a verified business success", () => {
  let state = createMainAuthState("UNVERIFIED");
  state = reduceMainAuthState(state, { type: "BEGIN_LOGIN" });
  const generation = state.generation;
  state = reduceMainAuthState(state, { type: "BEGIN_RECONCILE", generation });
  state = reduceMainAuthState(state, {
    type: "CONFIG_COMMIT",
    generation,
    providerMeta: { authenticated: true, access_required: true, credential_mode: "SERVER_MANAGED" },
    providerHealth: "UNVERIFIED",
  });
  state = reduceMainAuthState(state, { type: "BUSINESS_SUCCESS", generation });
  assert.equal(state.providerHealth, "ONLINE");

  state = reduceMainAuthState(state, {
    type: "BACKGROUND_CONFIG",
    generation,
    providerMeta: { authenticated: true, access_required: true, credential_mode: "SERVER_MANAGED" },
    providerHealth: "UNVERIFIED",
  });
  assert.equal(state.providerHealth, "ONLINE");
  assert.equal(state.phase, "AUTHENTICATED");

  state = reduceMainAuthState(state, {
    type: "BACKGROUND_CONFIG",
    generation,
    providerMeta: { authenticated: false, access_required: true, credential_mode: "SERVER_MANAGED" },
    providerHealth: "UNVERIFIED",
  });
  assert.equal(state.providerHealth, "UNVERIFIED");
  assert.equal(state.phase, "ACCESS_SESSION_REQUIRED");
});

test("A to B rejects every late main side effect, including errors, toast and prepared ZIP", async (t) => {
  const scenarios = [
    ["text success", false, { textDraft: "A late text", generationState: "IDLE", toast: "A text done" }],
    ["text error", false, { generationState: "FAILED", failureStorage: "A text error", toast: "A text failed" }],
    ["candidate success", true, { candidates: ["A late candidate"], candidateState: "READY", toast: "A candidates ready" }],
    ["candidate error", true, { candidates: [], candidateState: "FAILED", toast: "A candidates failed" }],
    ["FileReader success", true, { fileReaderValue: "A data URL", content: "A image mutation", toast: "A image ready" }],
    ["FileReader error", true, { fileReaderValue: "A reader error", toast: "A image failed" }],
    ["HTML editor callback", true, { editorValue: "A html state", content: "A html mutation" }],
    ["Fabric editor callback", true, { editorValue: "A fabric state", content: "A fabric mutation" }],
    ["copy completion", false, { clipboardCompletion: "A copy complete", toast: "A copied" }],
    ["copy error", false, { clipboardCompletion: "A copy error", toast: "A copy failed" }],
    ["ZIP prepared", false, { preparedExport: "A ZIP", generationState: "READY", toast: "A ZIP ready" }],
    ["ZIP render error", false, { preparedExport: null, generationState: "FAILED", zipFailureDiagnostic: "A ZIP error", toast: "A ZIP failed" }],
  ];

  for (const [label, pageScoped, latePatch] of scenarios) {
    await t.test(label, () => {
      let target = { draftId: "draft-A", pageId: "shared-page-index-but-A" };
      const authority = createMainAuthorityRuntime(() => target);
      const operation = authority.capture(label, { pageScoped });
      const state = makeUiState();
      const before = structuredClone(state);

      // B deliberately uses the same visible page index. Its stable page identity
      // is different, so pageIndex alone can never authorize the callback.
      target = { draftId: "draft-B", pageId: "shared-page-index-but-B" };
      const result = authority.commit(operation, () => Object.assign(state, latePatch));

      assert.deepEqual(result, { applied: false, code: "STALE_MAIN_OPERATION" });
      assert.deepEqual(state, before, `${label} leaked A bytes into B`);
    });
  }
});

test("page identity is deterministic and distinguishes different pages at the same index", () => {
  const pageA = { id: "stable-page-A", page_role: "hook", layout: "hero", title: "same", body: "same", info_panels: [] };
  const pageB = { ...pageA, id: "stable-page-B" };
  assert.equal(pageSemanticIdentity(pageA, 0), pageSemanticIdentity(structuredClone(pageA), 0));
  assert.notEqual(pageSemanticIdentity(pageA, 0), pageSemanticIdentity(pageB, 0));
});

test("same draft and same pageIndex still reject an old page or envelope identity", () => {
  let target = { draftId: "draft-A", pageId: "stable-page-A", workspaceToken: "envelope-E0" };
  const authority = createMainAuthorityRuntime(() => target);
  const pageOperation = authority.capture("editor", { pageScoped: true });
  const envelopeOperation = authority.capture("workspace-import", { envelopeScoped: true });
  const state = { value: "current" };

  target = { ...target, pageId: "stable-page-B" };
  assert.equal(authority.commit(pageOperation, () => { state.value = "old page"; }).applied, false);
  assert.equal(state.value, "current");

  target = { ...target, pageId: "stable-page-A", workspaceToken: "envelope-E1" };
  assert.equal(authority.commit(envelopeOperation, () => { state.value = "old envelope"; }).applied, false);
  assert.equal(state.value, "current");
});

test("App uses the tested runtime in real mutation paths; a parked helper is not wiring", () => {
  const appSource = mainSource.replace(runtimeSource, "");
  assert.match(appSource, /createMainAuthorityRuntime\s*\(/, "App must instantiate the tested runtime outside its declaration");

  const setContentSource = between(appSource, "const setContent =", "const resetContent =");
  const mutationIndex = setContentSource.indexOf("markSemanticMutation(");
  const reactSetterIndex = setContentSource.indexOf("setContentHistory(");
  assert.ok(mutationIndex >= 0 && mutationIndex < reactSetterIndex, "setContent must advance the epoch synchronously before scheduling React state");

  const adoptionSource = namedFunctionSource(appSource, "persistAndAdoptWorkspace");
  assert.match(adoptionSource, /AuthorityTargetRef\.current\s*=/i, "draft adoption must switch the runtime target synchronously, not wait for a render");

  const textEditSource = namedFunctionSource(appSource, "editTextDraft");
  assert.match(textEditSource, /markSemanticMutation\s*\(/, "editing confirmed/generated text must synchronously invalidate old operations");

  const requiredPaths = [
    ["generateTextNode", false, 2],
    ["generateImageCandidates", true, 2],
    ["replaceInfoPanelImage", true, 1],
    ["addActionReferences", true, 1],
    ["replaceImage", true, 1],
    ["replaceBackgroundImage", true, 2],
    ["copyPublicationCopy", false, 2],
    ["downloadZip", false, 3],
  ];
  for (const [name, pageScoped, minimumCommits] of requiredPaths) {
    const source = namedFunctionSource(appSource, name);
    assert.match(source, /\.capture\s*\(/, `${name} must capture the immutable DraftRecord/page/epoch target before async work`);
    if (pageScoped) assert.match(source, /pageScoped\s*:\s*true/, `${name} must capture stable page identity, not pageIndex`);
    assert.ok(count(source, /\.commit\s*\(/g) >= minimumCommits, `${name} must guard success and error/prepared side effects (expected at least ${minimumCommits} commits)`);
  }

  const editorSource = between(appSource, "<HtmlPageEditor", "/>}\n            </div>");
  const htmlEditorSource = editorSource.slice(0, editorSource.indexOf("<MaturePageEditor"));
  const matureEditorSource = editorSource.slice(editorSource.indexOf("<MaturePageEditor"));
  for (const [label, source] of [["HTML", htmlEditorSource], ["Fabric", matureEditorSource]]) {
    assert.match(source, /key=\{[^\n]*active_draft_id[^\n]*pageSemanticIdentity/i, `${label} editor key must include DraftRecord plus stable page identity`);
    assert.match(source, /\.commit\s*\(/, `${label} editor callback must pass through the tested authority runtime`);
  }

  assert.ok(count(appSource, /\.capture\s*\(/g) >= requiredPaths.length, "main paths must call runtime.capture, not a shadow coordinator");
  assert.ok(count(appSource, /\.commit\s*\(/g) >= 14, "main success/error/toast/prepared paths must call runtime.commit");
});

test("editing during ZIP preparation clears the stale generating state", () => {
  assert.match(
    mainSource,
    /setExportState\s*\(\s*\(current\)\s*=>\s*\["GENERATING",\s*"READY",\s*"COMPLETE"\]\.includes\(current\)\s*\?\s*"IDLE"\s*:\s*current\s*\)/,
    "content or publication-authority changes must not leave the download action stuck in GENERATING",
  );
});

test("App has one page-local auth writer and does not persist auth generations or Cookie pointers", () => {
  const appSource = mainSource.replace(authRuntimeSource, "");
  assert.match(appSource, /const \[authState,\s*setAuthState\]\s*=\s*useState/);
  assert.match(appSource, /reduceMainAuthState\s*\(/);
  for (const forbidden of ["setProviderHealth", "setProviderMeta", "setAccessRequired", "setAccessBusy", "setAccessError"]) {
    assert.equal(appSource.includes(forbidden), false, `${forbidden} would create a second auth writer`);
  }
  const persistedAuthTerms = /localStorage\.(?:setItem|getItem)\([^\n]*(?:authGeneration|cookieName|cookieFamily|sessionPointer|clientId)/i;
  assert.equal(persistedAuthTerms.test(appSource), false);
});

test("pending image authority freezes only the asset lane while text layout save and export stay available", () => {
  assert.equal(authoringInputLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: null }), null);
  assert.equal(authoringInputLockReason({ workspaceReady: false, workspaceReadOnly: false, pendingImageOperation: null }), "WORKSPACE_MEDIA_READ_ONLY");
  assert.equal(authoringInputLockReason({ workspaceReady: true, workspaceReadOnly: true, pendingImageOperation: null }), "WORKSPACE_MEDIA_READ_ONLY");
  assert.equal(authoringInputLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: { operation_nonce: "a".repeat(64) } }), null);
  assert.equal(imageLaneLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: { operation_nonce: "a".repeat(64) } }), "PENDING_IMAGE_OPERATION_INPUT_FROZEN");
  assert.equal(imageLaneLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: null, activeDraftId: "draft-A", imageOperationDraftId: "draft-A" }), "PENDING_IMAGE_OPERATION_INPUT_FROZEN");
  assert.equal(imageLaneLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: null, activeDraftId: "draft-B", imageOperationDraftId: "draft-A" }), null);

  const state = { topic: "editable", title: "editable", pageCount: 3, productionMode: "smart", refs: ["ref-a"] };
  const reason = imageLaneLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: { operation_nonce: "a".repeat(64) } });
  Object.assign(state, { topic: "mutated", title: "mutated" });
  if (!reason) Object.assign(state, { pageCount: 8, productionMode: "free", refs: [] });
  assert.deepEqual(state, { topic: "mutated", title: "mutated", pageCount: 3, productionMode: "smart", refs: ["ref-a"] });

  const textHandlers = [
    "setPromptFieldValue",
    "generateTextNode",
    "editTextDraft",
    "chooseDraftTitle",
    "changeContentRoute",
    "confirmTextDraft",
  ];
  for (const name of textHandlers) {
    assert.match(namedFunctionSource(mainSource, name), /authoringInputIsLocked\s*\(\s*\)/, `${name} must remain guarded only by workspace writability`);
  }
  const assetHandlers = [
    "changeProductionModeChoice",
    "changeImageCountModeChoice",
    "changeCustomImageCountValue",
    "changeActionReferenceNote",
    "addActionReferences",
    "removeActionReference",
  ];
  for (const name of assetHandlers) {
    assert.match(namedFunctionSource(mainSource, name), /imageLaneIsLocked\s*\(\s*\)/, `${name} must fail closed before changing asset input`);
  }
  assert.doesNotMatch(namedFunctionSource(mainSource, "authoringInputIsLocked"), /imageOperationDraftId|pending_image_operation/);
  assert.doesNotMatch(namedFunctionSource(mainSource, "workspaceMutationIsLocked"), /imageOperationDraftId|pending_image_operation/);
  assert.match(namedFunctionSource(mainSource, "imageLaneIsLocked"), /imageOperationDraftId:\s*draftMutationLockRef\.current\?\.draft_id/);
  assert.match(mainSource, /const textLaneLocked = authoringInputLocked \|\| generationState === "TEXT_GENERATING" \|\| generationState === "IMAGE_GENERATING";/);
  assert.match(mainSource, /const draftEditingLocked = workspaceReadOnly \|\| workspaceTransitioning \|\| generationState === "IMAGE_GENERATING";/);
  assert.match(namedFunctionSource(mainSource, "draftMutationIsLocked"), /activeImageOperationRef\.current \|\| draftMutationLockRef\.current/);
  assert.match(mainSource, /const setContent = useCallback\(\(updater, options = \{\}\) => \{[\s\S]*activeImageOperationRef\.current \|\| draftMutationLockRef\.current/);
  assert.match(mainSource, /const undo = useCallback\(\(\) => \{ if \([^;]*activeImageOperationRef\.current \|\| draftMutationLockRef\.current\) return;/);
  assert.match(mainSource, /const redo = useCallback\(\(\) => \{ if \([^;]*activeImageOperationRef\.current \|\| draftMutationLockRef\.current\) return;/);
  assert.doesNotMatch(mainSource, /liveDraft\?\.pending_image_operation|latestDraft\?\.pending_image_operation/, "pending assets must not suppress semantic autosave");
  assert.match(namedFunctionSource(mainSource, "saveDraft"), /^function saveDraft\(\) \{\s*if \(draftMutationIsLocked\(\)\) return;/);
  assert.match(namedFunctionSource(mainSource, "copyPublicationCopy"), /^function copyPublicationCopy\(\) \{\s*if \(!mediaWorkspaceIsUsable\(\)\) return;/);
  const downloadSource = namedFunctionSource(mainSource, "downloadZip");
  assert.match(downloadSource, /^function downloadZip\(\) \{\s*if \(!mediaWorkspaceIsUsable\(\) \|\| workspaceTransitionLock\.isLocked\(\)\) return;/);
  assert.match(downloadSource, /materializeForWorkspace\(\{ content_package: contentSnapshot \}\)/);
  assert.match(downloadSource, /mediaStore\.exportMediaAssets\(mediaRefs\)/);
  assert.match(downloadSource, /publicationAuthority:\s*initialGate\.code/);
  assert.ok(downloadSource.indexOf("materializeForWorkspace") < downloadSource.indexOf("buildPublishZip"), "export must canonicalize media before ZIP creation");
  assert.match(mainSource, /当前 .* 页成品与已确认文字一致，可以直接编辑、保存、复制和导出；另一条配图恢复只锁图片参数与新图片生成/);

  const creatorSource = namedFunctionSource(mainSource, "renderCreatorWorkflow");
  for (const handler of ["changeContentRoute", "confirmTextDraft", "changeProductionModeChoice", "changeImageCountModeChoice", "changeCustomImageCountValue", "changeActionReferenceNote"]) {
    assert.match(creatorSource, new RegExp(`(?:${handler}\\s*\\(|(?:onClick|onChange)=\\{${handler}\\})`), `${handler} must be the live JSX writer, not a parked guard`);
  }
  assert.ok(count(creatorSource, /disabled=\{textLaneLocked\}/g) >= 10, "text controls must expose the workspace and active-generation lock");
  assert.ok(count(creatorSource, /disabled=\{imageLaneLocked \|\| isGenerating/g) >= 7, "asset controls must expose the pending-image lane lock");

  const imageSource = namedFunctionSource(mainSource, "generateImageNode");
  assert.match(imageSource, /^function generateImageNode\([^)]*\) \{\s*if \(!mediaWorkspaceIsUsable\(\)\) return;/);
  assert.match(imageSource, /mode:\s*"DISCOVER"|imageDiscoveryRequest\s*\(/);
  assert.match(imageSource, /rebuildPendingImageStartV3\s*\(/, "a cached BOOTSTRAP must rebuild the same START, not create a new operation");
  assert.match(imageSource, /settleImageBootstrapPersistence\s*\(/);
  assert.match(imageSource, /IMAGE_BOOTSTRAP_STALE_PENDING_SAVED/);
  const bootstrapConflictSource = between(imageSource, 'if (["WORKSPACE_DRAFT_CAS_CONFLICT", "WORKSPACE_ACTIVE_DRAFT_CONFLICT"].includes(snapshotReceipt?.code) && snapshotReceipt.workspace) {', '} else {\n            mainAuthority.commit');
  assert.match(bootstrapConflictSource, /hydrateWorkspaceForView\(snapshotReceipt\.workspace\)/, "cross-tab image conflicts must hydrate the authoritative active draft before showing it");
  assert.match(bootstrapConflictSource, /applyRecord: Boolean\(latestActive\)/, "an external active-draft switch cannot leave A's UI attached to B's authority");
  const staleBootstrapSource = between(imageSource, 'if (bootstrapSettlement.code === "IMAGE_BOOTSTRAP_STALE_PENDING_SAVED" && latest?.workspace) {', '} else {\n            handleWorkspaceConflict');
  assert.doesNotMatch(staleBootstrapSource, /applyRecord:\s*true/, "a late bootstrap receipt cannot overwrite same-draft input typed while it was awaiting persistence");
  assert.match(staleBootstrapSource, /setAutosaveRetryRevision\(\(value\) => value \+ 1\)/, "the preserved dirty input must be rescheduled onto the saved pending snapshot");
  assert.match(imageSource, /setGenerationState\s*\(\s*\(current\)\s*=>\s*current === "IMAGE_GENERATING" \? "IDLE" : current\s*\)/, "operation-id finally must settle global busy even after A to B cutover");
  assert.match(imageSource, /const imageIntent = recoveryCheck \? "RECOVERY_CHECK" : "START_OR_STEP";/, "the current click must freeze its own cost intent before BOOTSTRAP changes persisted state");
  assert.match(imageSource, /setActiveImageIntent\(imageIntent\)/);
  assert.match(imageSource, /finally\s*\{[\s\S]*setActiveImageIntent\(null\)/, "the operation intent must settle with the exact image operation");
  const textSource = namedFunctionSource(mainSource, "generateTextNode");
  assert.match(textSource, /generationState === "IMAGE_GENERATING" \|\| activeImageOperationRef\.current \|\| draftMutationLockRef\.current/, "programmatic and same-frame clicks must not start text while image authority is held");
  assert.match(creatorSource, /activeImageIntent === "RECOVERY_CHECK" \? "正在检查恢复状态（不会生成图片）"/);
  assert.match(creatorSource, /记录缺失时会调用文字模型重建配图计划/);
  assert.match(creatorSource, /"正在生成配图（可能产生图片调用）"/, "a fresh START or paid STEP must never be presented as zero-call discovery");
  assert.match(namedFunctionSource(mainSource, "generateImageCandidates"), /^function generateImageCandidates\([^)]*\) \{\s*if \(!mediaWorkspaceIsUsable\(\)\) return;/);
});

test("every persisted pending recovery needs a truthful recovery check before a separate paid continuation", () => {
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "UNKNOWN" } }), "RECOVERY_CHECK");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "PARTIAL" } }), "RECOVERY_CHECK");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "READY" } }), "RECOVERY_CHECK");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "PARTIAL" }, requestedPaidContinuation: true }), "CONTINUE_ALLOWED");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "UNKNOWN" }, requestedPaidContinuation: true }), "RECOVERY_CHECK");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: null }), "CONTINUE_ALLOWED");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "READY" }, requestedDiscoveryOnly: true }), "RECOVERY_CHECK");
  const imageSource = namedFunctionSource(mainSource, "generateImageNode");
  assert.match(imageSource, /const recoveryCheck = imageRecoveryClickMode\s*\(/);
  assert.doesNotMatch(imageSource, /operationWasStaleBeforePersistence/, "staleness sampled before media fetch cannot authorize a later write");
  assert.match(imageSource, /forceRecovery:\s*!mainAuthority\.isCurrent\(mainOperation\)/, "completion must recheck semantic authority immediately at commit");
  assert.match(imageSource, /const operationWasStaleAtCommit = !mainAuthority\.isCurrent\(mainOperation\);[\s\S]*?forceRecovery:\s*operationWasStaleAtCommit/, "progress must bind forceRecovery after deferred media fetch");
  assert.equal((imageSource.match(/forceRecoveryNow:\s*\(\) => !mainAuthority\.isCurrent\(mainOperation\)/g) || []).length, 2, "progress and completion must both recheck authority inside the coordinator's exclusive commit lock");
  assert.match(imageSource, /if \(recoveryCheck\)[\s\S]*return \{ action: "STOP", checkpointPersisted: true,[\s\S]*nextImageStepRequest/);
  assert.match(imageSource, /checkpointPersisted: progressReceipt\.checkpointPersisted === true/);
  assert.match(imageSource, /checkpointPersisted: false, code: "IMAGE_OPERATION_CONTEXT_MISSING"/);
  assert.match(imageSource, /error\?\.intentionalStop === true && error\?\.checkpointPersisted === true/);
  assert.match(imageSource, /imageRecoveryResultMessage\s*\(/);
  assert.match(imageRecoveryResultMessage({ requestModes: ["DISCOVER"], upstreamCalls: 0 }), /只读取了已有账本与缓存，没有调用模型/);
  const rebuiltMessage = imageRecoveryResultMessage({ requestModes: ["DISCOVER", "START"], upstreamCalls: 1 });
  assert.match(rebuiltMessage, /已调用文字模型重建配图计划/);
  assert.match(rebuiltMessage, /没有调用图片模型/);
  assert.doesNotMatch(rebuiltMessage, /只读取/);
  assert.match(imageSource, /const observedRequestModes = \[initialRequest\.mode\]/);
  assert.match(imageSource, /upstream_calls: Number\(response\.upstream_calls \?\? response\.progress\?\.upstream_calls \?\? 0\)/);
  assert.match(imageSource, /upstream_calls: Number\(providerResult\.upstream_calls \?\? providerResult\.progress\?\.upstream_calls \?\? 0\)/, "direct UNKNOWN and ERROR returns must still expose the runtime readback");
  assert.ok(imageSource.indexOf("let providerResult = await provider.generateImages") < imageSource.indexOf("response_status: providerResult.status"), "the final provider return must be recorded before error handling");
  assert.ok(imageSource.indexOf("if (recoveryCheck)") < imageSource.indexOf("observedRequestModes.push(nextRequest.mode)"), "a recovery-check response must stop before STEP enters the observed request sequence");
  assert.match(mainSource, /确认付费：继续图片步骤/);
  assert.doesNotMatch(namedFunctionSource(mainSource, "downloadZip"), /draftMutationIsLocked\s*\(/);
  assert.doesNotMatch(namedFunctionSource(mainSource, "downloadPreparedExport"), /draftMutationIsLocked\s*\(/);
});

test("one current-workbench projection keeps the compose header and asset library on the same draft", () => {
  const input = {
    contentTitle: "忙碌之后，先别硬扛",
    confirmedTitle: "日常三步处暑调养做法",
    textConfirmed: true,
    hasConfirmedContent: false,
    visiblePageCount: 2,
    currentInLibrary: true,
    topic: "处暑调养原文",
  };
  const before = structuredClone(input);
  assert.deepEqual(currentWorkbenchProjection(input), {
    title: "日常三步处暑调养做法",
    pageCount: 0,
    headerStatus: "文字已确认 · 等待配图",
    libraryStatus: "文字已确认 · 等待配图",
    saved: false,
  });
  assert.deepEqual(input, before, "the library projection must not mutate DraftRecord or authoring state");

  assert.deepEqual(currentWorkbenchProjection({
    confirmedTitle: "雨天只整理书桌一角",
    textConfirmed: false,
    hasConfirmedContent: false,
    topic: "雨天只整理书桌这一小块",
  }), {
    title: "雨天只整理书桌一角",
    pageCount: 0,
    headerStatus: "文字已生成 · 等待确认",
    libraryStatus: "文字已生成 · 等待确认",
    saved: false,
  }, "an edited text draft must not be misreported as an unnamed draft waiting for generation");

  assert.deepEqual(currentWorkbenchProjection({ topic: "一段新原文" }), {
    title: "未命名新稿",
    pageCount: 0,
    headerStatus: "等待生成文字",
    libraryStatus: "等待生成文字",
    saved: false,
  });
  assert.deepEqual(currentWorkbenchProjection({ contentTitle: "真实两页稿", hasConfirmedContent: true, visiblePageCount: 2, generatedImageCount: 2, currentInLibrary: true }), {
    title: "真实两页稿",
    pageCount: 2,
    headerStatus: "2 页 · 2 张图",
    libraryStatus: "已在资产库，可继续补现实反馈",
    saved: true,
  });
  assert.equal((mainSource.match(/const workbenchProjection = currentWorkbenchProjection\s*\(/g) || []).length, 1, "one projection must derive the current draft for every visible consumer");
  assert.match(mainSource, /workbenchProjection\.pageCount/);
  assert.ok((mainSource.match(/workbenchProjection\.title/g) || []).length >= 2, "the compose header and library must share one title projection");
  assert.match(mainSource, /workbenchProjection\.headerStatus/);
  assert.match(mainSource, /workbenchProjection\.libraryStatus/);
  assert.doesNotMatch(mainSource, /<div className="file-title"><strong>\{isDraftInputOnly/);
});

test("a hanging Clipboard promise reaches the fallback path within a bounded deadline", async () => {
  let expire;
  let clearedHandle = null;
  const pending = boundedClipboardAttempt(() => new Promise(() => {}), {
    timeoutMs: 25,
    schedule(callback, delay) {
      assert.equal(delay, 25);
      expire = callback;
      return "clipboard-timeout";
    },
    cancel(handle) { clearedHandle = handle; },
  });
  assert.equal(typeof expire, "function");
  expire();
  await assert.rejects(pending, /CLIPBOARD_WRITE_TIMEOUT/);
  assert.equal(clearedHandle, "clipboard-timeout");

  let successTimerCleared = false;
  assert.equal(await boundedClipboardAttempt(() => Promise.resolve(), {
    schedule() { return "success-timeout"; },
    cancel(handle) { successTimerCleared = handle === "success-timeout"; },
  }), true);
  assert.equal(successTimerCleared, true);

  const copySource = namedFunctionSource(mainSource, "copyTextToClipboard");
  assert.match(copySource, /boundedClipboardAttempt\(\(\) => navigator\.clipboard\.writeText\(text\)\)/);
  assert.ok(copySource.indexOf("boundedClipboardAttempt") < copySource.indexOf('document.createElement("textarea")'), "deadline failure must enter the existing selection fallback");
});

test("a visible-canvas lineage split has one explicit zero-provider repair that preserves pages and pending", () => {
  const repairSource = namedFunctionSource(mainSource, "repairVisibleCanvasLineage");
  assert.doesNotMatch(repairSource, /draftMutationIsLocked\s*\(/, "the repair is the bounded exception to the pending authoring lock");
  assert.match(repairSource, /sourceRecord\.content_package/);
  assert.match(repairSource, /draftId: sourceLineageId/);
  assert.match(repairSource, /JSON\.stringify\(nextRecord\.content_package\.pages\) !== frozenPages/);
  assert.match(repairSource, /JSON\.stringify\(nextRecord\.pending_image_operation\) !== frozenPending/);
  assert.match(repairSource, /REPAIR_VISIBLE_CANVAS_LINEAGE/);
  assert.doesNotMatch(repairSource, /generateImages|generateText|provider\./);
  assert.match(mainSource, /恢复当前两页对应文案（0 次图片调用）/);
  assert.match(mainSource, /data-last-image-request-modes=\{imageOperationReadback\?\.request_modes\?\.join\(","\) \|\| ""\}/);
  assert.match(mainSource, /data-last-image-response-status=\{imageOperationReadback\?\.response_status \|\| ""\}/);
  assert.match(mainSource, /data-last-image-upstream-calls=\{imageOperationReadback\?\.upstream_calls \?\? ""\}/);
});

test("workspace and draft mutations bind one pre-await base and converge after races", () => {
  const persist = namedFunctionSource(mainSource, "persistAndAdoptWorkspace");
  assert.match(persist, /EXPECTED_WORKSPACE_V3_TOKEN_REQUIRED/);
  assert.ok(persist.indexOf("hydrateWorkspaceForView(nextWorkspace)") < persist.indexOf("workspaceCoordinator.fullCas"), "candidate media must hydrate before the authoritative CAS");
  assert.ok(persist.indexOf("workspaceTransitionLock.acquire") < persist.indexOf("hydrateWorkspaceForView(nextWorkspace)"), "the volatile transition lock must cover candidate hydration and CAS");
  assert.match(persist, /finally\s*\{\s*if \(workspaceTransitionLock\.release\(operation\)\) setWorkspaceTransitioning\(false\)/);
  assert.match(persist, /STALE_NOOP_PRESERVE_LOCAL/);
  assert.match(persist, /candidateView\?\.release\?\.\(\);\s*candidateView = null;\s*return false;/, "a stale NOOP must preserve local dirty input and perform no authoritative apply");
  assert.match(persist, /const latest = workspaceCoordinator\.snapshot\(\)/, "a stale committed candidate must read final authority after its receipt");
  assert.match(persist, /LATEST_CHANGED_APPLY_AND_BLOCK/);

  for (const name of ["createAuthoringRecord", "activateWorkspaceDraft", "openCreator", "saveProfile"]) {
    const source = namedFunctionSource(mainSource, name);
    const firstAwait = source.indexOf("await ");
    for (const binding of ["mainAuthority.capture", "baseWorkspace", "expectedWorkspaceToken"]) {
      assert.ok(source.indexOf(binding) >= 0 && source.indexOf(binding) < firstAwait, `${name} must freeze ${binding} before its first await`);
    }
    assert.match(source.slice(firstAwait), /mainAuthority\.isCurrent\s*\(/, `${name} must revalidate after asynchronous materialization`);
  }

  const saveDraftSource = namedFunctionSource(mainSource, "saveDraft");
  assert.ok(saveDraftSource.indexOf("mainAuthority.capture") < saveDraftSource.indexOf("await "));
  assert.ok(saveDraftSource.indexOf("baseWorkspace") < saveDraftSource.indexOf("await "));
  assert.match(saveDraftSource, /mergeDraftCas\s*\(/);
  assert.doesNotMatch(saveDraftSource, /requireActiveDraftId:\s*draftId/, "saving A must remain possible when another tab activates B");
  assert.match(saveDraftSource, /authoringSessionForDraftSnapshotV3\s*\(/, "manual save must preserve the durable resume cursor from its own DraftRecord");
  assert.match(saveDraftSource, /adoptCrossTabActiveAfterDraftWrite\s*\(/, "after saving A, the UI must atomically read back externally selected B");
  assert.match(saveDraftSource, /if \(!committed\.applied\)/);
  assert.match(saveDraftSource, /reconcileStaleDraftWrite\(receipt, \{ dirtyDraftId: draftId, issueLabel: "保存" \}\)/);
  assert.match(saveDraftSource, /saved_at:\s*latestContent\.saved_at \|\| now/, "manual save intent must survive a same-active dirty retry");

  const saveFeedbackSource = namedFunctionSource(mainSource, "saveRealityFeedback");
  assert.match(saveFeedbackSource, /mergeDraftCas\s*\(/);
  assert.match(saveFeedbackSource, /if \(!committed\.applied\)/);
  assert.match(saveFeedbackSource, /reconcileStaleDraftWrite\s*\(/);

  const autosaveSource = between(mainSource, "const timer = window.setTimeout(async () => {", "}, 400);");
  assert.doesNotMatch(autosaveSource, /draftMutationLockRef\.current/, "semantic autosave must preserve rather than wait behind the asset lane");
  assert.match(autosaveSource, /authoringSessionForDraftSnapshotV3\s*\(/, "autosave must derive resume authority from its own DraftRecord snapshot");
  assert.doesNotMatch(autosaveSource, /requireActiveDraftId:\s*draftId/, "autosave must save its captured draft even if another tab switches the active draft");
  assert.match(autosaveSource, /adoptCrossTabActiveAfterDraftWrite\s*\(/, "a successful background save must then read back the actual active draft");
  assert.match(autosaveSource, /if \(!draftAutosaveRequiredV3\(\{ baseDraft: baseRecord, candidateDraft: replacementDraft \}\)\) return;/, "unchanged autosave must not advance the token behind a running image checkpoint");
  assert.ok(count(autosaveSource, /workspaceTransitionLock\.isLocked\(\)/g) >= 2, "autosave must not cross an envelope transition before or after materialization");
  assert.match(autosaveSource, /reconcileStaleDraftWrite\(receipt, \{ dirtyDraftId: draftId, issueLabel: "自动保存" \}\)/, "post-CAS stale autosave must use the shared final-snapshot reconciler");
  assert.doesNotMatch(between(autosaveSource, "if (!receipt.ok) {", "return;\n        }"), /\? handleWorkspaceConflict\(receipt/, "a same-draft CAS race cannot globally disable the workbench");
  const staleWriteSource = namedFunctionSource(mainSource, "reconcileStaleDraftWrite");
  assert.match(staleWriteSource, /workspaceCoordinator\.snapshot\(\)/);
  assert.match(staleWriteSource, /plan === "RECEIPT_STILL_CURRENT" \|\| plan === "LATEST_SAME_ACTIVE_PRESERVE_LOCAL"/);
  assert.match(staleWriteSource, /LATEST_SAME_ACTIVE_PRESERVE_LOCAL/);
  assert.match(staleWriteSource, /adoptWorkspaceState\(latest\.workspace\);\s*setAutosaveRetryRevision/, "same-active stale writes must advance only the envelope token, preserve dirty UI, then retry");
  assert.match(staleWriteSource, /LATEST_CHANGED_APPLY_AND_BLOCK/);
  assert.match(namedFunctionSource(mainSource, "cancelImageCrop"), /draftMutationIsLocked\s*\(/);

  const bootSource = between(mainSource, "const boot = async () => {", "    };\n    boot().catch");
  assert.match(bootSource, /if \(!receipt\.workspace\)/, "ok:false with a valid v3 workspace must still be adopted");
  assert.match(bootSource, /applyRecord:\s*true/);
});

test("deferred image bootstrap exposes the volatile lock and a stale committed pending never starts Provider", async () => {
  let target = { draftId: "draft-A", pageId: null, workspaceToken: "token-A" };
  const authority = createMainAuthorityRuntime(() => target);
  const operation = authority.capture("image-bootstrap", { envelopeScoped: true });
  const operationNonce = "a".repeat(64);
  let resolvePersist;
  const persistDeferred = new Promise((resolve) => { resolvePersist = resolve; });
  const pending = { operation_nonce: operationNonce };
  const workspace = {
    active_draft_id: "draft-A",
    drafts: [{ draft_id: "draft-A", pending_image_operation: pending }],
  };
  const settlementPromise = settleImageBootstrapPersistence({
    persist: () => persistDeferred,
    isCurrent: () => authority.isCurrent(operation),
    readLatest: () => ({ ok: true, workspace, workspace_token: "token-pending" }),
    targetDraftId: "draft-A",
    operationNonce,
  });

  authority.markSemanticMutation();
  resolvePersist({ ok: true, workspace, workspace_token: "token-pending", target_draft: workspace.drafts[0] });
  const settlement = await settlementPromise;
  let providerCalls = 0;
  if (settlement.code === "IMAGE_BOOTSTRAP_CURRENT") providerCalls += 1;
  assert.equal(settlement.code, "IMAGE_BOOTSTRAP_STALE_PENDING_SAVED");
  assert.equal(providerCalls, 0, "a stale operation may expose recovery, but can never continue into a paid START");
});

test("image bootstrap retries exactly once only when the latest draft is semantically identical", async () => {
  const operationNonce = "d".repeat(64);
  const desiredPending = { operation_nonce: operationNonce };
  const latestWorkspace = {
    active_draft_id: "draft-A",
    drafts: [{ draft_id: "draft-A", pending_image_operation: null }],
  };
  let initialWrites = 0;
  let retryWrites = 0;
  const successful = await settleImageBootstrapPersistence({
    persist: async () => {
      initialWrites += 1;
      return { ok: false, code: "WORKSPACE_DRAFT_CAS_CONFLICT", workspace: latestWorkspace };
    },
    isCurrent: () => true,
    readLatest: async () => ({ ok: true, workspace: latestWorkspace }),
    canRetry: () => true,
    retryPersist: async () => {
      retryWrites += 1;
      const targetDraft = { draft_id: "draft-A", pending_image_operation: desiredPending };
      return { ok: true, target_draft: targetDraft, workspace: { ...latestWorkspace, drafts: [targetDraft] } };
    },
    targetDraftId: "draft-A",
    operationNonce,
  });
  assert.equal(successful.code, "IMAGE_BOOTSTRAP_CURRENT");
  assert.equal(initialWrites, 1);
  assert.equal(retryWrites, 1);

  retryWrites = 0;
  const rejected = await settleImageBootstrapPersistence({
    persist: async () => ({ ok: false, code: "WORKSPACE_DRAFT_CAS_CONFLICT", workspace: latestWorkspace }),
    isCurrent: () => true,
    readLatest: async () => ({ ok: true, workspace: latestWorkspace }),
    canRetry: () => false,
    retryPersist: async () => { retryWrites += 1; },
    targetDraftId: "draft-A",
    operationNonce,
  });
  assert.equal(rejected.code, "IMAGE_BOOTSTRAP_NOT_COMMITTED");
  assert.equal(retryWrites, 0, "a changed draft cannot be merged into the old image request");

  const staleNoop = await settleImageBootstrapPersistence({
    persist: async () => ({ ok: true, target_draft: latestWorkspace.drafts[0], workspace: latestWorkspace }),
    isCurrent: () => false,
    readLatest: async () => { throw new Error("stale no-op must not need another read"); },
    targetDraftId: "draft-A",
    operationNonce,
  });
  assert.equal(staleNoop.code, "IMAGE_BOOTSTRAP_STALE_NOOP");
});

test("confirmed text without real pages is presented as text-ready, never as a template or empty draft", () => {
  assert.match(mainSource, /isDraftInputOnly && textConfirmed \? "文字草稿"/);
  assert.match(mainSource, /isDraftInputOnly \? 0 : visiblePages\.length/);
  assert.match(mainSource, /aria-label=\{textConfirmed \? "文字已确认，等待配图" : "空白新稿"\}/);
  assert.match(mainSource, /textConfirmed \? "TEXT READY" : "NEW DRAFT"/);
  assert.match(mainSource, /textConfirmed \? "文字已确认，等待配图" : isFreshDraft \? "从一段原文开始" : "原文已就位"/);
  assert.match(mainSource, /textConfirmed \? "查看配图设置"/);
});

test("editing text never hides a durable paid image recovery task", () => {
  const imageSource = namedFunctionSource(mainSource, "generateImageNode");
  assert.match(imageSource, /if \(!textConfirmed && !pendingImageOperation\)/, "an existing durable recovery must remain callable after text is edited");
  assert.match(imageSource, /baseRecord\.pending_image_operation\?\.operation_snapshot\?\.confirmed_draft \|\| textDraft/, "recovery must use the frozen confirmed text rather than the newly edited text");
  assert.match(mainSource, /textDraft && \(textConfirmed \|\| pendingImageOperation\)/, "the recovery panel cannot disappear merely because the current text is unconfirmed");
  assert.match(mainSource, /旧文字的配图恢复/);
  assert.match(mainSource, /imageOperationAuthorityV3\(workspaceEnvelopeRef\.current/,
    "refresh must rediscover a moved recovery holder from the canonical workspace");
  assert.match(imageSource, /operationAuthority\?\.holder_draft_id \|\| sourceDraftId/);
  assert.match(imageSource, /operationAuthority\?\.location\?\.startsWith\("RECOVERY"\) \? targetDraftId/,
    "a recovery holder must advance in place rather than fork a second recovery draft");
  assert.match(mainSource, /effectiveImageResume/, "the recovery panel must render its durable cursor rather than a cleared React cursor");
});

test("deferred workspace transition blocks edits and stale NOOP preserves dirty UI with zero apply", async () => {
  const lock = createMainTransitionLock();
  const operation = { id: "transition-1" };
  let resolveHydration;
  const hydration = new Promise((resolve) => { resolveHydration = resolve; });
  const ui = { text: "before" };
  let writes = 0;
  const transition = (async () => {
    assert.equal(lock.acquire(operation, "draft-A"), true);
    try {
      await hydration;
      writes += 1;
    } finally {
      lock.release(operation);
    }
  })();
  if (!lock.isLocked()) ui.text = "lost";
  assert.equal(ui.text, "before", "handler-level mutation must remain zero while hydration/CAS owns the transition");
  resolveHydration();
  await transition;
  assert.equal(writes, 1);
  assert.equal(lock.isLocked(), false);

  let authoritativeApplies = 0;
  ui.text = "dirty local text";
  const disposition = workspaceTransitionReceiptDisposition({
    operationApplied: false,
    candidateWorkspaceToken: "candidate-token",
    receiptWorkspaceToken: "unchanged-token",
  });
  if (disposition === "STALE_CANDIDATE_CURRENT_SETTLE") {
    authoritativeApplies += 1;
    ui.text = "old receipt text";
  }
  assert.equal(disposition, "STALE_NOOP_PRESERVE_LOCAL");
  assert.equal(authoritativeApplies, 0);
  assert.equal(ui.text, "dirty local text");
});

test("E1 receipt followed by E2 storage never rolls the UI back to E1", async () => {
  let resolveReceipt;
  const receiptDeferred = new Promise((resolve) => { resolveReceipt = resolve; });
  let latest = { ok: true, workspace_token: "E1", workspace: { active_draft_id: "draft-A" } };
  const settlement = (async () => {
    const receipt = await receiptDeferred;
    return {
      receipt,
      latest,
      plan: postCasWorkspaceSettlementPlan({
        latestOk: latest.ok,
        latestWorkspaceToken: latest.workspace_token,
        receiptWorkspaceToken: receipt.workspace_token,
        currentWorkspaceToken: "E0",
        latestActiveDraftId: latest.workspace.active_draft_id,
        dirtyDraftId: "draft-A",
      }),
    };
  })();
  latest = { ok: true, workspace_token: "E2", workspace: { active_draft_id: "draft-A" } };
  resolveReceipt({ ok: true, workspace_token: "E1", workspace: { active_draft_id: "draft-B" } });
  const result = await settlement;
  assert.equal(result.plan, "LATEST_CHANGED_APPLY_AND_BLOCK");
  assert.equal(result.latest.workspace_token, "E2");
  assert.notEqual(result.latest.workspace_token, result.receipt.workspace_token, "the obsolete E1 receipt can never become the adopted authority");

  assert.equal(postCasWorkspaceSettlementPlan({
    latestOk: true,
    latestWorkspaceToken: "E2",
    receiptWorkspaceToken: "E1",
    currentWorkspaceToken: "E0",
    latestActiveDraftId: "draft-A",
    dirtyDraftId: "draft-A",
    preserveSameActive: true,
  }), "LATEST_SAME_ACTIVE_PRESERVE_LOCAL", "autosave must keep same-draft dirty UI while advancing to E2");
});

test("manual save WebLock delay preserves later input for both NOOP and committed stale receipts", async () => {
  for (const scenario of [
    { name: "NOOP", receiptToken: "E0", latestToken: "E0", expectedPlan: "LATEST_ALREADY_ADOPTED" },
    { name: "COMMITTED", receiptToken: "E1", latestToken: "E1", expectedPlan: "LATEST_SAME_ACTIVE_PRESERVE_LOCAL" },
  ]) {
    let target = { draftId: "draft-A", pageId: null, workspaceToken: "E0" };
    const authority = createMainAuthorityRuntime(() => target);
    const operation = authority.capture(`manual-save-${scenario.name}`, { envelopeScoped: true });
    let resolveMerge;
    const mergeDeferred = new Promise((resolve) => { resolveMerge = resolve; });
    let ui = { text: "old snapshot", saved_at: null };
    let authoritativeApplies = 0;
    let retryPayload = null;
    const flow = (async () => {
      const receipt = await mergeDeferred;
      const committed = authority.commit(operation, () => {
        authoritativeApplies += 1;
        ui = { text: "old snapshot", saved_at: "old" };
      });
      assert.equal(committed.applied, false);
      const plan = postCasWorkspaceSettlementPlan({
        latestOk: true,
        latestWorkspaceToken: scenario.latestToken,
        receiptWorkspaceToken: receipt.workspace_token,
        currentWorkspaceToken: target.workspaceToken,
        latestActiveDraftId: "draft-A",
        dirtyDraftId: "draft-A",
        preserveSameActive: true,
      });
      if (["LATEST_ALREADY_ADOPTED", "LATEST_SAME_ACTIVE_PRESERVE_LOCAL"].includes(plan)) {
        ui = { ...ui, saved_at: ui.saved_at || "new-save-intent" };
        retryPayload = structuredClone(ui);
      }
      return plan;
    })();

    ui = { text: "new text typed while merge waits", saved_at: null };
    authority.markSemanticMutation();
    resolveMerge({ ok: true, workspace_token: scenario.receiptToken });
    const plan = await flow;
    assert.equal(plan, scenario.expectedPlan, scenario.name);
    assert.equal(authoritativeApplies, 0, scenario.name);
    assert.equal(ui.text, "new text typed while merge waits", scenario.name);
    assert.equal(retryPayload.text, "new text typed while merge waits", `${scenario.name} retry must persist the newest text`);
    assert.equal(retryPayload.saved_at, "new-save-intent", `${scenario.name} retry must preserve the manual-save intent`);
  }
});

test("durable draft navigation, action references and corrupt-v3 recovery are live main wiring", () => {
  const sessionSource = namedFunctionSource(mainSource, "currentAuthoringSession");
  assert.match(sessionSource, /action_reference_manifest:\s*actionReferences/);
  assert.match(sessionSource, /action_reference_note:\s*actionReferenceNote/);
  assert.match(mainSource, /useState\(initialGenerationSession\?\.action_reference_manifest \|\| \[\]\)/);
  assert.match(mainSource, /useState\(initialGenerationSession\?\.action_reference_note \|\| ""\)/);
  assert.match(mainSource, /imageResume, actionReferences, actionReferenceNote, activatedAsContentOnly/, "reference changes must schedule durable autosave");

  const applySource = namedFunctionSource(mainSource, "applyDraftRecord");
  assert.match(applySource, /session\?\.action_reference_manifest\s*\?\?/);
  assert.match(applySource, /session\?\.action_reference_note\s*\?\?/);

  const adoptSource = namedFunctionSource(mainSource, "adoptWorkspaceState");
  assert.match(adoptSource, /setPreviousDraftId\(previousId !== undefined \? previousId : \(nextWorkspace\.previous_draft_id \?\? null\)\)/, "every boot, conflict and readback must restore the durable previous-draft pointer");
  const conflictSource = namedFunctionSource(mainSource, "handleWorkspaceConflict");
  assert.match(conflictSource, /if \(latest\?\.active_draft_id\)/);
  assert.match(conflictSource, /adoptWorkspaceState\(latest, \{ record: finalRecord, applyRecord: Boolean\(finalRecord\) \}\)/, "same-id newer content must replace the stale UI before read-only lock");

  const restoreSource = namedFunctionSource(mainSource, "restoreWorkspaceBackup");
  assert.match(restoreSource, /workspaceCoordinator\.snapshot\(\)/);
  assert.match(restoreSource, /currentSnapshot\.code !== "WORKSPACE_V3_ENVELOPE_INVALID"/);
  assert.match(restoreSource, /await workspaceCoordinator\.recoverySnapshot\(\)/);
  assert.match(restoreSource, /recovery\.code !== "WORKSPACE_V3_CORRUPT_RECOVERY_READY"/);
  assert.match(restoreSource, /\brecoveryPrecondition,/, "the exact corrupt-v3 preimage must reach the restore CAS");
  assert.doesNotMatch(restoreSource, /workspaceEnvelopeV3Token\(workspaceEnvelopeRef\.current\)/, "corrupt persisted v3 must not be parsed before selecting recovery CAS");
  assert.doesNotMatch(restoreSource, /previousId:\s*null/, "restoring a backup must preserve its durable previous-draft navigation");

  const creatorSource = namedFunctionSource(mainSource, "renderCreatorWorkflow");
  assert.ok(count(creatorSource, /disabled=\{textLaneLocked\}/g) >= 10, "text controls must remain editable outside workspace and active generation locks");
  assert.ok(count(creatorSource, /disabled=\{imageLaneLocked \|\| isGenerating/g) >= 7, "reference and image-plan controls must share the asset-lane lock");
});
