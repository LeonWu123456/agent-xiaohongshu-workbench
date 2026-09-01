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
const identitySource = namedFunctionSource(mainSource, "pageSemanticIdentity");
const runtimeModule = await import(`data:text/javascript;base64,${Buffer.from(`${runtimeSource}\n${identitySource}\nexport { pageSemanticIdentity };`).toString("base64")}`);
const { createMainAuthorityRuntime, pageSemanticIdentity } = runtimeModule;

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
