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
const imageRecoveryModeSource = namedFunctionSource(mainSource, "imageRecoveryClickMode").replace(/^export\s+/, "");
const runtimeModule = await import(`data:text/javascript;base64,${Buffer.from(`${runtimeSource}\n${authRuntimeSource}\n${identitySource}\n${authoringLockSource}\n${imageRecoveryModeSource}\nexport { pageSemanticIdentity, authoringInputLockReason, imageRecoveryClickMode };`).toString("base64")}`);
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
  imageRecoveryClickMode,
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

test("pending image authority freezes every image input while the same operation remains recoverable", () => {
  assert.equal(authoringInputLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: null }), null);
  assert.equal(authoringInputLockReason({ workspaceReady: false, workspaceReadOnly: false, pendingImageOperation: null }), "WORKSPACE_MEDIA_READ_ONLY");
  assert.equal(authoringInputLockReason({ workspaceReady: true, workspaceReadOnly: true, pendingImageOperation: null }), "WORKSPACE_MEDIA_READ_ONLY");
  assert.equal(authoringInputLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: { operation_nonce: "a".repeat(64) } }), "PENDING_IMAGE_OPERATION_INPUT_FROZEN");
  assert.equal(authoringInputLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: null, activeDraftId: "draft-A", imageOperationDraftId: "draft-A" }), "PENDING_IMAGE_OPERATION_INPUT_FROZEN");
  assert.equal(authoringInputLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: null, activeDraftId: "draft-B", imageOperationDraftId: "draft-A" }), null);

  const state = { topic: "frozen", title: "frozen", pageCount: 3, productionMode: "smart", refs: ["ref-a"] };
  const before = structuredClone(state);
  const reason = authoringInputLockReason({ workspaceReady: true, workspaceReadOnly: false, pendingImageOperation: { operation_nonce: "a".repeat(64) } });
  if (!reason) Object.assign(state, { topic: "mutated", title: "mutated", pageCount: 8, productionMode: "free", refs: [] });
  assert.deepEqual(state, before, "a pending operation must make handler-level mutations zero-write");

  const guardedHandlers = [
    "setPromptFieldValue",
    "generateTextNode",
    "editTextDraft",
    "chooseDraftTitle",
    "changeContentRoute",
    "confirmTextDraft",
    "changeProductionModeChoice",
    "changeImageCountModeChoice",
    "changeCustomImageCountValue",
    "changeActionReferenceNote",
    "addActionReferences",
    "removeActionReference",
  ];
  for (const name of guardedHandlers) {
    assert.match(namedFunctionSource(mainSource, name), /authoringInputIsLocked\s*\(\s*\)/, `${name} must fail closed before changing image input`);
  }
  assert.match(namedFunctionSource(mainSource, "authoringInputIsLocked"), /imageOperationDraftId:\s*draftMutationLockRef\.current\?\.draft_id/);

  const creatorSource = namedFunctionSource(mainSource, "renderCreatorWorkflow");
  for (const handler of ["changeContentRoute", "confirmTextDraft", "changeProductionModeChoice", "changeImageCountModeChoice", "changeCustomImageCountValue", "changeActionReferenceNote"]) {
    assert.match(creatorSource, new RegExp(`(?:${handler}\\s*\\(|(?:onClick|onChange)=\\{${handler}\\})`), `${handler} must be the live JSX writer, not a parked guard`);
  }
  assert.ok(count(creatorSource, /disabled=\{authoringInputLocked \|\| isGenerating\}/g) >= 10, "all text and image input controls must expose the pending lock");

  const imageSource = namedFunctionSource(mainSource, "generateImageNode");
  assert.match(imageSource, /^function generateImageNode\([^)]*\) \{\s*if \(!mediaWorkspaceIsUsable\(\)\) return;/);
  assert.match(imageSource, /mode:\s*"DISCOVER"|imageDiscoveryRequest\s*\(/);
  assert.match(imageSource, /rebuildPendingImageStartV3\s*\(/, "a cached BOOTSTRAP must rebuild the same START, not create a new operation");
  assert.match(imageSource, /settleImageBootstrapPersistence\s*\(/);
  assert.match(imageSource, /IMAGE_BOOTSTRAP_STALE_PENDING_SAVED/);
  assert.match(imageSource, /setGenerationState\s*\(\s*\(current\)\s*=>\s*current === "IMAGE_GENERATING" \? "IDLE" : current\s*\)/, "operation-id finally must settle global busy even after A to B cutover");
  assert.match(namedFunctionSource(mainSource, "generateImageCandidates"), /^function generateImageCandidates\([^)]*\) \{\s*if \(!mediaWorkspaceIsUsable\(\)\) return;/);
});

test("every persisted pending recovery needs a fresh DISCOVER before a separate paid continuation", () => {
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "UNKNOWN" } }), "DISCOVER_ONLY");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "PARTIAL" } }), "DISCOVER_ONLY");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "READY" } }), "DISCOVER_ONLY");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "PARTIAL" }, requestedPaidContinuation: true }), "CONTINUE_ALLOWED");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "UNKNOWN" }, requestedPaidContinuation: true }), "DISCOVER_ONLY");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: null }), "CONTINUE_ALLOWED");
  assert.equal(imageRecoveryClickMode({ pendingImageOperation: { protocol_state: "READY" }, requestedDiscoveryOnly: true }), "DISCOVER_ONLY");
  const imageSource = namedFunctionSource(mainSource, "generateImageNode");
  assert.match(imageSource, /const discoveryOnly = imageRecoveryClickMode\s*\(/);
  assert.match(imageSource, /if \(discoveryOnly\)[\s\S]*return \{ action: "STOP" \};[\s\S]*nextImageStepRequest/);
  assert.match(imageSource, /零调用查询已完成/);
  assert.match(mainSource, /确认付费：继续图片步骤/);
  assert.doesNotMatch(namedFunctionSource(mainSource, "downloadZip"), /draftMutationIsLocked\s*\(/);
  assert.doesNotMatch(namedFunctionSource(mainSource, "downloadPreparedExport"), /draftMutationIsLocked\s*\(/);
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
  assert.match(saveDraftSource, /if \(!committed\.applied\)/);
  assert.match(saveDraftSource, /reconcileStaleDraftWrite\(receipt, \{ dirtyDraftId: draftId, issueLabel: "保存" \}\)/);
  assert.match(saveDraftSource, /saved_at:\s*latestContent\.saved_at \|\| now/, "manual save intent must survive a same-active dirty retry");

  const saveFeedbackSource = namedFunctionSource(mainSource, "saveRealityFeedback");
  assert.match(saveFeedbackSource, /mergeDraftCas\s*\(/);
  assert.match(saveFeedbackSource, /if \(!committed\.applied\)/);
  assert.match(saveFeedbackSource, /reconcileStaleDraftWrite\s*\(/);

  const autosaveSource = between(mainSource, "const timer = window.setTimeout(async () => {", "}, 400);");
  assert.ok(count(autosaveSource, /pending_image_operation/g) >= 2, "autosave must check pending both before and after materialization");
  assert.ok(count(autosaveSource, /draftMutationLockRef\.current/g) >= 2, "autosave must check the in-memory pre-bootstrap lock twice");
  assert.ok(count(autosaveSource, /workspaceTransitionLock\.isLocked\(\)/g) >= 2, "autosave must not cross an envelope transition before or after materialization");
  assert.match(autosaveSource, /reconcileStaleDraftWrite\(receipt, \{ dirtyDraftId: draftId, issueLabel: "自动保存" \}\)/, "post-CAS stale autosave must use the shared final-snapshot reconciler");
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
  assert.ok(count(creatorSource, /disabled=\{authoringInputLocked \|\| isGenerating/g) >= 12, "reference add/remove/note must expose the same frozen-input authority as text and image controls");
});
