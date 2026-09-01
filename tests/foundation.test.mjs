import assert from "node:assert/strict";
import test from "node:test";
import { generateContentPackage, importLocalEditableDraft, inspectImportContract } from "../src/content-engine.mjs";
import { createLocalHttpProvider } from "../src/provider-client.mjs";
import { buildGenerationRequest, buildImageGenerationRequest, buildPageCandidateRequest, buildTextDraftRequest, canonicalImageGenerationInputPreimage, computeImageGenerationInputSha256, parseGenerationRequest, parseImageGenerationRequest, parseImageGenerationResponse, parsePageCandidateRequest, parsePageCandidateResponse, parseTextDraftRequest, parseTextDraftResponse } from "../src/provider-contract.mjs";
import { createProfileV2 } from "../src/profile-v2.mjs";
import { buildWorkspaceBackup, parseWorkspaceBackup, persistWorkspaceState, prepareFreshDraftWorkspace } from "../src/workspace-state.mjs";

const IMAGE_NONCE = "a".repeat(64);
const IMAGE_INPUT_SHA = "b".repeat(64);
const IMAGE_ASSET_SHA = "c".repeat(64);
const IMAGE_ASSET_REF = `xiaoshimei-media://sha256/${IMAGE_ASSET_SHA}`;

function confirmedImageDraft(overrides = {}) {
  return {
    draft_id: "draft-image-contract",
    source_input: "眼睛休息方法",
    pillar: "wellness",
    goal: "save",
    titles: ["刷完手机先让眼睛休息一会儿", "眼睛发紧时我会先做这几步", "给一直盯屏幕的眼睛一个暂停"],
    selected_title: "眼睛发紧时我会先做这几步",
    body: "这是一段经过用户确认的完整发布正文。".repeat(24),
    tags: ["眼部放松", "生活方式", "屏幕休息", "日常养生", "轻缓练习"],
    recommended_image_count: 2,
    facts: [],
    risks: [],
    content_type: "knowledge_card",
    style_lock: null,
    prompt_context: {},
    ...overrides,
  };
}

function imageManifest(overrides = {}) {
  return {
    schema: "xiaoshimei.media-asset-manifest.v1",
    media_ref: IMAGE_ASSET_REF,
    sha256: IMAGE_ASSET_SHA,
    size_bytes: 3,
    mime: "image/jpeg",
    name: "拳架参考",
    width: 3,
    height: 4,
    ...overrides,
  };
}

function imageStartInput(overrides = {}) {
  return {
    mode: "START",
    bootstrap_nonce: IMAGE_NONCE,
    operation_snapshot: {
      schema: "xiaoshimei.image-operation-snapshot.v1",
      draft_record_id: "draft-record-image-contract",
      mutation_epoch: 7,
      confirmed_draft: confirmedImageDraft(),
      page_count: 2,
      production_mode: "smart",
      reference_note: "参考手脚关系",
    },
    input_sha256: IMAGE_INPUT_SHA,
    reference_manifest: [imageManifest()],
    missing_reference_media: [{
      media_ref: IMAGE_ASSET_REF,
      sha256: IMAGE_ASSET_SHA,
      size_bytes: 3,
      mime: "image/jpeg",
      bytes_base64: Buffer.from("abc").toString("base64"),
    }],
    ...overrides,
  };
}

function imageStepInput(overrides = {}) {
  return {
    mode: "STEP",
    run_id: "image-run-contract-0001",
    checkpoint_preimage: { schema: "xiaoshimei.image-checkpoint.v1", cursor: 1 },
    checkpoint_preimage_sha256: "d".repeat(64),
    logical_step_id: "render-page-2",
    attempt_nonce: "e".repeat(64),
    ...overrides,
  };
}

function imageGenerationResponse(status, overrides = {}) {
  return {
    schema: "xiaoshimei.image-generation-response.v1",
    status,
    bootstrap_nonce: IMAGE_NONCE,
    input_sha256: IMAGE_INPUT_SHA,
    run_id: "image-run-contract-0001",
    checkpoint_preimage: { schema: "xiaoshimei.image-checkpoint.v1", cursor: status === "PARTIAL" ? 1 : 2 },
    checkpoint_preimage_sha256: status === "PARTIAL" ? "d".repeat(64) : "f".repeat(64),
    logical_step_id: status === "PARTIAL" ? "render-page-1" : "render-page-2",
    progress: { completed_steps: status === "PARTIAL" ? 1 : 2, total_steps: 2 },
    assets: [imageManifest()],
    media_delta: [imageManifest({ asset_url: `/api/provider/assets/image-run-contract-0001/${IMAGE_ASSET_SHA}` })],
    error: null,
    cached: false,
    recoverable_until: "2026-09-08T00:00:00.000Z",
    upstream_calls: status === "PARTIAL" ? 1 : 0,
    ...(status === "COMPLETE" ? { content_package: { schema: "xiaoshimei.content-package.v2", pages: [{ image_style: { src: IMAGE_ASSET_REF } }] } } : {}),
    ...overrides,
  };
}

test("a normal 1–8 page local draft can resume without importing authority", () => {
  const draft = generateContentPackage({ topic: "安全续编" });
  draft.pages = draft.pages.slice(0, 6);
  draft.stage = "FULL_DRAFT";
  draft.visible_pages = 6;
  draft.review = { source: "INDEPENDENT_EVIDENCE", decision: "KEEP", reviewed_at: "2026-08-14T00:00:00Z", authority_effect: "EVIDENCE_ONLY" };
  draft.origin = {
    contract: "PRODUCER_TWO_PAGE",
    source_probe_fingerprint_sha256: "a".repeat(64),
    producer_artifact_sha256: "b".repeat(64),
    authority_scope: "SINGLE_EXPANSION_CONSUMED",
  };
  assert.equal(inspectImportContract(draft).contract, "LOCAL_EDITABLE_DRAFT");
  const resumed = importLocalEditableDraft(JSON.stringify(draft));
  assert.equal(resumed.stage, "LOCAL_DRAFT");
  assert.equal(resumed.scale_permission, "UNVERIFIED");
  assert.equal(resumed.review.source, "NONE");
  assert.equal(resumed.review.decision, "IMPORTED_LOCAL_DRAFT_REQUIRES_REVIEW");
  assert.equal(resumed.origin.authority_scope, "SINGLE_EXPANSION_CONSUMED");
});

test("workspace backup restores profile, current draft and library without live authority", () => {
  const currentContent = generateContentPackage({ topic: "当前稿" });
  const libraryDraft = { ...generateContentPackage({ topic: "资产库稿" }), id: "draft-1", saved_at: "2026-08-14T00:00:00Z" };
  const backup = buildWorkspaceBackup({ profile: createProfileV2(), currentContent, library: [libraryDraft], createdAt: "2026-08-14T01:00:00Z" });
  const restored = parseWorkspaceBackup(JSON.stringify(backup));
  assert.equal(restored.profile.schema, "xiaoshimei.profile.v2");
  assert.equal(restored.currentContent.source_input, "当前稿");
  assert.equal(restored.library[0].id, "draft-1");
  assert.equal(restored.currentContent.review.decision, "IMPORTED_LOCAL_DRAFT_REQUIRES_REVIEW");
});

test("workspace restore rejects forged authority and malformed content atomically", () => {
  const backup = buildWorkspaceBackup({ profile: createProfileV2(), currentContent: generateContentPackage({ topic: "原稿" }), library: [] });
  backup.authority_effect = "PRODUCTION_ALLOWED";
  assert.throws(() => parseWorkspaceBackup(JSON.stringify(backup)), /cannot carry authority/);
  backup.authority_effect = "LOCAL_EDITING_ONLY";
  backup.current_content.tags = ["少一个"];
  assert.throws(() => parseWorkspaceBackup(JSON.stringify(backup)), /LOCAL_DRAFT_INVALID|local editable draft contract|tags must contain 5 items/);
});

test("workspace storage rolls back earlier writes when a later write fails", () => {
  const values = new Map([["content", "old-content"], ["library", "old-library"], ["profile", "old-profile"]]);
  let failed = false;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (key === "library" && !failed) { failed = true; throw new Error("quota exceeded"); }
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
  };
  const result = persistWorkspaceState(storage, { currentContent: { a: 1 }, library: [], profile: { b: 2 } }, { content: "content", library: "library", profile: "profile" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "STORAGE_WRITE_FAILED");
  assert.equal(values.get("content"), "old-content");
  assert.equal(values.get("library"), "old-library");
  assert.equal(values.get("profile"), "old-profile");
});

test("new creation starts blank while preserving the previous draft in the asset library", () => {
  const currentContent = generateContentPackage({ topic: "不能被新创作吞掉的旧稿", pillar: "growth" });
  const profile = createProfileV2();
  const result = prepareFreshDraftWorkspace({
    currentContent,
    library: [],
    profile,
    draftId: "preserved-draft",
    savedAt: "2026-08-28T12:00:00Z",
  });
  assert.equal(result.currentContent.source_input, "");
  assert.equal(result.currentContent.pillar, "wellness");
  assert.equal(result.library.length, 1);
  assert.equal(result.library[0].id, "preserved-draft");
  assert.equal(result.library[0].source_input, "不能被新创作吞掉的旧稿");
  assert.equal(result.preservedPrevious, true);
});

test("restarting an untouched blank draft does not create asset-library litter", () => {
  const result = prepareFreshDraftWorkspace({
    currentContent: generateContentPackage({ topic: "" }),
    library: [],
    profile: createProfileV2(),
    draftId: "unused",
    savedAt: "2026-08-28T12:00:00Z",
  });
  assert.equal(result.currentContent.source_input, "");
  assert.equal(result.library.length, 0);
  assert.equal(result.preservedPrevious, false);
});

test("local HTTP provider sends a typed request and cannot exfiltrate to remote hosts", async () => {
  let request;
  const expected = generateContentPackage({ topic: "Provider 返回" });
  const provider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async (url, options) => { request = { url: String(url), options }; return { ok: true, json: async () => expected }; },
  });
  const received = await provider.generate({ topic: "请求", profile_contract: { schema: "test" } });
  assert.equal(received.selectedTitle, expected.selectedTitle);
  assert.equal(JSON.parse(request.options.body).schema, "xiaoshimei.generation-request.v1");
  assert.throws(() => createLocalHttpProvider({ endpoint: "https://example.com/generate" }), /loopback/);
});

test("local HTTP provider exposes a bounded health check for visible UI status", async () => {
  let request;
  const provider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, status: 200, json: async () => ({ status: "LIVE_VERIFIED", configured: true }) };
    },
  });
  const health = await provider.checkHealth();
  assert.equal(request.url, "http://127.0.0.1:9909/health");
  assert.equal(request.options.method, "GET");
  assert.equal(health.status, "LIVE_VERIFIED");
});

test("public provider reports configured separately from a verified successful call", async () => {
  const previousLocation = globalThis.location;
  const previousSessionStorage = globalThis.sessionStorage;
  const values = new Map();
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://studio.example/") });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  } });
  try {
    const provider = createLocalHttpProvider({
      endpoint: "https://studio.example/api/provider/generate",
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        json: async () => String(url).endsWith("/health")
          ? { status: "AWAITING_BYOK", configured: false }
          : generateContentPackage({ topic: "真实成功才算验证" }),
      }),
    });
    await provider.updateSettings({
      provider: "volcengine-ark",
      api_key: "test-key-123456",
      text_model: "doubao-text",
      image_model: "doubao-image",
    });
    assert.equal((await provider.checkHealth()).status, "CONFIGURED_UNVERIFIED");
    await provider.generate({ topic: "调用成功", profile_contract: { schema: "test" } });
    const verified = await provider.checkHealth();
    assert.equal(verified.status, "LIVE_VERIFIED");
    assert.ok(verified.last_success_at);
    await provider.updateSettings({
      provider: "volcengine-ark",
      api_key: "replacement-key-123456",
      text_model: "doubao-text",
      image_model: "doubao-image",
    });
    assert.equal((await provider.checkHealth()).status, "CONFIGURED_UNVERIFIED");
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, value: previousLocation });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: previousSessionStorage });
  }
});

test("public production provider uses server-managed credentials without sending an authorization header", async () => {
  const previousLocation = globalThis.location;
  const previousSessionStorage = globalThis.sessionStorage;
  const values = new Map();
  const requests = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://studio.example/") });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  } });
  try {
    const provider = createLocalHttpProvider({
      endpoint: "https://studio.example/api/provider/generate",
      fetchImpl: async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith("/health") || String(url).endsWith("/config")) return { ok: true, status: 200, json: async () => ({ status: "CONFIGURED_UNVERIFIED", configured: true, credential_mode: "SERVER_MANAGED", provider: "volcengine-ark", text_model: "server-text", image_model: "server-image" }) };
        return { ok: true, status: 200, json: async () => generateContentPackage({ topic: "服务端托管成功" }) };
      },
    });
    assert.equal((await provider.checkHealth()).credential_mode, "SERVER_MANAGED");
    await provider.generate({ topic: "调用成功", profile_contract: { schema: "test" } });
    const postRequest = requests.find((request) => request.options.method === "POST");
    assert.equal(postRequest.options.headers.authorization, undefined);
    assert.equal(values.has("xiaoshimei-studio.byok-api-key.v1"), false);
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, value: previousLocation });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: previousSessionStorage });
  }
});

test("page candidate requests stay typed, loopback-only and require exactly three evidenced images", async () => {
  let target;
  const provider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async (url, options) => {
      target = { url: String(url), body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ schema: "xiaoshimei.page-candidate-response.v1", run_id: "candidate-run", candidates: [1,2,3].map((index) => ({ src: `/generated/ark/page-candidates/candidate-run/0${index}.jpg`, sha256: String(index).repeat(64), size_bytes: 2048, width: 1728, height: 2304 })) }) };
    },
  });
  const input = { page_index: 1, source_input: "书院筹备", title: "三条路径", body: "青少年武术教育、成人禅修养生、文旅体验", layout: "split", content_type: "knowledge_card", page_role: "comparison", visual_action: "小师妹在三组器物之间做比较", image_prompt: "三组器物同框", prompt_context: {} };
  const result = await provider.generatePageCandidates(input);
  assert.equal(target.url, "http://127.0.0.1:9909/page-candidates");
  const parsed = parsePageCandidateRequest(buildPageCandidateRequest(input));
  assert.equal(parsed.source_input, input.source_input);
  assert.equal(parsed.content_type, "knowledge_card");
  assert.equal(parsed.page_role, "comparison");
  assert.equal(parsed.visual_action, input.visual_action);
  assert.equal(parsed.image_prompt, input.image_prompt);
  assert.equal(result.candidates.length, 3);
  assert.throws(() => parsePageCandidateResponse({ schema: "xiaoshimei.page-candidate-response.v1", candidates: [] }), /COUNT_INVALID/);
});

test("browser and Provider share one strict generation request envelope", () => {
  const input = { topic: "两页真实探针", pillar: "academy", goal: "save", profile_contract: { schema: "xiaoshimei.generation-profile-contract.v2" } };
  const envelope = buildGenerationRequest(input);
  assert.equal(envelope.schema, "xiaoshimei.generation-request.v1");
  assert.deepEqual(parseGenerationRequest(envelope), input);
  assert.throws(() => parseGenerationRequest(input), /SCHEMA_UNSUPPORTED/);
  assert.throws(() => parseGenerationRequest({ schema: envelope.schema, input: null }), /INPUT_INVALID/);
});

test("local Provider preserves a safe upstream failure code for the GUI", async () => {
  const provider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({
      error: "ARK_PROBE_FAILED",
      code: "IMAGE_3_QA_REJECTED:HAND_INVALID",
      details: {
        resume_run_id: "images-2026-08-15T00-00-00-000Z-1234abcd",
        completed_pages: 2,
        total_pages: 4,
        failed_page: 3,
        actual_image_calls: 3,
        estimated_image_cost_cny: 0.66,
      },
    }) }),
  });
  await assert.rejects(
    () => provider.generate({ topic: "不会重试" }),
    (error) => error.message.includes("IMAGE_3_QA_REJECTED") && error.providerDetails?.completed_pages === 2 && error.providerDetails?.actual_image_calls === 3,
  );
});

test("image transport is an exact START, DISCOVER or STEP union", () => {
  const start = parseImageGenerationRequest(buildImageGenerationRequest(imageStartInput()));
  assert.equal(start.mode, "START");
  assert.equal(start.operation_snapshot.schema, "xiaoshimei.image-operation-snapshot.v1");
  assert.equal(start.reference_manifest[0].media_ref, IMAGE_ASSET_REF);
  assert.equal(start.missing_reference_media[0].bytes_base64, "YWJj");

  const discoverInput = { mode: "DISCOVER", bootstrap_nonce: IMAGE_NONCE, input_sha256: IMAGE_INPUT_SHA };
  assert.deepEqual(parseImageGenerationRequest(buildImageGenerationRequest(discoverInput)), discoverInput);
  const step = parseImageGenerationRequest(buildImageGenerationRequest(imageStepInput()));
  assert.equal(step.mode, "STEP");
  assert.equal(step.logical_step_id, "render-page-2");

  assert.throws(() => buildImageGenerationRequest({ ...imageStartInput(), typo: true }), /IMAGE_GENERATION_START_FIELDS_INVALID/);
  assert.throws(() => buildImageGenerationRequest({ ...discoverInput, reference_manifest: [] }), /IMAGE_GENERATION_DISCOVER_FIELDS_INVALID/);
  assert.throws(() => buildImageGenerationRequest({ ...imageStepInput(), draft: confirmedImageDraft() }), /IMAGE_GENERATION_STEP_FIELDS_INVALID/);
  assert.throws(() => buildImageGenerationRequest({ ...imageStepInput(), reference_manifest: [] }), /IMAGE_GENERATION_STEP_FIELDS_INVALID/);
  assert.throws(() => parseImageGenerationRequest({ schema: "xiaoshimei.image-generation-request.v1", input: imageStepInput(), extra: true }), /IMAGE_GENERATION_REQUEST_FIELDS_INVALID/);
  assert.throws(() => buildImageGenerationRequest({ mode: "RESUME", bootstrap_nonce: IMAGE_NONCE, input_sha256: IMAGE_INPUT_SHA }), /IMAGE_GENERATION_MODE_INVALID/);
});

test("image input identity hashes only the normalized immutable snapshot and ordered manifest", async () => {
  const input = imageStartInput();
  const preimage = canonicalImageGenerationInputPreimage({ operation_snapshot: input.operation_snapshot, reference_manifest: input.reference_manifest });
  assert.deepEqual(Object.keys(JSON.parse(preimage)), ["operation_snapshot", "reference_manifest"]);
  assert.doesNotMatch(preimage, /bytes_base64|YWJj|bootstrap_nonce/);
  const hash = await computeImageGenerationInputSha256({ operation_snapshot: input.operation_snapshot, reference_manifest: input.reference_manifest });
  assert.match(hash, /^[0-9a-f]{64}$/);
  const sameWithDifferentTransferBytes = await computeImageGenerationInputSha256({ operation_snapshot: input.operation_snapshot, reference_manifest: input.reference_manifest, missing_reference_media: [{ bytes_base64: "different" }] });
  assert.equal(sameWithDifferentTransferBytes, hash);
  const second = imageManifest({ media_ref: `xiaoshimei-media://sha256/${"1".repeat(64)}`, sha256: "1".repeat(64), name: "第二张参考" });
  const ordered = await computeImageGenerationInputSha256({ operation_snapshot: input.operation_snapshot, reference_manifest: [input.reference_manifest[0], second] });
  const reversed = await computeImageGenerationInputSha256({ operation_snapshot: input.operation_snapshot, reference_manifest: [second, input.reference_manifest[0]] });
  assert.notEqual(reversed, ordered);
});

test("START rejects reference and physical request limits before fetch while STEP stays media-size independent", () => {
  const exactReferenceLimit = [1, 2, 3].map((index) => imageManifest({
    media_ref: `xiaoshimei-media://sha256/${String(index).repeat(64)}`,
    sha256: String(index).repeat(64),
    size_bytes: 900000,
    name: `边界参考${index}`,
  }));
  assert.doesNotThrow(() => buildImageGenerationRequest(imageStartInput({ reference_manifest: exactReferenceLimit, missing_reference_media: [] })));
  assert.throws(
    () => buildImageGenerationRequest(imageStartInput({ reference_manifest: [imageManifest({ size_bytes: 900001 })], missing_reference_media: [] })),
    /IMAGE_GENERATION_REFERENCE_SIZE_INVALID/,
  );
  const three = [0, 1, 2].map((index) => imageManifest({
    media_ref: `xiaoshimei-media://sha256/${String(index + 1).repeat(64)}`,
    sha256: String(index + 1).repeat(64),
    size_bytes: index === 2 ? 900001 : 900000,
    name: `参考${index + 1}`,
  }));
  assert.throws(
    () => buildImageGenerationRequest(imageStartInput({ reference_manifest: three, missing_reference_media: [] })),
    /IMAGE_GENERATION_REFERENCE_(SIZE|TOTAL)_INVALID/,
  );

  const largeManifests = [1, 2, 3].map((index) => imageManifest({
    media_ref: `xiaoshimei-media://sha256/${String(index).repeat(64)}`,
    sha256: String(index).repeat(64),
    size_bytes: 875000,
    name: `大参考${index}`,
  }));
  const largeMedia = largeManifests.map((manifest) => ({
    media_ref: manifest.media_ref,
    sha256: manifest.sha256,
    size_bytes: manifest.size_bytes,
    mime: manifest.mime,
    bytes_base64: Buffer.alloc(manifest.size_bytes, 1).toString("base64"),
  }));
  const withinPhysicalLimit = largeManifests.map((manifest) => ({ ...manifest, size_bytes: 873000 }));
  const withinPhysicalMedia = withinPhysicalLimit.map((manifest) => ({
    media_ref: manifest.media_ref,
    sha256: manifest.sha256,
    size_bytes: manifest.size_bytes,
    mime: manifest.mime,
    bytes_base64: Buffer.alloc(manifest.size_bytes, 1).toString("base64"),
  }));
  assert.doesNotThrow(() => buildImageGenerationRequest(imageStartInput({ reference_manifest: withinPhysicalLimit, missing_reference_media: withinPhysicalMedia })));
  assert.throws(
    () => buildImageGenerationRequest(imageStartInput({ reference_manifest: largeManifests, missing_reference_media: largeMedia })),
    /IMAGE_GENERATION_REQUEST_TOO_LARGE/,
  );

  const exactStep = JSON.stringify(buildImageGenerationRequest(imageStepInput()));
  assert.equal(exactStep, JSON.stringify(buildImageGenerationRequest(imageStepInput())));
  assert.doesNotMatch(exactStep, /reference_manifest|missing_reference_media|bytes_base64|confirmed_draft/);
});

test("image responses expose only small manifests and COMPLETE alone may carry a ref-only content package", () => {
  const partial = parseImageGenerationResponse(imageGenerationResponse("PARTIAL"));
  assert.equal(partial.media_delta[0].media_ref, IMAGE_ASSET_REF);
  assert.equal("content_package" in partial, false);
  const complete = parseImageGenerationResponse(imageGenerationResponse("COMPLETE"));
  assert.equal(complete.content_package.pages[0].image_style.src, IMAGE_ASSET_REF);
  assert.throws(() => parseImageGenerationResponse(imageGenerationResponse("PARTIAL", { content_package: complete.content_package })), /IMAGE_GENERATION_RESPONSE_CONTENT_INVALID/);
  assert.throws(() => parseImageGenerationResponse(imageGenerationResponse("COMPLETE", { content_package: { pages: [{ image_style: { src: "data:image/jpeg;base64,AAAA" } }] } })), /IMAGE_GENERATION_RESPONSE_MEDIA_INLINE_FORBIDDEN/);
  assert.throws(() => parseImageGenerationResponse(imageGenerationResponse("COMPLETE", { content_package: { pages: [{ image_style: { src: IMAGE_ASSET_REF, bytes: [1, 2, 3] } }] } })), /IMAGE_GENERATION_RESPONSE_MEDIA_INLINE_FORBIDDEN/);
  assert.throws(() => parseImageGenerationResponse(imageGenerationResponse("COMPLETE", { content_package: { pages: [{ image_style: { src: IMAGE_ASSET_REF, asset_url: `/api/provider/assets/run-1/${IMAGE_ASSET_SHA}` } }] } })), /IMAGE_GENERATION_RESPONSE_MEDIA_INLINE_FORBIDDEN/);
  assert.throws(() => parseImageGenerationResponse(imageGenerationResponse("PARTIAL", { media_delta: [imageManifest()] })), /IMAGE_GENERATION_RESPONSE_MEDIA_DELTA_ASSET_URL_REQUIRED/);
  assert.throws(() => parseImageGenerationResponse(imageGenerationResponse("PARTIAL", { media_delta: [imageManifest({ asset_url: `/api/provider/assets/a-different-run/${IMAGE_ASSET_SHA}` })] })), /IMAGE_GENERATION_REFERENCE_1_ASSET_URL_INVALID/);
  assert.throws(() => parseImageGenerationResponse({ ...imageGenerationResponse("COMPLETE"), extra: true }), /IMAGE_GENERATION_RESPONSE_FIELDS_INVALID/);
});

test("image media deltas are fetched from the same run and verified before local persistence", async () => {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
  const sha256 = "1d4d47030772999b01d3d1ba14be0f13ce77efc2860086dfaefdb0e8bacf6b2b";
  const assetUrl = `/api/provider/assets/image-run-contract-0001/${sha256}`;
  const calls = [];
  const provider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "image/jpeg",
          "content-length": String(bytes.byteLength),
          "x-content-sha256": sha256,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        }),
        arrayBuffer: async () => bytes.buffer.slice(0),
      };
    },
  });
  const materialized = await provider.fetchImageMediaDelta([imageManifest({
    media_ref: `xiaoshimei-media://sha256/${sha256}`,
    sha256,
    size_bytes: bytes.byteLength,
    asset_url: assetUrl,
  })]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `http://127.0.0.1:9909${assetUrl}`);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal("asset_url" in materialized[0], false);
  assert.deepEqual(materialized[0].bytes, bytes);

  const corruptProvider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg", "content-length": String(bytes.byteLength), "x-content-sha256": "0".repeat(64), "cache-control": "private, no-store", "x-content-type-options": "nosniff" }),
      arrayBuffer: async () => bytes.buffer.slice(0),
    }),
  });
  await assert.rejects(() => corruptProvider.fetchImageMediaDelta([imageManifest({
    media_ref: `xiaoshimei-media://sha256/${sha256}`,
    sha256,
    size_bytes: bytes.byteLength,
    asset_url: assetUrl,
  })]), /IMAGE_MEDIA_HEADER_HASH_MISMATCH/);

  const corruptBody = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9]);
  const corruptBodyProvider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg", "content-length": String(bytes.byteLength), "x-content-sha256": sha256, "cache-control": "private, no-store", "x-content-type-options": "nosniff" }),
      arrayBuffer: async () => corruptBody.buffer.slice(0),
    }),
  });
  await assert.rejects(() => corruptBodyProvider.fetchImageMediaDelta([imageManifest({
    media_ref: `xiaoshimei-media://sha256/${sha256}`,
    sha256,
    size_bytes: bytes.byteLength,
    asset_url: assetUrl,
  })]), /IMAGE_MEDIA_BODY_HASH_MISMATCH/);
});

test("image client advances only after the consumer returns an explicit next request", async () => {
  const seen = [];
  const observed = [];
  const provider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => seen.length === 1 ? imageGenerationResponse("PARTIAL") : imageGenerationResponse("COMPLETE") };
    },
  });
  const result = await provider.generateImages(imageStartInput(), async (payload) => {
    observed.push(payload.media_delta.map((asset) => asset.media_ref));
    return payload.status === "PARTIAL" ? { action: "CONTINUE", request: imageStepInput() } : { action: "COMPLETE" };
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].input.mode, "START");
  assert.equal(seen[1].input.mode, "STEP");
  assert.deepEqual(observed, [[IMAGE_ASSET_REF], [IMAGE_ASSET_REF]]);
});

test("image client STOP and cached replay both use the same consumer gate and never send a second request", async () => {
  let fetches = 0;
  const provider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => imageGenerationResponse("PARTIAL", { cached: true, upstream_calls: 0 }) };
    },
  });
  await assert.rejects(
    () => provider.generateImages(imageStartInput(), async (payload) => {
      assert.equal(payload.cached, true);
      assert.equal(payload.media_delta[0].media_ref, IMAGE_ASSET_REF);
      return { action: "STOP" };
    }),
    (error) => error.providerCode === "IMAGE_RUN_STOPPED_AFTER_CHECKPOINT" && error.intentionalStop === true,
  );
  assert.equal(fetches, 1);
});

test("READY, READY discovery and COMPLETE all pass through the same persistence consumer", async () => {
  for (const status of ["READY", "READY_DISCOVERY", "COMPLETE"]) {
    let fetches = 0;
    let consumerCalls = 0;
    const provider = createLocalHttpProvider({
      endpoint: "http://127.0.0.1:9909/generate",
      fetchImpl: async () => {
        fetches += 1;
        return { ok: true, status: 200, json: async () => imageGenerationResponse(status) };
      },
    });
    await assert.rejects(
      () => provider.generateImages(imageStartInput(), async () => {
        consumerCalls += 1;
        return { action: "STOP" };
      }),
      (error) => error.providerCode === "IMAGE_RUN_STOPPED_AFTER_CHECKPOINT",
    );
    assert.equal(consumerCalls, 1, `${status} must reach the persistence consumer`);
    assert.equal(fetches, 1, `${status} STOP must not issue another request`);
  }
});

test("access login reconciles 2xx and ambiguous outcomes exactly once, while explicit auth failures stay exact", async () => {
  const previousLocation = globalThis.location;
  const previousSessionStorage = globalThis.sessionStorage;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://studio.example/") });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  try {
    for (const status of [401, 403, 503]) {
      const calls = [];
      const provider = createLocalHttpProvider({
        endpoint: "https://studio.example/api/provider/generate",
        fetchImpl: async (url) => {
          calls.push(String(url));
          return { ok: false, status, json: async () => ({ code: `EXPLICIT_${status}` }) };
        },
      });
      await assert.rejects(() => provider.authenticateAccess("correct-code", { generation: status }), (error) => error.httpStatus === status && error.providerCode === `EXPLICIT_${status}`);
      assert.equal(calls.filter((url) => url.endsWith("/config")).length, 0);
    }

    for (const kind of ["2xx", "transport", "body"]) {
      const calls = [];
      const provider = createLocalHttpProvider({
        endpoint: "https://studio.example/api/provider/generate",
        fetchImpl: async (url) => {
          calls.push(String(url));
          if (String(url).endsWith("/config")) return { ok: true, status: 200, json: async () => ({ authenticated: true, configured: true, credential_mode: "SERVER_MANAGED" }) };
          if (kind === "transport") throw new TypeError("fetch failed");
          if (kind === "body") return { ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } };
          return { ok: true, status: 200, json: async () => ({ authenticated: true }) };
        },
      });
      const result = await provider.authenticateAccess("correct-code", { generation: 17 });
      assert.equal(result.generation, 17);
      assert.equal(result.config.authenticated, true);
      assert.equal(result.outcome, kind === "2xx" ? "CONFIG_RECONCILED" : "CONFIG_RECONCILED_AMBIGUOUS");
      assert.equal(calls.filter((url) => url.endsWith("/config")).length, 1);
    }
  } finally {
    Object.defineProperty(globalThis, "location", { configurable: true, value: previousLocation });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: previousSessionStorage });
  }
});
