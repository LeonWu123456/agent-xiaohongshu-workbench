import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import handler from "../api/provider.mjs";
import {
  ACCESS_SESSION_COOKIE,
  ACCESS_SESSION_TTL_SECONDS,
  PUBLIC_GENERATION_RESPONSE_MAX_BYTES,
  assertPublicGenerationResponseBudget,
  buildMissingUnitRepairJobs,
  buildStandaloneRepairPrompt,
  createProviderHandler,
  createUpstashImageLedger,
  generateImages,
  imageLedgerIdentity,
  publicTileBudgetForResponse,
  signPublicImageCheckpoint,
  sliceStandaloneRepairForUnit,
  splitMotherSheetForUnits,
  verifyPublicImageCheckpoint,
} from "../api/provider.mjs";
import { groupIllustrationUnits } from "../src/mother-sheet.mjs";
import { parsePageCandidateResponse, PAGE_CANDIDATE_RESPONSE_SCHEMA } from "../src/provider-contract.mjs";
import { sha256Bytes } from "../src/ark-provider-core.mjs";
import { createPublicImageRun, failPublicImageJob, startPublicImageJob } from "../src/public-image-run.mjs";
import { createLocalHttpProvider } from "../src/provider-client.mjs";
import sharp from "sharp";

function responseProbe() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

class FakeAtomicImageLedger {
  constructor({ commitMode = "normal" } = {}) {
    this.runs = new Map();
    this.attempts = new Map();
    this.commitMode = commitMode;
  }

  async assertReady() { return true; }

  async init(identity) {
    const current = this.runs.get(identity.runId);
    if (current) {
      const same = current.checkpointSha256 === identity.checkpointSha256
        && current.attemptNonce === identity.attemptNonce
        && current.attemptIndex === identity.attemptIndex
        && current.jobIndex === identity.jobIndex;
      return { status: same ? "EXISTING" : "CONFLICT" };
    }
    this.runs.set(identity.runId, {
      ...structuredClone(identity),
      status: "READY",
      reservationCount: identity.attemptIndex,
    });
    return { status: "INITIALIZED" };
  }

  async reserve(identity) {
    const run = this.runs.get(identity.runId);
    if (!run) return { status: "RUN_MISSING" };
    const attemptKey = `${identity.runId}:${identity.attemptIndex}`;
    const attempt = this.attempts.get(attemptKey);
    if (attempt) {
      if (attempt.attemptNonce !== identity.attemptNonce || attempt.checkpointSha256 !== identity.checkpointSha256) return { status: "NONCE_CONFLICT" };
      if (attempt.status === "COMMITTED") return { status: "CACHED", cachedBody: attempt.cachedBody };
      return { status: attempt.status };
    }
    if (run.checkpointSha256 !== identity.checkpointSha256
      || run.attemptNonce !== identity.attemptNonce
      || run.attemptIndex !== identity.attemptIndex
      || run.jobIndex !== identity.jobIndex) return { status: "CHECKPOINT_CONFLICT" };
    if (run.status === "UNKNOWN") return { status: "UNKNOWN" };
    if (run.status === "COMPLETE") return { status: "COMPLETE" };
    if (run.status === "EXHAUSTED" || run.reservationCount >= run.maxCalls) {
      run.status = "EXHAUSTED";
      return { status: "BUDGET_EXHAUSTED" };
    }
    if (run.status !== "READY") return { status: "IN_FLIGHT" };
    this.attempts.set(attemptKey, {
      status: "IN_FLIGHT",
      attemptNonce: identity.attemptNonce,
      checkpointSha256: identity.checkpointSha256,
    });
    run.status = "IN_FLIGHT";
    run.reservationCount += 1;
    return { status: "RESERVED", value: String(run.reservationCount) };
  }

  async commit(identity, { outcome, nextIdentity, status }) {
    const attemptKey = `${identity.runId}:${identity.attemptIndex}`;
    const attempt = this.attempts.get(attemptKey);
    const run = this.runs.get(identity.runId);
    if (!attempt || !run) return { status: "RUN_MISSING" };
    if (attempt.attemptNonce !== identity.attemptNonce || attempt.checkpointSha256 !== identity.checkpointSha256) return { status: "NONCE_CONFLICT" };
    const apply = () => {
      attempt.status = "COMMITTED";
      attempt.cachedBody = JSON.stringify(outcome);
      Object.assign(run, structuredClone(nextIdentity), { status });
    };
    if (this.commitMode === "throw-before-once") {
      this.commitMode = "normal";
      throw new Error("FAKE_COMMIT_RESPONSE_LOST_BEFORE_APPLY");
    }
    if (this.commitMode === "apply-then-throw-once") {
      this.commitMode = "normal";
      apply();
      throw new Error("FAKE_COMMIT_RESPONSE_LOST_AFTER_APPLY");
    }
    apply();
    return { status: "COMMITTED" };
  }

  async markUnknown(identity) {
    const attempt = this.attempts.get(`${identity.runId}:${identity.attemptIndex}`);
    const run = this.runs.get(identity.runId);
    if (!attempt || !run) return { status: "RUN_MISSING" };
    if (attempt.attemptNonce !== identity.attemptNonce || attempt.checkpointSha256 !== identity.checkpointSha256) return { status: "NONCE_CONFLICT" };
    if (attempt.status === "COMMITTED") return { status: "COMMITTED" };
    attempt.status = "UNKNOWN";
    run.status = "UNKNOWN";
    return { status: "UNKNOWN" };
  }
}

function imageLedgerFixture({ failedCalls = 0 } = {}) {
  const body = "这是一段经过用户确认的完整发布正文。".repeat(24);
  const draft = {
    schema: "xiaoshimei.text-draft-response.v1", draft_id: `draft-ledger-${failedCalls}`, created_at: new Date(0).toISOString(),
    source_input: "图片幂等账本", text_requirements: "", prompt_context: {}, pillar: "wellness", goal: "save",
    titles: ["图片幂等账本第一种清楚做法", "图片幂等账本第二种清楚做法", "图片幂等账本第三种清楚做法"], selected_title: "图片幂等账本第一种清楚做法",
    body, tags: ["图片幂等", "图片恢复", "生活方式", "日常记录", "小师妹"], recommended_image_count: 1, facts: [], risks: [], generation: {},
  };
  const unit = {
    unit_id: "page-1-hero", page_index: 0, panel_index: null, media_role: "cover_kv", preferred_aspect: "9:8", fit_policy: "cover",
    visual_action: "小师妹在木桌前整理一只茶杯", image_prompt: "完整人物居中，手部和茶杯清楚",
  };
  const runId = `images-${new Date().toISOString().replace(/[:.]/g, "-")}-a1b2c3d4`;
  let run = createPublicImageRun({
    runId,
    draftId: draft.draft_id,
    draftSha256: sha256Bytes(Buffer.from(JSON.stringify(draft))),
    productionMode: "smart",
    finalPages: [{ pageRole: "cover", eyebrow: "日常", title: "第一页", body: "先把动作做清楚", panels: [] }],
    illustrationUnits: [unit],
    referenceFingerprint: sha256Bytes(Buffer.from(JSON.stringify({ references: [], note: "" }))),
    jobs: [{ sheet_id: "mother-sheet-1", sheet_index: 0, template: "grid-3x3", unit_labels: ["A"], units: [unit], job_kind: "mother_sheet" }],
  });
  for (let call = 0; call < failedCalls; call += 1) run = failPublicImageJob(startPublicImageJob(run), { code: `TEST_${call + 1}` });
  const settings = { apiKey: "test-key-123456", textModel: "text", imageModel: "image", credentialMode: "SERVER_MANAGED" };
  const checkpoint = signPublicImageCheckpoint(run, settings.apiKey);
  const input = { draft, production_mode: "smart", image_count: 1, resume_run_id: run.run_id, resume_checkpoint: checkpoint, reference_images: [], reference_note: "" };
  return { draft, run, settings, checkpoint, input };
}

function accessEnv(code = "open-sesame") {
  return {
    ARK_API_KEY: "server-secret-test-key",
    XIAOSHIMEI_ACCESS_CODE_SHA256: createHash("sha256").update(code).digest("hex"),
    XIAOSHIMEI_SESSION_SECRET: "session-secret-that-is-at-least-thirty-two-characters",
    XIAOSHIMEI_APP_ORIGIN: "https://studio.example",
  };
}

test("cloud provider health is public but never claims a stored key", async () => {
  const previous = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  const response = responseProbe();
  try {
    await handler({ method: "GET", query: { route: "health" }, headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.configured, false);
    assert.equal(response.body.key_store, "当前标签页 sessionStorage");
  } finally {
    if (previous == null) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = previous;
  }
});

test("cloud provider fails closed before an upstream call when BYOK is absent", async () => {
  const previous = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  const response = responseProbe();
  try {
    await handler({ method: "POST", query: { route: "text-draft" }, headers: {}, body: {} }, response);
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, "ARK_API_KEY_REQUIRED");
  } finally {
    if (previous == null) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = previous;
  }
});

test("cloud provider can use one server-managed production key without exposing it to the browser", async () => {
  const previous = process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = "server-secret-test-key";
  const response = responseProbe();
  try {
    await handler({ method: "GET", query: { route: "config" }, headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.configured, true);
    assert.equal(response.body.credential_mode, "SERVER_MANAGED");
    assert.equal(response.body.key_store, "Vercel Sensitive Environment Variable");
    assert.equal(JSON.stringify(response.body).includes("server-secret-test-key"), false);
  } finally {
    if (previous == null) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = previous;
  }
});

test("server-managed access login mints only a signed __Host session after exact-origin admission", async () => {
  const env = accessEnv();
  const nowMs = Date.now();
  const accessHandler = createProviderHandler({ env, nowMs, sessionId: "session-id-for-test" });
  const health = responseProbe();
  await accessHandler({ method: "GET", query: { route: "health" }, headers: {} }, health);
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.configured, true);
  assert.equal(health.body.access_required, true);
  assert.equal(health.body.access_configured, true);
  assert.equal(health.body.authenticated, false);
  assert.equal(JSON.stringify(health.body).includes(env.ARK_API_KEY), false);
  assert.equal(JSON.stringify(health.body).includes(env.XIAOSHIMEI_SESSION_SECRET), false);
  assert.equal(JSON.stringify(health.body).includes(env.XIAOSHIMEI_ACCESS_CODE_SHA256), false);

  const denied = responseProbe();
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: { origin: "https://attacker.example" }, get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, denied);
  assert.equal(denied.statusCode, 403);

  const wrongCode = responseProbe();
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: { origin: env.XIAOSHIMEI_APP_ORIGIN }, body: { code: "wrong" } }, wrongCode);
  assert.equal(wrongCode.statusCode, 401);
  assert.equal(wrongCode.headers["set-cookie"], undefined);

  const login = responseProbe();
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: { origin: env.XIAOSHIMEI_APP_ORIGIN }, body: { code: "open-sesame" } }, login);
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.authenticated, true);
  const setCookie = login.headers["set-cookie"];
  assert.match(setCookie, new RegExp(`^${ACCESS_SESSION_COOKIE}=`));
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.match(setCookie, /; Max-Age=43200/);
  assert.match(setCookie, /; Expires=/);
  assert.equal(setCookie.includes("Domain="), false);

  const cookie = setCookie.split(";", 1)[0];
  const authenticated = responseProbe();
  await accessHandler({ method: "GET", query: { route: "config" }, headers: { cookie } }, authenticated);
  assert.equal(authenticated.body.authenticated, true);
});

test("server-managed business admission rejects session, disabled route, and absent Redis before body parsing or Provider", async () => {
  const env = accessEnv();
  const nowMs = Date.now();
  const accessHandler = createProviderHandler({ env, nowMs, sessionId: "session-id-for-test" });
  const login = responseProbe();
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: { origin: env.XIAOSHIMEI_APP_ORIGIN }, body: { code: "open-sesame" } }, login);
  const cookie = login.headers["set-cookie"].split(";", 1)[0];
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    const crossOrigin = responseProbe();
    await accessHandler({ method: "POST", query: { route: "text-draft" }, headers: { origin: "https://attacker.example", cookie }, get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, crossOrigin);
    assert.equal(crossOrigin.statusCode, 403);

    const anonymous = responseProbe();
    await accessHandler({ method: "POST", query: { route: "text-draft" }, headers: { origin: env.XIAOSHIMEI_APP_ORIGIN }, get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, anonymous);
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.body.error, "ACCESS_SESSION_REQUIRED");

    const candidates = responseProbe();
    await accessHandler({ method: "POST", query: { route: "page-candidates" }, headers: { origin: env.XIAOSHIMEI_APP_ORIGIN, cookie }, get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, candidates);
    assert.equal(candidates.statusCode, 403);
    assert.equal(candidates.body.error, "SERVER_MANAGED_PAGE_CANDIDATES_DISABLED");

    const images = responseProbe();
    await accessHandler({ method: "POST", query: { route: "generate-images" }, headers: { origin: env.XIAOSHIMEI_APP_ORIGIN, cookie }, get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, images);
    assert.equal(images.statusCode, 503);
    assert.equal(images.body.error, "IMAGE_LEDGER_CONFIGURATION_REQUIRED");

    let ledgerCalls = 0;
    const ledgerDownHandler = createProviderHandler({
      env: { ...env, UPSTASH_REDIS_REST_URL: "https://ledger.example", UPSTASH_REDIS_REST_TOKEN: "upstash-token-for-test" },
      nowMs,
      ledgerFetchImpl: async () => { ledgerCalls += 1; return { ok: false, json: async () => ({ error: "DOWN" }) }; },
    });
    const ledgerDown = responseProbe();
    await ledgerDownHandler({ method: "POST", query: { route: "generate-images" }, headers: { origin: env.XIAOSHIMEI_APP_ORIGIN, cookie }, get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, ledgerDown);
    assert.equal(ledgerDown.statusCode, 503);
    assert.equal(ledgerDown.body.error, "IMAGE_LEDGER_UNAVAILABLE");
    assert.equal(ledgerCalls, 1);

    const forged = responseProbe();
    await accessHandler({ method: "POST", query: { route: "text-draft" }, headers: { origin: env.XIAOSHIMEI_APP_ORIGIN, cookie: `${cookie}x` }, get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, forged);
    assert.equal(forged.statusCode, 401);

    const expiredHandler = createProviderHandler({ env, nowMs: nowMs + (ACCESS_SESSION_TTL_SECONDS + 1) * 1000 });
    const expired = responseProbe();
    await expiredHandler({ method: "POST", query: { route: "text-draft" }, headers: { origin: env.XIAOSHIMEI_APP_ORIGIN, cookie }, get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, expired);
    assert.equal(expired.statusCode, 401);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
});

test("public image resume checkpoint is signed and rejects browser tampering", () => {
  const run = createPublicImageRun({
    runId: "images-2026-08-31T08-00-00-000Z-abcdef12",
    draftId: "draft-1",
    draftSha256: "d".repeat(64),
    productionMode: "smart",
    finalPages: [{ title: "第一页" }],
    illustrationUnits: [{ unit_id: "page-1-hero", page_index: 0, panel_index: null }],
    referenceFingerprint: "f".repeat(64),
    jobs: [{ sheet_id: "mother-sheet-1", sheet_index: 0, units: [{ unit_id: "page-1-hero", page_index: 0, panel_index: null }], job_kind: "mother_sheet" }],
  });
  const signed = signPublicImageCheckpoint(run, "test-key-123456");
  assert.equal(verifyPublicImageCheckpoint(signed, "test-key-123456", { draftId: "draft-1" }).run_id, run.run_id);
  assert.throws(() => verifyPublicImageCheckpoint({ ...signed, actual_image_calls: 1 }, "test-key-123456"), /SIGNATURE_INVALID/);
  assert.throws(() => verifyPublicImageCheckpoint({ ...signed, max_image_calls: 60 }, "test-key-123456"), /CALL_LIMIT_INVALID|SIGNATURE_INVALID/);
});

test("the server returns a signed resumable budget error before any seventh upstream image call", async () => {
  const body = "这是一段经过用户确认的完整发布正文。".repeat(24);
  const draft = { schema: "xiaoshimei.text-draft-response.v1", draft_id: "draft-budget", created_at: new Date(0).toISOString(), source_input: "配图预算", text_requirements: "", prompt_context: {}, pillar: "wellness", goal: "save", titles: ["配图预算第一种清楚做法", "配图预算第二种清楚做法", "配图预算第三种清楚做法"], selected_title: "配图预算第一种清楚做法", body, tags: ["配图预算", "图片恢复", "生活方式", "日常记录", "小师妹"], recommended_image_count: 1, facts: [], risks: [], generation: {} };
  const unit = { unit_id: "page-1-hero", page_index: 0, panel_index: null };
  let run = createPublicImageRun({
    runId: "images-2026-08-31T08-00-00-000Z-badf00d1",
    draftId: draft.draft_id,
    draftSha256: sha256Bytes(Buffer.from(JSON.stringify(draft))),
    productionMode: "smart",
    finalPages: [{ title: "第一页" }],
    illustrationUnits: [unit],
    referenceFingerprint: sha256Bytes(Buffer.from(JSON.stringify({ references: [], note: "" }))),
    jobs: [{ sheet_id: "mother-sheet-1", sheet_index: 0, units: [unit], job_kind: "mother_sheet" }],
  });
  for (let call = 0; call < 6; call += 1) run = failPublicImageJob(startPublicImageJob(run), { code: `TEST_${call + 1}` });
  const apiKey = "test-key-123456";
  const signed = signPublicImageCheckpoint(run, apiKey);
  const imageLedger = new FakeAtomicImageLedger();
  await imageLedger.init(imageLedgerIdentity(signed, apiKey));
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    await assert.rejects(
      () => generateImages({ draft, production_mode: "smart", image_count: 1, resume_run_id: run.run_id, resume_checkpoint: signed, reference_images: [], reference_note: "" }, { apiKey, textModel: "text", imageModel: "image", credentialMode: "SERVER_MANAGED" }, { imageLedger }),
      (error) => error.message === "IMAGE_CALL_BUDGET_EXHAUSTED"
        && error.details?.resume_checkpoint?.signature
        && error.details?.remaining_image_calls === 0
        && error.details?.retry_scope === "NO_MORE_PAID_CALLS_IN_THIS_RUN",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
});

test("initial zero-image checkpoint is not returned until its durable run is initialized", async () => {
  const base = imageLedgerFixture();
  const draft = { ...base.draft, draft_id: "draft-ledger-bootstrap", pillar: "academy", source_input: "书院日常记录" };
  const page = {
    page_role: "hook", eyebrow: "书院记录", title: "先把今日动作记下来",
    body: "今天先记录一个清楚动作，后续进展和变化都继续按现实结果更新。",
    visual_action: "小师妹右手握笔书写，左手压住摊开的记录册",
    image_prompt: "傍晚的书院木桌前，小师妹坐下书写今日记录，右手握笔明确落在纸面，左手压住摊开的册页，视线低头看向笔尖，人物手部与记录册完整清楚，暖色侧光，中近景，人物位于画面右侧，上方保留干净空间，不出现文字、水印、边框或第二个人。",
  };
  const imageLedger = new FakeAtomicImageLedger();
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return { ok: true, json: async () => ({ output: [{ type: "function_call", name: "return_xiaoshimei_page_plan", arguments: JSON.stringify({ pages: [page] }) }] }) };
  };
  let initial;
  try {
    initial = await generateImages(
      { draft, production_mode: "smart", image_count: 1, resume_run_id: null, resume_checkpoint: null, reference_images: [], reference_note: "" },
      base.settings,
      { imageLedger },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(initial.status, "PARTIAL");
  assert.equal(initial.resume.actual_image_calls, 0);
  assert.equal(imageLedger.runs.has(initial.resume.resume_run_id), true);
  assert.equal(upstreamCalls, 1);

  imageLedger.runs.delete(initial.resume.resume_run_id);
  let imageUpstreamCalls = 0;
  globalThis.fetch = async () => { imageUpstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    await assert.rejects(
      () => generateImages(
        { draft, production_mode: "smart", image_count: 1, resume_run_id: initial.resume.resume_run_id, resume_checkpoint: initial.resume.resume_checkpoint, reference_images: [], reference_note: "" },
        base.settings,
        { imageLedger },
      ),
      (error) => error.message === "IMAGE_LEDGER_RUN_MISSING",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(imageUpstreamCalls, 0);
});

test("server-managed page planning makes at most one Ark call per HTTP operation", async () => {
  const fixture = imageLedgerFixture();
  const imageLedger = new FakeAtomicImageLedger();
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return { ok: true, json: async () => ({ output: [] }) };
  };
  try {
    await assert.rejects(
      () => generateImages(
        { draft: fixture.draft, production_mode: "smart", image_count: 1, resume_run_id: null, resume_checkpoint: null, reference_images: [], reference_note: "" },
        fixture.settings,
        { imageLedger },
      ),
      /did not return return_xiaoshimei_page_plan|PAGE_PLAN_REJECTED/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 1);
  assert.equal(imageLedger.runs.size, 0);
});

test("an expired signed run fails closed before reserve or image upstream", async () => {
  const fixture = imageLedgerFixture();
  const imageLedger = new FakeAtomicImageLedger();
  const identity = imageLedgerIdentity(fixture.checkpoint, fixture.settings.apiKey);
  await imageLedger.init(identity);
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    await assert.rejects(
      () => generateImages(fixture.input, fixture.settings, { imageLedger, nowMs: identity.expiresAtMs + 1 }),
      (error) => error.message === "IMAGE_LEDGER_RUN_MISSING" && error.details?.reason === "RUN_EXPIRED",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
});

test("same signed image attempt is cached on sequential replay with one upstream call", async () => {
  const fixture = imageLedgerFixture();
  const imageLedger = new FakeAtomicImageLedger();
  await imageLedger.init(imageLedgerIdentity(fixture.checkpoint, fixture.settings.apiKey));
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("FAKE_PROVIDER_FAILURE"); };
  try {
    let firstCode = "";
    await assert.rejects(
      () => generateImages(fixture.input, fixture.settings, { imageLedger }),
      (error) => { firstCode = error.message; return Boolean(error.details?.resume_checkpoint?.signature) && error.details?.current_step_may_replay === true; },
    );
    await assert.rejects(
      () => generateImages(fixture.input, fixture.settings, { imageLedger }),
      (error) => error.message === firstCode && Boolean(error.details?.resume_checkpoint?.signature),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 1);
});

test("concurrent replay and an alternate nonce cannot enter the image upstream twice", async () => {
  const fixture = imageLedgerFixture();
  const imageLedger = new FakeAtomicImageLedger();
  const identity = imageLedgerIdentity(fixture.checkpoint, fixture.settings.apiKey);
  await imageLedger.init(identity);
  let upstreamCalls = 0;
  let announceStarted;
  let releaseUpstream;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const gate = new Promise((resolve) => { releaseUpstream = resolve; });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    announceStarted();
    await gate;
    throw new Error("FAKE_PROVIDER_FAILURE");
  };
  try {
    const first = generateImages(fixture.input, fixture.settings, { imageLedger });
    await started;
    await assert.rejects(
      () => generateImages(fixture.input, fixture.settings, { imageLedger }),
      (error) => error.message === "IMAGE_STEP_IN_FLIGHT",
    );
    const alternate = await imageLedger.reserve({ ...identity, attemptNonce: "f".repeat(64) });
    assert.equal(alternate.status, "NONCE_CONFLICT");
    releaseUpstream();
    await assert.rejects(first, (error) => Boolean(error.details?.resume_checkpoint?.signature));
  } finally {
    releaseUpstream();
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 1);
});

test("reserve followed by a pre-commit crash freezes UNKNOWN and refuses replay", async () => {
  const fixture = imageLedgerFixture();
  const imageLedger = new FakeAtomicImageLedger({ commitMode: "throw-before-once" });
  await imageLedger.init(imageLedgerIdentity(fixture.checkpoint, fixture.settings.apiKey));
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("FAKE_PROVIDER_FAILURE"); };
  try {
    await assert.rejects(
      () => generateImages(fixture.input, fixture.settings, { imageLedger }),
      (error) => error.message === "IMAGE_STEP_UNKNOWN" && error.details?.ledger_status === "UNKNOWN",
    );
    await assert.rejects(
      () => generateImages(fixture.input, fixture.settings, { imageLedger }),
      (error) => error.message === "IMAGE_STEP_UNKNOWN",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 1);
});

test("a lost commit response is recovered only when ledger readback proves COMMITTED", async () => {
  const fixture = imageLedgerFixture();
  const imageLedger = new FakeAtomicImageLedger({ commitMode: "apply-then-throw-once" });
  await imageLedger.init(imageLedgerIdentity(fixture.checkpoint, fixture.settings.apiKey));
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("FAKE_PROVIDER_FAILURE"); };
  try {
    let firstCode = "";
    await assert.rejects(
      () => generateImages(fixture.input, fixture.settings, { imageLedger }),
      (error) => { firstCode = error.message; return Boolean(error.details?.resume_checkpoint?.signature); },
    );
    await assert.rejects(
      () => generateImages(fixture.input, fixture.settings, { imageLedger }),
      (error) => error.message === firstCode,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 1);
});

test("direct Upstash adapter sends only authenticated REST commands and fails closed on ambiguous replies", async () => {
  const seen = [];
  const replies = ["PONG", ["INITIALIZED"], ["RESERVED", "1"], ["COMMITTED"]];
  const imageLedger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    fetchImpl: async (_url, options) => {
      seen.push({ authorization: options.headers.authorization, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ result: replies.shift() }) };
    },
  });
  const fixture = imageLedgerFixture();
  const identity = imageLedgerIdentity(fixture.checkpoint, fixture.settings.apiKey);
  assert.equal(await imageLedger.assertReady(), true);
  assert.equal((await imageLedger.init(identity)).status, "INITIALIZED");
  assert.equal((await imageLedger.reserve(identity)).status, "RESERVED");
  assert.equal((await imageLedger.commit(identity, { outcome: { kind: "SUCCESS", value: { ok: true } }, nextIdentity: identity, status: "READY" })).status, "COMMITTED");
  assert.deepEqual(seen.map((entry) => entry.body[0]), ["PING", "EVAL", "EVAL", "EVAL"]);
  assert.ok(seen.every((entry) => entry.authorization === "Bearer upstash-token-for-test"));
  assert.ok(seen.slice(1).every((entry) => entry.body[0] === "EVAL" && Number(entry.body[2]) >= 1));

  const unavailable = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: null }) }),
  });
  await assert.rejects(() => unavailable.init(identity), /IMAGE_LEDGER_UNAVAILABLE/);
});

test("provider client honors a persisted STOP decision before issuing the next image step", async () => {
  const fixture = imageLedgerFixture();
  let fetches = 0;
  const provider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => ({ schema: "xiaoshimei.public-image-step-response.v1", status: "PARTIAL", resume: { resume_run_id: fixture.run.run_id, resume_checkpoint: fixture.checkpoint, completed_image_steps: 0, total_image_steps: 1 } }) };
    },
  });
  await assert.rejects(
    () => provider.generateImages({ draft: fixture.draft, image_count: 1 }, async () => ({ action: "STOP" })),
    (error) => error.providerCode === "IMAGE_RUN_STOPPED_AFTER_CHECKPOINT"
      && error.checkpointPersisted === true
      && error.intentionalStop === true
      && error.providerDetails?.resume_run_id === fixture.run.run_id,
  );
  assert.equal(fetches, 1);
});

test("page candidate contract accepts browser-local generated assets", () => {
  const src = `data:image/png;base64,${Buffer.from("candidate").toString("base64")}`;
  const candidate = { src, sha256: "a".repeat(64), size_bytes: 2048, width: 768, height: 1024 };
  const result = parsePageCandidateResponse({ schema: PAGE_CANDIDATE_RESPONSE_SCHEMA, run_id: "candidate-web-test", candidates: [candidate, candidate, candidate] });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].src, src);
});

test("cloud provider turns one mother sheet into independent trimmed browser assets", async () => {
  const cellWidth = 300;
  const cellHeight = 400;
  const cells = Array.from({ length: 9 }, (_, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const hue = index * 37;
    return `<g transform="translate(${column * cellWidth} ${row * cellHeight})">
      <rect width="${cellWidth}" height="${cellHeight}" fill="white"/>
      <rect x="12" y="12" width="276" height="376" rx="28" fill="hsl(${hue} 70% 55%)"/>
      <circle cx="150" cy="170" r="92" fill="hsl(${(hue + 170) % 360} 72% 38%)"/>
      <path d="M55 330 L150 240 L245 330" fill="none" stroke="#172b2a" stroke-width="22"/>
    </g>`;
  }).join("");
  const sheet = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">${cells}</svg>`)).jpeg({ quality: 92 }).toBuffer();
  const units = [0, 1, 2, 3].map((index) => ({
    unit_id: `page-${index + 1}-hero`, page_index: index, panel_index: null,
    media_role: "hero_scene", preferred_aspect: "3:4", fit_policy: "cover",
  }));
  const job = groupIllustrationUnits(units)[0];
  const tiles = await splitMotherSheetForUnits(sheet, job);
  assert.equal(tiles.length, units.length);
  assert.equal(new Set(tiles.map((tile) => tile.src)).size, units.length);
  assert.equal(new Set(tiles.map((tile) => tile.sha256)).size, units.length);
  for (const [index, tile] of tiles.entries()) {
    assert.match(tile.src, /^data:image\/jpeg;base64,/);
    assert.ok(tile.size_bytes < sheet.length);
    assert.ok(Math.abs(tile.width / tile.height - (index === 0 ? 1.125 : .75)) < .012);
    assert.equal(tile.presence_gate.hasVisibleSubject, true);
  }
  assert.equal(tiles[0].mother_sheet_region_role, "kv-top-adaptive-9:8");
  assert.equal(tiles[0].preferred_aspect, "9:8");
  assert.ok(tiles[0].adaptive_boundary.coordinate > 560 && tiles[0].adaptive_boundary.coordinate < 900);
  assert.ok(tiles[0].height < tiles[1].height);
});

test("cloud provider follows the rendered KV boundary instead of fixed thirds", async () => {
  const width = 900; const height = 1200; const boundary = 660;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="900" height="660" fill="#efc18d"/><circle cx="300" cy="330" r="180" fill="#8e2f25"/>
    <rect y="660" width="900" height="12" fill="#ffffff"/>
    ${[0, 1, 2].map((index) => `<g transform="translate(${index * 300} 672)"><rect width="300" height="400" fill="#ffffff"/><circle cx="150" cy="130" r="85" fill="hsl(${index * 90} 65% 42%)"/><rect x="95" y="220" width="110" height="145" fill="#d9783c"/></g>`).join("")}
  </svg>`;
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  const units = [0, 1, 2, 3].map((index) => ({ unit_id: `adaptive-${index}`, page_index: index, panel_index: null, media_role: "hero_scene", preferred_aspect: index ? "3:4" : "9:8", fit_policy: "cover" }));
  const tiles = await splitMotherSheetForUnits(bytes, groupIllustrationUnits(units)[0]);
  assert.ok(Math.abs(tiles[0].adaptive_boundary.coordinate - boundary) < 24);
  assert.deepEqual(tiles.map((tile) => [tile.width, tile.height]), [[720, 640], [720, 960], [720, 960], [720, 960]]);
  assert.ok(tiles.every((tile) => tile.pixel_gate.hasCleanEdges));
});

test("cloud mother-sheet tiles stay inside the public response transport budget", async () => {
  const width = 900;
  const height = 1200;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 73 + Math.floor(index / 97) * 29) % 256;
  const sheet = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const units = Array.from({ length: 9 }, (_, index) => ({
    unit_id: `unit-${index}`, page_index: index, panel_index: null,
    media_role: "hero_scene", preferred_aspect: "3:4", fit_policy: "cover",
  }));
  const budget = 90_000;
  const tiles = await splitMotherSheetForUnits(sheet, { template: "grid-3x3", units }, { maxBytes: budget });
  assert.equal(tiles.length, 9);
  tiles.forEach((tile) => assert.ok(tile.size_bytes <= budget, `${tile.unit_id} is ${tile.size_bytes} bytes`));
});

test("cloud mother-sheet slicing preserves missing-unit evidence for bounded repair", async () => {
  const blank = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "white" } }).jpeg().toBuffer();
  const units = [
    { unit_id: "page-1-hero", page_index: 0, panel_index: null, preferred_aspect: "9:8", media_role: "cover_kv", fit_policy: "cover" },
    { unit_id: "page-4-hero", page_index: 3, panel_index: null, preferred_aspect: "3:4", media_role: "hero_scene", fit_policy: "cover" },
  ];
  const tiles = await splitMotherSheetForUnits(blank, { template: "grid-3x3", units }, { allowMissing: true });
  assert.deepEqual(tiles.map((tile) => tile.missing), [true, true]);
  await assert.rejects(() => splitMotherSheetForUnits(blank, { template: "grid-3x3", units }), /MOTHER_SHEET_UNIT_MISSING/);
  const jobs = buildMissingUnitRepairJobs(units, 2);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].template, "kv-top-3x2");
  assert.equal(jobs[1].template, "grid-3x3");
  assert.equal(jobs[1].units[0].unit_id, "page-4-hero");
});

test("cloud single-unit repair avoids paying for a sparse 3x3 mother sheet", async () => {
  const unit = {
    unit_id: "page-4-panel-1", page_index: 3, panel_index: 0,
    media_role: "inline_sticker", preferred_aspect: "3:4", fit_policy: "contain",
    visual_action: "小师妹把桌面上的书本竖直归拢到木质书立旁",
    image_prompt: "完整人物与书本都在画面中央，手部动作清楚",
  };
  const prompt = buildStandaloneRepairPrompt(unit);
  assert.match(prompt, /不是母图、不是拼图、不是网格/);
  assert.match(prompt, /page-4-panel-1/);
  assert.match(prompt, /竖直归拢/);
  const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="white"/><circle cx="450" cy="360" r="180" fill="#b94035"/><rect x="300" y="520" width="300" height="480" rx="80" fill="#d79b55"/></svg>`)).jpeg({ quality: 92 }).toBuffer();
  const tile = await sliceStandaloneRepairForUnit(image, unit, { maxBytes: 100_000 });
  assert.equal(tile.unit_id, unit.unit_id);
  assert.equal(tile.repair_source, "standalone-image");
  assert.equal(tile.missing, undefined);
  assert.ok(Math.abs(tile.width / tile.height - .75) < .012);
  assert.ok(tile.size_bytes <= 100_000);
  const blank = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "white" } }).jpeg().toBuffer();
  const missing = await sliceStandaloneRepairForUnit(blank, unit, { allowMissing: true });
  assert.equal(missing.missing, true);
  assert.equal(missing.repair_failure_reason, "VISUAL_SUBJECT_MISSING");
});

test("cloud response budget fails closed before a browser receives an oversized JSON body", () => {
  const withinBudget = { payload: "a".repeat(32_000) };
  assert.ok(assertPublicGenerationResponseBudget(withinBudget) > 32_000);
  assert.throws(
    () => assertPublicGenerationResponseBudget({ payload: "a".repeat(PUBLIC_GENERATION_RESPONSE_MAX_BYTES + 1) }),
    /PUBLIC_RESPONSE_BUDGET_EXCEEDED/,
  );
  assert.ok(publicTileBudgetForResponse(24) < publicTileBudgetForResponse(4));
  assert.ok(publicTileBudgetForResponse(24) * 24 <= 2_300_000);
});
