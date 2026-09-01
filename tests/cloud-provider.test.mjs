import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";
import handler from "../api/provider.mjs";
import * as providerModule from "../api/provider.mjs";
import {
  ACCESS_SESSION_COOKIE,
  ACCESS_SESSION_TTL_SECONDS,
  PUBLIC_GENERATION_RESPONSE_MAX_BYTES,
  assertPublicGenerationResponseBudget,
  buildMissingUnitRepairJobs,
  buildStandaloneRepairPrompt,
  createProviderHandler,
  createUpstashImageLedger,
  createUpstashImageLedgerFromEnv,
  generateImages,
  imageLedgerIdentity,
  inspectAccessSessionCandidates,
  inspectServerAccessConfig,
  mintAccessSession,
  publicTileBudgetForResponse,
  signPublicImageCheckpoint,
  sliceStandaloneRepairForUnit,
  splitMotherSheetForUnits,
  verifyAccessSession,
  verifyPublicImageCheckpoint,
} from "../api/provider.mjs";
import {
  buildAndInstallAttestation,
  canonicalJson as canonicalAttestationJson,
} from "../scripts/attest-upstash-image-ledger.mjs";
import { groupIllustrationUnits } from "../src/mother-sheet.mjs";
import { computeImageGenerationInputSha256, parsePageCandidateResponse, PAGE_CANDIDATE_RESPONSE_SCHEMA } from "../src/provider-contract.mjs";
import { sha256Bytes } from "../src/ark-provider-core.mjs";
import { admitPublicImageJob, createPublicImageRun, failPublicImageJob, startPublicImageJob } from "../src/public-image-run.mjs";
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
    end(value = null) { this.body = value; return this; },
    send(value = null) { this.body = value; return this; },
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

function d36Field(value, ...names) {
  for (const name of names) {
    if (value && Object.prototype.hasOwnProperty.call(value, name)) return value[name];
  }
  return undefined;
}

function d36Error(code, details = {}) {
  const error = new Error(code);
  error.details = details;
  return error;
}

class FakeD36ImageLedger {
  constructor({ readiness = {}, commitMode = "normal", retainPhysicalKeys = false, events = [] } = {}) {
    this.readiness = {
      eviction: "off",
      autoUpgrade: "off",
      foreignKeys: 0,
      usage: "KNOWN",
      calibration: "PASS",
      ...readiness,
    };
    this.commitMode = commitMode;
    this.retainPhysicalKeys = retainPhysicalKeys;
    this.events = events;
    this.runs = new Map();
    this.bootstrap = new Map();
    this.assets = new Map();
    this.steps = new Map();
    this.releasedRuns = new Set();
    this.readAssetCalls = 0;
  }

  async assertProductionReady() {
    this.events.push("ledger:readiness");
    const value = this.readiness;
    const reason = value.eviction !== "off" ? "EVICTION_NOT_OFF"
      : value.autoUpgrade !== "off" ? "AUTO_UPGRADE_NOT_OFF"
        : value.foreignKeys !== 0 ? "FOREIGN_KEYS_PRESENT"
          : value.usage !== "KNOWN" ? "USAGE_UNKNOWN"
            : value.calibration !== "PASS" ? "CALIBRATION_UNKNOWN"
              : null;
    if (reason) throw d36Error(`IMAGE_LEDGER_PRODUCTION_NOT_READY:${reason}`);
    return { status: "READY", redis_time_ms: 1_788_192_000_000 };
  }

  async claimStart(value = {}) {
    this.events.push("ledger:claimStart");
    const appScopeId = String(d36Field(value, "appScopeId", "app_scope_id") || "");
    const bootstrapNonce = String(d36Field(value, "bootstrapNonce", "bootstrap_nonce") || "");
    const inputSha256 = String(d36Field(value, "inputSha256", "input_sha256") || "");
    const key = `${appScopeId}:${bootstrapNonce}`;
    const existingId = this.bootstrap.get(key);
    if (existingId) {
      const existing = this.runs.get(existingId);
      if (existing.inputSha256 !== inputSha256) return { status: "CONFLICT", runId: existingId };
      return { status: existing.status, runId: existingId, ownerToken: existing.ownerToken, fence: existing.fence, cached: true };
    }
    const runId = String(d36Field(value, "runId", "run_id") || `image-run-d36-${bootstrapNonce.slice(0, 12)}`);
    const run = {
      runId,
      appScopeId,
      bootstrapNonce,
      inputSha256,
      status: "MATERIALIZING",
      ownerToken: `owner-${bootstrapNonce.slice(0, 12)}`,
      fence: 1,
      paidCalls: 0,
      checkpointPreimage: null,
      checkpointPreimageSha256: null,
      logicalStepId: "planner",
      recoverableUntil: "2026-09-08T00:00:00.000Z",
      snapshot: structuredClone(d36Field(value, "snapshot") || null),
      referenceManifest: structuredClone(d36Field(value, "referenceManifest", "reference_manifest") || []),
      compactRun: null,
    };
    this.bootstrap.set(key, runId);
    this.runs.set(runId, run);
    return { status: "MATERIALIZING", runId, ownerToken: run.ownerToken, fence: run.fence, recoverableUntil: run.recoverableUntil };
  }

  async putRunAsset(value = {}) {
    this.events.push("ledger:putRunAsset");
    const runId = String(d36Field(value, "runId", "run_id") || "");
    const manifest = d36Field(value, "manifest") || value;
    const expectedSha = String(d36Field(manifest, "sha256") || "");
    const bytes = Buffer.from(d36Field(value, "bytes", "exactBytes", "exact_bytes") || []);
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    if (!this.runs.has(runId)) throw d36Error("IMAGE_LEDGER_RUN_MISSING");
    if (expectedSha !== actualSha) throw d36Error("IMAGE_ASSET_HASH_MISMATCH");
    const key = `${runId}:${actualSha}`;
    if (!this.assets.has(key)) this.assets.set(key, {
      runId,
      sha256: actualSha,
      bytes,
      mime: String(d36Field(manifest, "mime") || "image/jpeg"),
      sizeBytes: bytes.length,
      manifest: structuredClone(manifest),
      member: true,
    });
    return { status: "STORED", runId, sha256: actualSha, sizeBytes: bytes.length, manifest: structuredClone(manifest) };
  }

  async readRunAsset(value = {}) {
    this.events.push("ledger:readRunAsset");
    const runId = String(d36Field(value, "runId", "run_id") || "");
    const sha256 = String(d36Field(value, "sha256") || "");
    const asset = this.assets.get(`${runId}:${sha256}`);
    if (!asset) return { status: "MISSING" };
    const actualSha = createHash("sha256").update(asset.bytes).digest("hex");
    if (actualSha !== asset.sha256 || asset.bytes.length !== asset.sizeBytes) return { status: "CORRUPT" };
    return { status: "FOUND", ...structuredClone(asset) };
  }

  async claimPlanner(value = {}) {
    this.events.push("ledger:claimPlanner");
    const runId = String(d36Field(value, "runId", "run_id") || "");
    const run = this.runs.get(runId);
    if (!run) return { status: "RUN_MISSING" };
    if (run.status === "READY") return { status: "CACHED", runId, checkpointPreimage: run.checkpointPreimage, checkpointPreimageSha256: run.checkpointPreimageSha256 };
    if (run.status === "UNKNOWN") return { status: "UNKNOWN", runId };
    run.status = "PLANNING";
    return { status: "PLANNING", runId, ownerToken: run.ownerToken, fence: run.fence };
  }

  async markPlannerFailed(value = {}) {
    this.events.push("ledger:markPlannerFailed");
    const runId = String(d36Field(value, "runId", "run_id") || "");
    const run = this.runs.get(runId);
    if (!run || run.status !== "PLANNING") return { status: "CONFLICT" };
    run.status = "PLANNER_FAILED";
    run.plannerFailureCode = String(d36Field(value, "errorCode", "error_code") || "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS");
    run.cachedResponse = structuredClone(d36Field(value, "response") || null);
    return { status: "COMMITTED" };
  }

  async markPlannerUnknown(value = {}) {
    this.events.push("ledger:markPlannerUnknown");
    const runId = String(d36Field(value, "runId", "run_id") || "");
    const run = this.runs.get(runId);
    if (!run || run.status !== "PLANNING") return { status: "CONFLICT" };
    run.status = "UNKNOWN";
    return { status: "UNKNOWN" };
  }

  async commitPlanner(value = {}) {
    this.events.push("ledger:commitPlanner");
    const runId = String(d36Field(value, "runId", "run_id") || "");
    const run = this.runs.get(runId);
    if (!run) return { status: "RUN_MISSING" };
    run.status = "READY";
    run.checkpointPreimage = structuredClone(d36Field(value, "checkpointPreimage", "checkpoint_preimage") || { schema: "xiaoshimei.image-checkpoint.v1", cursor: 0 });
    run.checkpointPreimageSha256 = String(d36Field(value, "checkpointPreimageSha256", "checkpoint_preimage_sha256") || createHash("sha256").update(JSON.stringify(run.checkpointPreimage)).digest("hex"));
    run.logicalStepId = String(d36Field(value, "logicalStepId", "logical_step_id") || "render-step-1");
    run.plannerResult = structuredClone(d36Field(value, "plannerResult", "planner_result", "compactRun", "compact_run") || null);
    run.compactRun = structuredClone(d36Field(value, "compactRun", "compact_run", "plannerResult", "planner_result") || null);
    run.cachedResponse = structuredClone(d36Field(value, "response") || null);
    return { status: "COMMITTED", runId, checkpointPreimage: run.checkpointPreimage, checkpointPreimageSha256: run.checkpointPreimageSha256, logicalStepId: run.logicalStepId };
  }

  async discover(value = {}) {
    this.events.push("ledger:discover");
    const appScopeId = String(d36Field(value, "appScopeId", "app_scope_id") || "");
    const bootstrapNonce = String(d36Field(value, "bootstrapNonce", "bootstrap_nonce") || "");
    const inputSha256 = String(d36Field(value, "inputSha256", "input_sha256") || "");
    const explicitRunId = String(d36Field(value, "runId", "run_id") || "");
    const runId = explicitRunId || this.bootstrap.get(`${appScopeId}:${bootstrapNonce}`);
    if (!runId) return { status: "RUN_MISSING" };
    const run = this.runs.get(runId);
    if (!run || run.appScopeId !== appScopeId) return { status: "CONFLICT", runId };
    if (inputSha256 && run.inputSha256 !== inputSha256) return { status: "CONFLICT", runId };
    if (bootstrapNonce && run.bootstrapNonce !== bootstrapNonce) return { status: "CONFLICT", runId };
    return {
      status: run.status,
      runId,
      checkpointPreimage: structuredClone(run.checkpointPreimage || {}),
      checkpointPreimageSha256: run.checkpointPreimageSha256,
      logicalStepId: run.logicalStepId,
      recoverableUntil: run.recoverableUntil,
      cached: run.status === "READY" || run.status === "COMPLETE",
      cachedResponse: structuredClone(run.cachedResponse || null),
      bootstrapNonce: run.bootstrapNonce,
      inputSha256: run.inputSha256,
      snapshot: structuredClone(run.snapshot || null),
      referenceManifest: structuredClone(run.referenceManifest || []),
      compactRun: structuredClone(run.compactRun || null),
      plannerFailureCode: run.plannerFailureCode || null,
    };
  }

  seedReadyRun({ runId = "image-run-d36-seeded", checkpointPreimage = { schema: "xiaoshimei.image-checkpoint.v1", cursor: 0 }, checkpointPreimageSha256 = null, logicalStepId = "render-step-1", paidCalls = 0 } = {}) {
    const suffix = createHash("sha256").update(runId).digest("hex").slice(0, 8);
    const resolvedRunId = `images-2026-09-01T00-00-00-000Z-${suffix}`;
    const unit = { unit_id: "page-1-hero", page_index: 0, panel_index: null, media_role: "cover_kv", preferred_aspect: "9:8", fit_policy: "cover", visual_action: "小师妹右手握笔书写", image_prompt: d36PlannerPage().image_prompt };
    const compactRun = createPublicImageRun({
      runId: resolvedRunId,
      draftId: "draft-d36-contract",
      draftSha256: "7".repeat(64),
      productionMode: "smart",
      finalPages: [{ pageRole: "hook", eyebrow: "书院记录", title: "先把今日动作记下来", body: "今天先记录一个清楚动作。", panels: [], visualAction: unit.visual_action, imagePrompt: unit.image_prompt }],
      illustrationUnits: [unit],
      referenceFingerprint: "6".repeat(64),
      jobs: [{ sheet_id: "mother-sheet-1", sheet_index: 0, template: "grid-3x3", kv_unit_index: 0, unit_labels: ["A"], units: [unit], job_kind: "mother_sheet" }],
    });
    const signedCheckpoint = checkpointPreimageSha256
      ? checkpointPreimage
      : providerModule.createImageTransactionCheckpoint(compactRun, D36_SETTINGS.apiKey);
    const sha = checkpointPreimageSha256 || providerModule.imageTransactionCheckpointSha256(signedCheckpoint);
    const nextLogicalStepId = checkpointPreimageSha256 ? logicalStepId : "render-job-01";
    this.runs.set(resolvedRunId, {
      runId: resolvedRunId,
      appScopeId: "xiaoshimei-test-scope",
      bootstrapNonce: "9".repeat(64),
      inputSha256: "8".repeat(64),
      status: "READY",
      ownerToken: `owner-${runId}`,
      fence: 1,
      paidCalls,
      checkpointPreimage: structuredClone(signedCheckpoint),
      checkpointPreimageSha256: sha,
      logicalStepId: nextLogicalStepId,
      recoverableUntil: "2026-09-08T00:00:00.000Z",
      plannerResult: { pages: [d36PlannerPage()] },
      compactRun,
      snapshot: {
        schema: "xiaoshimei.image-operation-snapshot.v1",
        draft_record_id: "draft-record-d36-contract",
        mutation_epoch: 1,
        confirmed_draft: d36ConfirmedDraft(),
        page_count: 1,
        production_mode: "smart",
        reference_note: "",
      },
      referenceManifest: [],
    });
    return this.runs.get(resolvedRunId);
  }

  async reserveStep(value = {}) {
    this.events.push("ledger:reserveStep");
    const runId = String(d36Field(value, "runId", "run_id") || "");
    const checkpointSha = String(d36Field(value, "checkpointPreimageSha256", "checkpoint_preimage_sha256") || "");
    const logicalStepId = String(d36Field(value, "logicalStepId", "logical_step_id") || "");
    const attemptNonce = String(d36Field(value, "attemptNonce", "attempt_nonce") || "");
    const nowMs = Number(d36Field(value, "nowMs", "now_ms") || Date.now());
    const leaseMs = Number(d36Field(value, "leaseMs", "lease_ms") || 360_000);
    const run = this.runs.get(runId);
    if (!run) return { status: "RUN_MISSING" };
    if (run.status === "UNKNOWN") return { status: "UNKNOWN" };
    if (run.checkpointPreimageSha256 !== checkpointSha || run.logicalStepId !== logicalStepId) return { status: "CHECKPOINT_CONFLICT" };
    const actionId = `${runId}:${checkpointSha}:${logicalStepId}`;
    const current = this.steps.get(actionId);
    if (current) {
      if (current.attemptNonce !== attemptNonce) return { status: "NONCE_CONFLICT", actionId };
      if (current.status === "COMMITTED") return { status: "CACHED", actionId, cachedResponse: structuredClone(current.cachedResult) };
      if (current.status === "UNKNOWN") return { status: "UNKNOWN", actionId };
      if (nowMs - current.reservedAtMs > leaseMs) {
        current.status = "UNKNOWN";
        run.status = "UNKNOWN";
        return { status: "UNKNOWN", actionId };
      }
      return { status: "IN_FLIGHT", actionId };
    }
    if (run.paidCalls >= 6) return { status: "BUDGET_EXHAUSTED" };
    const step = { actionId, runId, checkpointSha, logicalStepId, attemptNonce, status: "IN_FLIGHT", ownerToken: `step-owner-${attemptNonce.slice(0, 12)}`, fence: 1, reservedAtMs: nowMs, cachedResult: null };
    this.steps.set(actionId, step);
    run.status = "IN_FLIGHT";
    run.paidCalls += 1;
    return { status: "RESERVED", actionId, ownerToken: step.ownerToken, fence: step.fence };
  }

  async commitStep(value = {}) {
    this.events.push("ledger:commitStep");
    const actionId = String(d36Field(value, "actionId", "action_id") || "");
    const step = this.steps.get(actionId);
    if (!step) return { status: "RUN_MISSING" };
    const apply = () => {
      step.status = "COMMITTED";
      step.cachedResult = structuredClone(d36Field(value, "response", "result", "outcome", "cachedResult", "cached_result") || null);
      const run = this.runs.get(step.runId);
      if (run && run.status !== "UNKNOWN") run.status = String(d36Field(value, "runStatus", "run_status") || "READY");
    };
    if (this.commitMode === "throw-before-once") {
      this.commitMode = "normal";
      throw d36Error("FAKE_D36_COMMIT_LOST_BEFORE_APPLY");
    }
    if (this.commitMode === "apply-then-throw-once") {
      this.commitMode = "normal";
      apply();
      throw d36Error("FAKE_D36_COMMIT_LOST_AFTER_APPLY");
    }
    apply();
    return { status: "COMMITTED", actionId };
  }

  async markStepUnknown(value = {}) {
    this.events.push("ledger:markStepUnknown");
    const actionId = String(d36Field(value, "actionId", "action_id") || "");
    const step = this.steps.get(actionId);
    if (!step) return { status: "RUN_MISSING" };
    if (step.status === "COMMITTED") return { status: "COMMITTED", cachedResponse: structuredClone(step.cachedResult) };
    step.status = "UNKNOWN";
    const run = this.runs.get(step.runId);
    if (run) run.status = "UNKNOWN";
    return { status: "UNKNOWN" };
  }

  seedInflightStep(input, { reservedAtMs = 0 } = {}) {
    const run = this.runs.get(input.run_id);
    const actionId = `${input.run_id}:${input.checkpoint_preimage_sha256}:${input.logical_step_id}`;
    this.steps.set(actionId, { actionId, runId: input.run_id, checkpointSha: input.checkpoint_preimage_sha256, logicalStepId: input.logical_step_id, attemptNonce: input.attempt_nonce, status: "IN_FLIGHT", ownerToken: "old-owner", fence: 1, reservedAtMs, cachedResult: null });
    if (run) run.status = "IN_FLIGHT";
    return actionId;
  }

  async readAsset(value = {}) {
    this.readAssetCalls += 1;
    this.events.push("ledger:readAsset");
    const appScopeId = String(d36Field(value, "appScopeId", "app_scope_id") || "");
    const runId = String(d36Field(value, "runId", "run_id") || "");
    const sha256 = String(d36Field(value, "sha256") || "");
    const run = this.runs.get(runId);
    const asset = this.assets.get(`${runId}:${sha256}`);
    if (!run) return { status: "RUN_MISSING" };
    if (run.appScopeId !== appScopeId) return { status: "FORBIDDEN" };
    if (!asset?.member) return { status: "NOT_MEMBER" };
    const actual = createHash("sha256").update(asset.bytes).digest("hex");
    if (actual !== sha256 || asset.bytes.length !== asset.sizeBytes) return { status: "CORRUPT" };
    return { status: "FOUND", bytes: Buffer.from(asset.bytes), manifest: structuredClone(asset.manifest) };
  }

  async cleanupRun(value = {}) {
    this.events.push("ledger:cleanup:DEL");
    const runId = String(d36Field(value, "runId", "run_id") || "");
    if (!this.retainPhysicalKeys) {
      for (const key of [...this.assets.keys()]) if (key.startsWith(`${runId}:`)) this.assets.delete(key);
    }
    this.events.push("ledger:cleanup:ABSENCE_READBACK");
    const retained = [...this.assets.keys()].some((key) => key.startsWith(`${runId}:`));
    if (retained) return { status: "PHYSICAL_KEYS_RETAINED", released: false };
    this.events.push("ledger:cleanup:RELEASE_CAPACITY");
    this.releasedRuns.add(runId);
    this.runs.delete(runId);
    return { status: "RELEASED", released: true };
  }
}

function d36PlannerPage() {
  return {
    page_role: "hook",
    eyebrow: "书院记录",
    title: "先把今日动作记下来",
    body: "今天先记录一个清楚动作，后续进展和变化都继续按现实结果更新。",
    visual_action: "小师妹右手握笔书写，左手压住摊开的记录册",
    image_prompt: "傍晚的书院木桌前，小师妹坐下书写今日记录，右手握笔明确落在纸面，左手压住摊开的册页，视线低头看向笔尖，人物手部与记录册完整清楚，暖色侧光，中近景，人物位于画面右侧，上方保留干净空间，不出现文字、水印、边框或第二个人。",
  };
}

function d36ConfirmedDraft(overrides = {}) {
  return {
    draft_id: "draft-d36-contract",
    source_input: "书院日常记录",
    pillar: "academy",
    goal: "save",
    titles: ["先把今日动作记下来", "今日书院记录的三个步骤", "把日常进展写成一份记录"],
    selected_title: "先把今日动作记下来",
    body: "这是一段经过用户确认的完整发布正文。".repeat(24),
    tags: ["书院记录", "日常行动", "生活方式", "小师妹", "今日复盘"],
    recommended_image_count: 1,
    facts: [],
    risks: [],
    content_type: "knowledge_card",
    style_lock: null,
    prompt_context: {},
    ...overrides,
  };
}

async function d36ReferenceBytes() {
  const width = 96;
  const height = 128;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 67 + Math.floor(index / 31) * 19) % 256;
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

async function d36StartInput({ nonce = "a".repeat(64), operationOverrides = {}, includeMedia = true, referenceBytes = null, manifestSha = null } = {}) {
  const bytes = referenceBytes || await d36ReferenceBytes();
  const sha256 = manifestSha || createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    schema: "xiaoshimei.media-asset-manifest.v1",
    media_ref: `xiaoshimei-media://sha256/${sha256}`,
    sha256,
    size_bytes: bytes.length,
    mime: "image/jpeg",
    name: "动作参考",
    width: 96,
    height: 128,
  };
  const operationSnapshot = {
    schema: "xiaoshimei.image-operation-snapshot.v1",
    draft_record_id: "draft-record-d36-contract",
    mutation_epoch: 1,
    confirmed_draft: d36ConfirmedDraft(),
    page_count: 1,
    production_mode: "smart",
    reference_note: "参考握笔和手部关系",
    ...operationOverrides,
  };
  const inputSha256 = await computeImageGenerationInputSha256({ operation_snapshot: operationSnapshot, reference_manifest: [manifest] });
  return {
    mode: "START",
    bootstrap_nonce: nonce,
    operation_snapshot: operationSnapshot,
    input_sha256: inputSha256,
    reference_manifest: [manifest],
    missing_reference_media: includeMedia ? [{ media_ref: manifest.media_ref, sha256, size_bytes: bytes.length, mime: "image/jpeg", bytes_base64: bytes.toString("base64") }] : [],
  };
}

function d36StepInput(run, overrides = {}) {
  return {
    mode: "STEP",
    run_id: run.runId,
    checkpoint_preimage: structuredClone(run.checkpointPreimage),
    checkpoint_preimage_sha256: run.checkpointPreimageSha256,
    logical_step_id: run.logicalStepId,
    attempt_nonce: "e".repeat(64),
    ...overrides,
  };
}

async function seedD41CoveredNarrativeRun(imageLedger) {
  const pages = [
    {
      pageRole: "hook",
      shotRole: "scene",
      highlightPhrases: ["今日动作"],
      eyebrow: "书院日常记录",
      title: "先把今日动作记下来",
      body: "从一个看得见的日常动作开始，留下今天真实发生的书院记录。",
      visualAction: "小师妹右手握笔书写，左手压住摊开的记录册",
      imagePrompt: d36PlannerPage().image_prompt,
      panels: [],
    },
    {
      pageRole: "example",
      shotRole: "action",
      highlightPhrases: ["按发生顺序"],
      eyebrow: "记录时只做三件事",
      title: "按发生顺序写清楚",
      body: "先写今天做了什么，再记下现场出现的变化，最后补上下一步。只写已经发生的事实，不把筹备中的想法提前说成结果。",
      visualAction: "小师妹翻动记录册并依次检查三行手写内容",
      imagePrompt: "书院木桌前，小师妹翻动摊开的记录册，右手食指依次检查三行手写内容，左手扶住册页，视线落在纸面，人物与双手清楚完整，暖色侧光，中近景，画面不出现可读文字、水印、边框或第二个人。",
      panels: [
        { title: "先记动作", body: "把今天已经完成的动作按顺序写清楚。", visualAction: "小师妹右手握笔在记录册第一行书写", contentRole: "hero", shotRole: "action", highlightPhrases: ["先记动作"] },
        { title: "再记变化", body: "把现场真正出现的变化紧接着补充完整。", visualAction: "小师妹用手指检查记录册第二行内容", contentRole: "support", shotRole: "detail", highlightPhrases: ["再记变化"] },
        { title: "补下一步", body: "只写下一件准备执行并能回读的具体行动。", visualAction: "小师妹把书签夹到记录册下一页", contentRole: "support", shotRole: "action", highlightPhrases: ["补下一步"] },
        { title: "不抢跑", body: "筹备想法仍按想法标注，不提前包装成结果。", visualAction: "小师妹把待核验便签放在记录册旁边", contentRole: "detail", shotRole: "scene", highlightPhrases: ["不抢跑"] },
      ],
    },
  ];
  const units = [
    { unit_id: "page-1-hero", page_index: 0, panel_index: null, media_role: "cover_kv", preferred_aspect: "9:8", fit_policy: "cover", visual_action: pages[0].visualAction, image_prompt: pages[0].imagePrompt },
    ...pages[1].panels.map((panel, panelIndex) => ({ unit_id: `page-2-panel-${panelIndex + 1}`, page_index: 1, panel_index: panelIndex, media_role: "inline_sticker", preferred_aspect: "3:4", fit_policy: "contain", visual_action: panel.visualAction, image_prompt: pages[1].imagePrompt })),
  ];
  let hydratedRun = createPublicImageRun({
    runId: "images-2026-09-01T11-35-57-000Z-d41d41d4",
    draftId: "draft-d36-contract",
    draftSha256: "7".repeat(64),
    productionMode: "narrative",
    finalPages: pages,
    illustrationUnits: units,
    planAttempts: [{ attempt: 1, status: "PASS" }],
    referenceFingerprint: "6".repeat(64),
    jobs: groupIllustrationUnits(units).map((job) => ({ ...job, job_kind: "mother_sheet" })),
  });
  const assetBytes = await Promise.all(units.slice(0, 4).map(async (_unit, assetIndex) => {
    const pixels = Buffer.alloc(96 * 128 * 3);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * (67 + assetIndex * 4) + Math.floor(index / 31) * 19 + assetIndex * 23) % 256;
    return sharp(pixels, { raw: { width: 96, height: 128, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  }));
  const assets = units.slice(0, 4).map((unit, assetIndex) => {
    const bytes = assetBytes[assetIndex];
    return { ...unit, src: `data:image/jpeg;base64,${bytes.toString("base64")}`, sha256: createHash("sha256").update(bytes).digest("hex"), size_bytes: bytes.length, width: 96, height: 128 };
  });
  const sourceSha256 = createHash("sha256").update(Buffer.concat(assetBytes)).digest("hex");
  hydratedRun = admitPublicImageJob(startPublicImageJob(hydratedRun), { assets, attempt: { image_sha256: sourceSha256, image_size_bytes: assetBytes.reduce((sum, bytes) => sum + bytes.length, 0) } });
  const compactRun = { ...hydratedRun, assets: hydratedRun.assets.map((asset) => ({ ...asset, src: `xiaoshimei-media://sha256/${asset.sha256}` })) };
  const checkpointPreimage = providerModule.createImageTransactionCheckpoint(compactRun, D36_SETTINGS.apiKey);
  const checkpointPreimageSha256 = providerModule.imageTransactionCheckpointSha256(checkpointPreimage);
  assets.forEach((asset, assetIndex) => {
    const bytes = assetBytes[assetIndex];
    imageLedger.assets.set(`${compactRun.run_id}:${asset.sha256}`, { runId: compactRun.run_id, sha256: asset.sha256, bytes, mime: "image/jpeg", sizeBytes: bytes.length, manifest: { sha256: asset.sha256, size_bytes: bytes.length, mime: "image/jpeg", width: 96, height: 128 }, member: true });
  });
  const run = {
    runId: compactRun.run_id,
    appScopeId: D36_APP_SCOPE,
    bootstrapNonce: "4".repeat(64),
    inputSha256: "5".repeat(64),
    status: "PARTIAL",
    ownerToken: "owner-d41",
    fence: 1,
    paidCalls: 1,
    checkpointPreimage,
    checkpointPreimageSha256,
    logicalStepId: "render-job-02",
    recoverableUntil: "2026-09-08T00:00:00.000Z",
    compactRun,
    snapshot: {
      schema: "xiaoshimei.image-operation-snapshot.v1",
      draft_record_id: "draft-record-d36-contract",
      mutation_epoch: 1,
      confirmed_draft: d36ConfirmedDraft({ recommended_image_count: 2 }),
      page_count: 2,
      production_mode: "narrative",
      reference_note: "",
    },
    referenceManifest: [],
  };
  imageLedger.runs.set(run.runId, run);
  return run;
}

function d36Transaction() {
  assert.equal(typeof providerModule.generateImagesTransaction, "function", "provider must export generateImagesTransaction");
  return providerModule.generateImagesTransaction;
}

function assertOrdered(events, expected) {
  let cursor = -1;
  for (const item of expected) {
    const next = events.indexOf(item, cursor + 1);
    assert.notEqual(next, -1, `${item} missing from ${events.join(" -> ")}`);
    cursor = next;
  }
}

const D36_SETTINGS = Object.freeze({
  apiKey: "test-key-123456",
  textModel: "text",
  imageModel: "image",
  credentialMode: "SERVER_MANAGED",
});
const D36_APP_SCOPE = "xiaoshimei-test-scope";
const D36_PRODUCTION_READINESS = Object.freeze({
  dedicated: true,
  eviction: "off",
  autoUpgrade: false,
  foreignKeyCount: 0,
  usageReadable: true,
  calibrated: true,
  capacityAvailable: true,
  calibrationSha256: "a".repeat(64),
});

function signedRuntimeAttestation({ nowMs = 1_788_192_000_000, appScope = D36_APP_SCOPE, restOrigin = "https://fake.upstash.io", overrides = {} } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = {
    schema: "xiaoshimei.image-ledger-attestation.v1",
    database_id_sha256: "1".repeat(64),
    rest_origin: restOrigin,
    app_scope: appScope,
    vercel_project_id: "prj_xiaoshimei_test",
    vercel_environment: "preview",
    candidate_commit: "2".repeat(40),
    database_state: "active",
    database_modifying: false,
    tls: true,
    eviction: false,
    db_eviction: false,
    auto_upgrade: false,
    storage_threshold_bytes: 100_000_000,
    current_storage_bytes: 1_000_000,
    control_config_hash: "3".repeat(64),
    relevant_audit_set_hash: "4".repeat(64),
    audit_high_water: { timestamp_ms: nowMs - 2_000, log_id: "audit-001" },
    audit_fetch_at_ms: nowMs - 1_000,
    audit_retention_seconds: 604_800,
    calibration_sha256: "5".repeat(64),
    calibration_bytes: 10_000_000,
    worst_case_run_bytes: 10_000_000,
    headroom_bytes: 20_000_000,
    capacity_limit_bytes: 100_000_000,
    attestation_generation: "6".repeat(64),
    capacity_generation: "7".repeat(64),
    signed_at_ms: nowMs - 10_000,
    renew_at_ms: nowMs + 6 * 24 * 60 * 60 * 1000 - 10_000,
    hard_expiry_ms: nowMs + 7 * 24 * 60 * 60 * 1000 - 10_000,
    ...overrides,
  };
  const envelope = {
    schema: "xiaoshimei.image-ledger-attestation-envelope.v1",
    payload,
    signature: sign(null, Buffer.from(canonicalAttestationJson(payload)), privateKey).toString("base64"),
  };
  return {
    envelope,
    privateKey,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function runtimeLedgerFixture({ attestation, nowMs = 1_788_192_000_000, mode = "START", runId = "images-2026-09-01T00-00-00-000Z-deadbeef", runRecord = null, mutateEnvelope = null, extraKeys = [], extraHashes = {} } = {}) {
  const accessEnv = {
    XIAOSHIMEI_ACCESS_CODE_SHA256: "a".repeat(64),
    XIAOSHIMEI_SESSION_SECRET: "s".repeat(64),
    XIAOSHIMEI_APP_ORIGIN: "https://xiaoshimei.example",
  };
  const appScope = inspectServerAccessConfig(accessEnv).appScope;
  const signed = attestation || signedRuntimeAttestation({ nowMs, appScope });
  const envelope = structuredClone(signed.envelope);
  if (typeof mutateEnvelope === "function") mutateEnvelope(envelope);
  const rootTag = createHash("sha256").update(appScope).digest("hex").slice(0, 32);
  const productRoot = "xiaoshimei:image-d37:{xiaoshimei-studio-v2}";
  const root = `${productRoot}:scope:${rootTag}`;
  const readinessKey = `${root}:readiness`;
  const capacityKey = `${productRoot}:capacity`;
  const commands = [];
  const keys = mode === "START" ? [...new Set([capacityKey, readinessKey, ...extraKeys])].sort() : [];
  const env = {
    ...accessEnv,
    UPSTASH_REDIS_REST_URL: "https://fake.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "runtime-rest-token-123456",
    XIAOSHIMEI_LEDGER_ATTESTATION_PUBLIC_KEY: signed.publicKey,
    XIAOSHIMEI_UPSTASH_DATABASE_ID_SHA256: envelope.payload.database_id_sha256,
    XIAOSHIMEI_VERCEL_PROJECT_ID: envelope.payload.vercel_project_id,
    VERCEL_ENV: envelope.payload.vercel_environment,
    XIAOSHIMEI_CANDIDATE_COMMIT: envelope.payload.candidate_commit,
  };
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    commands.push(body);
    const command = body[0];
    let result;
    if (command === "PING") result = "PONG";
    else if (command === "TIME") result = [String(Math.floor(nowMs / 1000)), String((nowMs % 1000) * 1000)];
    else if (command === "GET" && body[1] === readinessKey) result = JSON.stringify(envelope);
    else if (command === "ZRANGEBYSCORE") result = [];
    else if (command === "DBSIZE") result = keys.length;
    else if (command === "SCAN") result = ["0", keys];
    else if (command === "MEMORY" && body[1] === "USAGE") result = 1_000;
    else if (command === "HGETALL" && body[1] === capacityKey) result = [
      "schema", "xiaoshimei.image-ledger-capacity.v2",
      "capacity_generation", envelope.payload.capacity_generation,
      "attestation_generation", envelope.payload.attestation_generation,
      "capacity_limit_bytes", String(envelope.payload.capacity_limit_bytes),
      "headroom_bytes", String(envelope.payload.headroom_bytes),
      "worst_case_run_bytes", String(envelope.payload.worst_case_run_bytes),
      "reserved_bytes", "0",
      "live_reservations", "0",
      "unfinalized_inventory", "0",
    ];
    else if (command === "HGETALL" && Object.prototype.hasOwnProperty.call(extraHashes, body[1])) result = Object.entries(extraHashes[body[1]]).flatMap(([key, value]) => [key, String(value)]);
    else if (command === "HGETALL" && body[1].endsWith(`:run:${runId}:meta`)) result = runRecord || [
      "app_scope", appScope,
      "capacity_generation", envelope.payload.capacity_generation,
      "capacity_reservation_bytes", String(envelope.payload.worst_case_run_bytes),
      "capacity_released", "0",
    ];
    else if (command === "EVAL" && String(body[1]).includes("capacity_generation")) result = ["MATERIALIZING", "", "0", String(nowMs + 7 * 24 * 60 * 60 * 1000)];
    else throw new Error(`UNEXPECTED_RUNTIME_COMMAND:${body.join(":")}`);
    return { ok: true, json: async () => ({ result }) };
  };
  return { env, appScope, runId, commands, fetchImpl, envelope, signed, readinessKey, capacityKey };
}

function attestorFixture({ nowMs = 1_788_192_000_000 } = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const databaseId = "db-xiaoshimei-native-test";
  const state = {
    nowMs,
    database: {
      database_id: databaseId,
      state: "active",
      modifying: "false",
      tls: true,
      eviction: false,
      db_eviction: false,
      auto_upgrade: false,
      max_data_size: 100_000_000,
    },
    stats: { storage_threshold_bytes: 100_000_000, current_storage_bytes: 1_000_000 },
    audits: [
      { id: "audit-too-old", timestamp: nowMs - 9 * 24 * 60 * 60 * 1000, action: "create", resource_id: databaseId },
      { id: "audit-current", timestamp: nowMs - 60_000, action: "read", resource_id: databaseId },
    ],
    readiness: null,
    capacity: {},
    calibration: new Map(),
    calibrationUsage: 1_400_000,
    commands: [],
    developerRequests: [],
  };
  const env = {
    UPSTASH_DATABASE_ID: databaseId,
    UPSTASH_REDIS_REST_URL: "https://native-test.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "native-runtime-rest-token-123456",
    UPSTASH_DEVELOPER_EMAIL: "owner@example.test",
    UPSTASH_DEVELOPER_API_KEY: "developer-api-key-test",
    XIAOSHIMEI_APP_SCOPE: D36_APP_SCOPE,
    XIAOSHIMEI_VERCEL_PROJECT_ID: "prj_xiaoshimei_test",
    VERCEL_ENV: "preview",
    XIAOSHIMEI_CANDIDATE_COMMIT: "2".repeat(40),
    XIAOSHIMEI_WORST_CASE_RUN_BYTES: "1000000",
    XIAOSHIMEI_LEDGER_ATTESTATION_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
  const hashEntries = (record) => Object.entries(record).flatMap(([key, value]) => [key, String(value)]);
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === "https://api.upstash.com") {
      state.developerRequests.push(parsed.pathname);
      if (parsed.pathname.includes("/redis/database/")) return { ok: true, json: async () => structuredClone(state.database) };
      if (parsed.pathname.includes("/redis/stats/")) return { ok: true, json: async () => structuredClone(state.stats) };
      if (parsed.pathname.endsWith("/auditlogs")) return { ok: true, json: async () => structuredClone(state.audits) };
      throw new Error(`UNEXPECTED_DEVELOPER_API:${parsed.pathname}`);
    }
    const body = JSON.parse(options.body);
    state.commands.push(body);
    let result;
    if (body[0] === "TIME") result = [String(Math.floor(state.nowMs / 1000)), String((state.nowMs % 1000) * 1000)];
    else if (body[0] === "GET") {
      if (body[1].endsWith(":readiness")) result = state.readiness;
      else result = state.calibration.get(body[1]) ?? null;
    } else if (body[0] === "SET") {
      state.calibration.set(body[1], body[2]);
      result = "OK";
    } else if (body[0] === "MEMORY" && body[1] === "USAGE") result = state.calibrationUsage;
    else if (body[0] === "DEL") {
      state.calibration.delete(body[1]);
      result = 1;
    } else if (body[0] === "EXISTS") result = state.calibration.has(body[1]) ? 1 : 0;
    else if (body[0] === "HGETALL") result = hashEntries(state.capacity);
    else if (body[0] === "EVAL" && String(body[1]).includes("CAPACITY_ROTATION_BLOCKED")) {
      const nextGeneration = body[6];
      const previousGeneration = String(state.capacity.capacity_generation || "");
      if (previousGeneration && previousGeneration !== nextGeneration
        && ["reserved_bytes", "live_reservations", "unfinalized_inventory"].some((key) => Number(state.capacity[key] || 0) !== 0)) {
        result = ["CAPACITY_ROTATION_BLOCKED"];
      } else {
        const preserve = previousGeneration === nextGeneration;
        state.capacity = {
          schema: body[5],
          capacity_generation: nextGeneration,
          attestation_generation: body[7],
          capacity_limit_bytes: body[8],
          headroom_bytes: body[9],
          worst_case_run_bytes: body[10],
          reserved_bytes: preserve ? state.capacity.reserved_bytes || 0 : 0,
          live_reservations: preserve ? state.capacity.live_reservations || 0 : 0,
          unfinalized_inventory: preserve ? state.capacity.unfinalized_inventory || 0 : 0,
        };
        state.readiness = body[11];
        result = ["INSTALLED", String(state.capacity.reserved_bytes), String(state.capacity.live_reservations), String(state.capacity.unfinalized_inventory)];
      }
    } else throw new Error(`UNEXPECTED_ATTESTOR_COMMAND:${body.join(":")}`);
    return { ok: true, json: async () => ({ result }) };
  };
  return { env, state, fetchImpl, privateKey };
}

test("D36 default env factory verifies the signed Redis sentinel and performs START-only full inventory and capacity readback", async () => {
  const fixture = runtimeLedgerFixture({ mode: "START" });
  const ledger = createUpstashImageLedgerFromEnv(fixture.env, { fetchImpl: fixture.fetchImpl });
  const readiness = await ledger.assertProductionReady({ mode: "START", appScopeId: fixture.appScope, runId: fixture.runId });
  assert.equal(readiness.runtime_attested, true);
  assert.equal(readiness.capacity_generation, fixture.envelope.payload.capacity_generation);
  assert.equal(readiness.physicalBytes, 2_000);
  assert.equal(fixture.commands.filter((body) => body[0] === "SCAN").length, 1);
  assert.equal(fixture.commands.filter((body) => body[0] === "DBSIZE").length, 2);
  assert.equal(fixture.commands.filter((body) => body[0] === "MEMORY" && body[1] === "USAGE").length, 2);
});

test("D37 START accepts sibling environment and inventoried legacy D36 roots while sharing one conservative capacity total", async () => {
  const legacyRoot = `xiaoshimei:image-d36:{${"a".repeat(32)}}`;
  const siblingReadiness = `xiaoshimei:image-d37:{xiaoshimei-studio-v2}:scope:${"b".repeat(32)}:readiness`;
  const legacyCapacity = `${legacyRoot}:capacity`;
  const fixture = runtimeLedgerFixture({
    extraKeys: [siblingReadiness, `${legacyRoot}:readiness`, legacyCapacity],
    extraHashes: {
      [legacyCapacity]: {
        schema: "xiaoshimei.image-ledger-capacity.v1",
        reserved_bytes: 2_000_000,
        live_reservations: 1,
        unfinalized_inventory: 1,
      },
    },
  });
  const ledger = createUpstashImageLedgerFromEnv(fixture.env, { fetchImpl: fixture.fetchImpl });
  const readiness = await ledger.assertProductionReady({ mode: "START", appScopeId: fixture.appScope, runId: fixture.runId });
  assert.equal(readiness.legacyRootCount, 1);
  assert.equal(readiness.reservedBytes, 2_000_000);
  assert.equal(readiness.liveReservations, 1);
  assert.equal(readiness.unfinalizedInventory, 1);
  assert.equal(readiness.physicalBytes, 5_000);
});

test("D37 START still rejects an unknown namespace before claim or Provider", async () => {
  const fixture = runtimeLedgerFixture({ extraKeys: ["another-product:foreign"] });
  const ledger = createUpstashImageLedgerFromEnv(fixture.env, { fetchImpl: fixture.fetchImpl });
  await assert.rejects(
    () => ledger.assertProductionReady({ mode: "START", appScopeId: fixture.appScope, runId: fixture.runId }),
    /IMAGE_LEDGER_FOREIGN_KEYS_PRESENT/,
  );
  assert.equal(fixture.commands.some((body) => body[0] === "EVAL"), false);
});

test("D36 runtime-attested START atomically rechecks both generations and reserves worst-case capacity in the claim Lua", async () => {
  const fixture = runtimeLedgerFixture({ mode: "START" });
  const ledger = createUpstashImageLedgerFromEnv(fixture.env, { fetchImpl: fixture.fetchImpl });
  const readiness = await ledger.assertProductionReady({ mode: "START", appScopeId: fixture.appScope, runId: fixture.runId });
  const result = await ledger.claimStart({
    runId: fixture.runId,
    appScopeId: fixture.appScope,
    bootstrapNonce: "a".repeat(64),
    inputSha256: "b".repeat(64),
    snapshot: { schema: "xiaoshimei.image-operation-snapshot.v1", draft_record_id: "draft-runtime-reserve" },
    referenceManifest: [],
    accessExpiresAtMs: 1_788_192_360_000,
    readiness,
  });
  assert.equal(result.status, "MATERIALIZING");
  const claim = fixture.commands.find((body) => body[0] === "EVAL" && String(body[1]).includes("capacity_generation"));
  assert.ok(claim);
  assert.equal(claim[2], "4");
  assert.equal(claim[3].endsWith(`:run:${fixture.runId}:meta`), true);
  assert.equal(claim[4].endsWith(`:run:${fixture.runId}:inventory`), true);
  assert.equal(claim[5], fixture.capacityKey);
  assert.equal(claim[6].endsWith(":expiry"), true);
  assert.equal(claim.includes(readiness.attestation_generation), true);
  assert.equal(claim.includes(readiness.capacity_generation), true);
  assert.equal(claim.includes(String(readiness.worst_case_run_bytes)), true);
  assert.doesNotMatch(String(claim[1]), /HGET', KEYS\[3\], 'attestation_generation'/, "one environment refresh must not invalidate another environment's shared capacity slot");
  assert.match(String(claim[1]), /HINCRBY[\s\S]*reserved_bytes[\s\S]*live_reservations[\s\S]*unfinalized_inventory/);
  assert.match(String(claim[1]), /ZADD[\s\S]*recoverable_until/);
});

test("D36 STEP revalidates the current signed sentinel and stable capacity generation without a full database scan", async () => {
  const fixture = runtimeLedgerFixture({ mode: "STEP" });
  const ledger = createUpstashImageLedgerFromEnv(fixture.env, { fetchImpl: fixture.fetchImpl });
  const readiness = await ledger.assertProductionReady({ mode: "STEP", appScopeId: fixture.appScope, runId: fixture.runId });
  assert.equal(readiness.runtime_attested, true);
  assert.equal(readiness.mode, "STEP");
  assert.equal(fixture.commands.some((body) => body[0] === "SCAN" || body[0] === "DBSIZE"), false);

  const rotated = signedRuntimeAttestation({
    appScope: fixture.appScope,
    overrides: {
      capacity_generation: fixture.envelope.payload.capacity_generation,
      attestation_generation: "8".repeat(64),
    },
  });
  const compatible = runtimeLedgerFixture({ attestation: rotated, mode: "STEP" });
  const compatibleLedger = createUpstashImageLedgerFromEnv(compatible.env, { fetchImpl: compatible.fetchImpl });
  const compatibleReadiness = await compatibleLedger.assertProductionReady({ mode: "STEP", appScopeId: compatible.appScope, runId: compatible.runId });
  assert.equal(compatibleReadiness.capacity_generation, fixture.envelope.payload.capacity_generation);
  assert.equal(compatibleReadiness.attestation_generation, "8".repeat(64));
});

test("D36 missing trust, bad signature, wrong binding, expiry and capacity-generation drift all fail before a START scan or Provider", async () => {
  const cases = [
    {
      name: "missing public key",
      fixture: () => {
        const value = runtimeLedgerFixture();
        delete value.env.XIAOSHIMEI_LEDGER_ATTESTATION_PUBLIC_KEY;
        return value;
      },
    },
    { name: "bad signature", fixture: () => runtimeLedgerFixture({ mutateEnvelope: (value) => { value.signature = Buffer.alloc(64, 7).toString("base64"); } }) },
    {
      name: "wrong candidate",
      fixture: () => {
        const value = runtimeLedgerFixture();
        value.env.XIAOSHIMEI_CANDIDATE_COMMIT = "f".repeat(40);
        return value;
      },
    },
    {
      name: "expired",
      fixture: () => {
        const nowMs = 1_788_192_000_000;
        const access = inspectServerAccessConfig({
          XIAOSHIMEI_ACCESS_CODE_SHA256: "a".repeat(64),
          XIAOSHIMEI_SESSION_SECRET: "s".repeat(64),
          XIAOSHIMEI_APP_ORIGIN: "https://xiaoshimei.example",
        });
        const attestation = signedRuntimeAttestation({ nowMs, appScope: access.appScope, overrides: { renew_at_ms: nowMs - 1, hard_expiry_ms: nowMs } });
        return runtimeLedgerFixture({ attestation, nowMs });
      },
    },
  ];
  for (const { name, fixture: makeFixture } of cases) {
    const fixture = makeFixture();
    const ledger = createUpstashImageLedgerFromEnv(fixture.env, { fetchImpl: fixture.fetchImpl });
    if (!ledger) {
      assert.equal(name, "missing public key");
      continue;
    }
    await assert.rejects(
      () => ledger.assertProductionReady({ mode: "START", appScopeId: fixture.appScope, runId: fixture.runId }),
      /IMAGE_LEDGER_(READINESS|ATTESTATION)/,
      name,
    );
    assert.equal(fixture.commands.some((body) => body[0] === "SCAN"), false, `${name} must stop before full scan`);
  }

  const drift = runtimeLedgerFixture({ mode: "STEP", runRecord: [
    "app_scope", inspectServerAccessConfig({ XIAOSHIMEI_ACCESS_CODE_SHA256: "a".repeat(64), XIAOSHIMEI_SESSION_SECRET: "s".repeat(64), XIAOSHIMEI_APP_ORIGIN: "https://xiaoshimei.example" }).appScope,
    "capacity_generation", "f".repeat(64),
    "capacity_reservation_bytes", "10000000",
    "capacity_released", "0",
  ] });
  const driftLedger = createUpstashImageLedgerFromEnv(drift.env, { fetchImpl: drift.fetchImpl });
  await assert.rejects(
    () => driftLedger.assertProductionReady({ mode: "STEP", appScopeId: drift.appScope, runId: drift.runId }),
    /IMAGE_LEDGER_CAPACITY_RESERVATION_INVALID/,
  );
  assert.equal(drift.commands.some((body) => body[0] === "SCAN"), false);
});

test("D36 attestor binds the retained audit slice, signs exact control facts, and renews without rotating same capacity identity", async () => {
  const fixture = attestorFixture();
  const first = await buildAndInstallAttestation({ env: fixture.env, fetchImpl: fixture.fetchImpl });
  assert.equal(first.audit_entry_count, 1, "audit entries older than the retained seven-day slice must not poison the current receipt");
  const publicKey = createPublicKey({ key: Buffer.from(first.public_key_spki_base64, "base64"), format: "der", type: "spki" });
  assert.equal(verify(null, Buffer.from(canonicalAttestationJson(first.envelope.payload)), publicKey, Buffer.from(first.envelope.signature, "base64")), true);
  assert.equal(first.envelope.payload.database_modifying, false, "the control plane string value 'false' must not be coerced to true");
  assert.equal(first.envelope.payload.audit_high_water.log_id, "audit-current");
  assert.equal(fixture.state.commands.some((body) => body[0] === "EVAL" && String(body[1]).includes("CAPACITY_ROTATION_BLOCKED")), true);
  const firstCapacityGeneration = first.envelope.payload.capacity_generation;
  const firstAttestationGeneration = first.envelope.payload.attestation_generation;

  fixture.state.nowMs += 24 * 60 * 60 * 1000;
  const second = await buildAndInstallAttestation({ env: fixture.env, fetchImpl: fixture.fetchImpl });
  assert.equal(second.envelope.payload.capacity_generation, firstCapacityGeneration, "fresh random calibration bytes with the same measured result must not rotate live capacity identity");
  assert.notEqual(second.envelope.payload.attestation_generation, firstAttestationGeneration);
  assert.equal(fixture.state.capacity.reserved_bytes, 0);
});

test("D37 Preview and Production attestations keep separate readiness keys but derive one shared capacity identity", async () => {
  const preview = attestorFixture();
  const production = attestorFixture();
  production.env.XIAOSHIMEI_APP_SCOPE = `xiaoshimei-studio:${"f".repeat(32)}`;
  production.env.VERCEL_ENV = "production";
  const previewResult = await buildAndInstallAttestation({ env: preview.env, fetchImpl: preview.fetchImpl });
  const productionResult = await buildAndInstallAttestation({ env: production.env, fetchImpl: production.fetchImpl });
  assert.notEqual(previewResult.readiness_key, productionResult.readiness_key);
  assert.equal(previewResult.capacity_key, productionResult.capacity_key);
  assert.equal(previewResult.envelope.payload.capacity_generation, productionResult.envelope.payload.capacity_generation);
});

test("D36 attestor transports an eight-megabyte calibration in bounded one-megabyte REST chunks", async () => {
  const fixture = attestorFixture();
  fixture.env.XIAOSHIMEI_WORST_CASE_RUN_BYTES = "8000000";
  await buildAndInstallAttestation({ env: fixture.env, fetchImpl: fixture.fetchImpl });

  const writes = fixture.state.commands.filter((body) => body[0] === "SET" && String(body[1]).includes(":calibration:"));
  assert.equal(writes.length, 8);
  assert.equal(writes.reduce((total, body) => total + Buffer.from(body[2], "base64").length, 0), 8_000_000);
  assert.equal(Math.max(...writes.map((body) => Buffer.from(body[2], "base64").length)), 1_000_000);
  assert.equal(fixture.state.calibration.size, 0, "every transport chunk must still be deleted and read back absent");
});

test("D36 scheduled attestor verifies the signed exact binding and exits not-due before Developer API or calibration writes", async () => {
  const fixture = attestorFixture();
  const installed = await buildAndInstallAttestation({ env: fixture.env, fetchImpl: fixture.fetchImpl });
  fixture.state.commands.length = 0;
  fixture.state.developerRequests.length = 0;
  fixture.env.XIAOSHIMEI_ATTESTATION_ONLY_IF_DUE = "true";
  fixture.env.XIAOSHIMEI_ATTESTATION_RENEW_LEAD_MS = String(24 * 60 * 60 * 1000);

  const result = await buildAndInstallAttestation({ env: fixture.env, fetchImpl: fixture.fetchImpl });
  assert.equal(result.status, "ATTESTATION_NOT_DUE");
  assert.equal(result.attestation_generation, installed.envelope.payload.attestation_generation);
  assert.equal(result.capacity_generation, installed.envelope.payload.capacity_generation);
  assert.equal(fixture.state.developerRequests.length, 0);
  assert.deepEqual(fixture.state.commands.map((body) => body[0]), ["TIME", "GET"]);
  assert.equal(fixture.state.calibration.size, 0);
});

test("D36 scheduled attestor renews inside the lead window but rejects signature or binding drift before Developer API", async () => {
  const due = attestorFixture();
  await buildAndInstallAttestation({ env: due.env, fetchImpl: due.fetchImpl });
  due.state.nowMs += 5 * 24 * 60 * 60 * 1000;
  due.env.XIAOSHIMEI_ATTESTATION_ONLY_IF_DUE = "true";
  due.env.XIAOSHIMEI_ATTESTATION_RENEW_LEAD_MS = String(24 * 60 * 60 * 1000);
  due.state.commands.length = 0;
  due.state.developerRequests.length = 0;
  const renewed = await buildAndInstallAttestation({ env: due.env, fetchImpl: due.fetchImpl });
  assert.equal(renewed.envelope.payload.signed_at_ms, due.state.nowMs);
  assert.equal(due.state.developerRequests.length, 3);
  assert.equal(due.state.commands.some((body) => body[0] === "SET"), true);

  const wrongBinding = attestorFixture();
  await buildAndInstallAttestation({ env: wrongBinding.env, fetchImpl: wrongBinding.fetchImpl });
  wrongBinding.env.XIAOSHIMEI_ATTESTATION_ONLY_IF_DUE = "true";
  wrongBinding.env.XIAOSHIMEI_ATTESTATION_RENEW_LEAD_MS = String(24 * 60 * 60 * 1000);
  wrongBinding.env.XIAOSHIMEI_CANDIDATE_COMMIT = "f".repeat(40);
  wrongBinding.state.commands.length = 0;
  wrongBinding.state.developerRequests.length = 0;
  await assert.rejects(
    () => buildAndInstallAttestation({ env: wrongBinding.env, fetchImpl: wrongBinding.fetchImpl }),
    /ATTESTATION_PRIOR_BINDING_MISMATCH:candidate_commit/,
  );
  assert.equal(wrongBinding.state.developerRequests.length, 0);
  assert.deepEqual(wrongBinding.state.commands.map((body) => body[0]), ["TIME", "GET"]);

  const badSignature = attestorFixture();
  await buildAndInstallAttestation({ env: badSignature.env, fetchImpl: badSignature.fetchImpl });
  const envelope = JSON.parse(badSignature.state.readiness);
  envelope.signature = Buffer.alloc(64, 7).toString("base64");
  badSignature.state.readiness = JSON.stringify(envelope);
  badSignature.env.XIAOSHIMEI_ATTESTATION_ONLY_IF_DUE = "true";
  badSignature.env.XIAOSHIMEI_ATTESTATION_RENEW_LEAD_MS = String(24 * 60 * 60 * 1000);
  badSignature.state.commands.length = 0;
  badSignature.state.developerRequests.length = 0;
  await assert.rejects(
    () => buildAndInstallAttestation({ env: badSignature.env, fetchImpl: badSignature.fetchImpl }),
    /ATTESTATION_PRIOR_SIGNATURE_INVALID/,
  );
  assert.equal(badSignature.state.developerRequests.length, 0);
  assert.deepEqual(badSignature.state.commands.map((body) => body[0]), ["TIME", "GET"]);
});

test("D39 explicit manual attestation rotates only the candidate binding while preserving the signed chain and capacity identity", async () => {
  const fixture = attestorFixture();
  const first = await buildAndInstallAttestation({ env: fixture.env, fetchImpl: fixture.fetchImpl });
  fixture.state.nowMs += 60_000;
  fixture.env.XIAOSHIMEI_CANDIDATE_COMMIT = "3".repeat(40);
  fixture.env.XIAOSHIMEI_ATTESTATION_ALLOW_CANDIDATE_ROTATION = "true";
  fixture.state.commands.length = 0;
  fixture.state.developerRequests.length = 0;

  const rotated = await buildAndInstallAttestation({ env: fixture.env, fetchImpl: fixture.fetchImpl });
  assert.equal(rotated.envelope.payload.candidate_commit, "3".repeat(40));
  assert.equal(rotated.envelope.payload.capacity_generation, first.envelope.payload.capacity_generation);
  assert.notEqual(rotated.envelope.payload.attestation_generation, first.envelope.payload.attestation_generation);
  assert.deepEqual(fixture.state.developerRequests.sort(), [
    "/auditlogs",
    "/v2/redis/database/db-xiaoshimei-native-test",
    "/v2/redis/stats/db-xiaoshimei-native-test",
  ]);
  assert.equal(JSON.parse(fixture.state.readiness).payload.candidate_commit, "3".repeat(40));
});

test("D39 scheduled renewal can never combine due mode with candidate rotation authority", async () => {
  const fixture = attestorFixture();
  await buildAndInstallAttestation({ env: fixture.env, fetchImpl: fixture.fetchImpl });
  fixture.env.XIAOSHIMEI_CANDIDATE_COMMIT = "3".repeat(40);
  fixture.env.XIAOSHIMEI_ATTESTATION_ONLY_IF_DUE = "true";
  fixture.env.XIAOSHIMEI_ATTESTATION_ALLOW_CANDIDATE_ROTATION = "true";
  fixture.state.commands.length = 0;
  fixture.state.developerRequests.length = 0;
  await assert.rejects(
    () => buildAndInstallAttestation({ env: fixture.env, fetchImpl: fixture.fetchImpl }),
    /ATTESTATION_CANDIDATE_ROTATION_MODE_INVALID/,
  );
  assert.equal(fixture.state.commands.length, 0);
  assert.equal(fixture.state.developerRequests.length, 0);
});

test("D36 attestor refuses missing audit continuity and changed capacity while reservations remain", async () => {
  const continuity = attestorFixture();
  await buildAndInstallAttestation({ env: continuity.env, fetchImpl: continuity.fetchImpl });
  continuity.state.nowMs += 60_000;
  continuity.state.audits = [{ id: "different-audit", timestamp: continuity.state.nowMs - 1_000, action: "read", resource_id: continuity.state.database.database_id }];
  await assert.rejects(
    () => buildAndInstallAttestation({ env: continuity.env, fetchImpl: continuity.fetchImpl }),
    /ATTESTATION_AUDIT_CONTINUITY_UNKNOWN/,
  );

  const rotation = attestorFixture();
  await buildAndInstallAttestation({ env: rotation.env, fetchImpl: rotation.fetchImpl });
  rotation.state.capacity.reserved_bytes = 1_400_000;
  rotation.state.capacity.live_reservations = 1;
  rotation.state.capacity.unfinalized_inventory = 1;
  rotation.state.calibrationUsage += 1;
  rotation.state.nowMs += 60_000;
  await assert.rejects(
    () => buildAndInstallAttestation({ env: rotation.env, fetchImpl: rotation.fetchImpl }),
    /ATTESTATION_CAPACITY_ROTATION_BLOCKED/,
  );
});

test("D36 real adapter maps one app_scope+bootstrap_nonce to one physical run root even when the input hash conflicts", async () => {
  const transact = d36Transaction();
  const nonce = "4".repeat(64);
  const first = await d36StartInput({ nonce });
  const conflicting = await d36StartInput({ nonce, operationOverrides: { mutation_epoch: 2 } });
  const commands = [];
  let claimCount = 0;
  const imageLedger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    productionReadiness: D36_PRODUCTION_READINESS,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      commands.push(body);
      if (body[0] === "PING") return { ok: true, json: async () => ({ result: "PONG" }) };
      if (body[0] === "EVAL" && String(body[1]).includes("snapshot_sha")) {
        claimCount += 1;
        return { ok: true, json: async () => ({ result: claimCount === 1 ? ["UNKNOWN", "", "0", "0"] : ["CONFLICT"] }) };
      }
      throw new Error(`UNEXPECTED_REDIS_COMMAND:${body[0]}`);
    },
  });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    const firstResult = await transact(first, D36_SETTINGS, {
      imageLedger,
      nowMs: 1_788_192_000_000,
      accessExpiresAtMs: 1_788_192_360_000,
      appScopeId: D36_APP_SCOPE,
    });
    assert.equal(firstResult.status, "UNKNOWN");
    await assert.rejects(
      () => transact(conflicting, D36_SETTINGS, {
        imageLedger,
        nowMs: 1_788_192_001_000,
        accessExpiresAtMs: 1_788_192_360_000,
        appScopeId: D36_APP_SCOPE,
      }),
      /BOOTSTRAP_INPUT_CONFLICT/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  const claims = commands.filter((body) => body[0] === "EVAL" && String(body[1]).includes("snapshot_sha"));
  assert.equal(claims.length, 2);
  assert.equal(claims[0][2], "2", "claimStart must atomically address meta plus inventory");
  assert.equal(claims[0][3], claims[1][3]);
  assert.equal(claims[0][4], claims[1][4]);
  assert.match(claims[0][3], /^xiaoshimei:image-d37:\{xiaoshimei-studio-v2\}:scope:[0-9a-f]{32}:run:images-[0-9TZ-]+-[0-9a-f]{8}:meta$/);
  assert.equal(claims[0][4], claims[0][3].replace(/:meta$/, ":inventory"));
  assert.equal(upstreamCalls, 0);
});

test("D36 claimStart stays conservative while external DISCOVER classifies an expired planner-only lease without weakening paid-step UNKNOWN", async () => {
  const transact = d36Transaction();
  const input = await d36StartInput({ nonce: "5".repeat(64) });
  const scripts = [];
  const imageLedger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    productionReadiness: D36_PRODUCTION_READINESS,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body[0] === "PING") return { ok: true, json: async () => ({ result: "PONG" }) };
      if (body[0] === "EVAL") {
        scripts.push(String(body[1]));
        if (String(body[1]).includes("snapshot_sha")) return { ok: true, json: async () => ({ result: ["UNKNOWN", "", "0", "1788796800000"] }) };
        if (String(body[1]).includes("HGETALL")) {
          return {
            ok: true,
            json: async () => ({
              result: [
                "FOUND",
                "status", "PLANNER_FAILED",
                "app_scope", D36_APP_SCOPE,
                "bootstrap_nonce", input.bootstrap_nonce,
                "input_sha", input.input_sha256,
                "recoverable_until_ms", "1788796800000",
                "planner_failure_code", "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS",
              ],
            }),
          };
        }
      }
      if (body[0] === "HGETALL") {
        return {
          ok: true,
          json: async () => ({
            result: [
              "status", "PLANNING",
              "planner_lease_until_ms", "1",
              "app_scope", D36_APP_SCOPE,
              "bootstrap_nonce", input.bootstrap_nonce,
              "input_sha", input.input_sha256,
              "recoverable_until_ms", "1788796800000",
            ],
          }),
        };
      }
      throw new Error(`UNEXPECTED_REDIS_COMMAND:${body[0]}`);
    },
  });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    const startResult = await transact(input, D36_SETTINGS, {
      imageLedger,
      nowMs: 1_788_192_000_000,
      accessExpiresAtMs: 1_788_192_360_000,
      appScopeId: D36_APP_SCOPE,
    });
    assert.equal(startResult.status, "UNKNOWN");
    const discoverResult = await transact(
      { mode: "DISCOVER", bootstrap_nonce: input.bootstrap_nonce, input_sha256: input.input_sha256 },
      D36_SETTINGS,
      { imageLedger, nowMs: 1_788_192_001_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE },
    );
    assert.equal(discoverResult.status, "ERROR");
    assert.equal(discoverResult.error.code, "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS");
    assert.equal(discoverResult.progress.image_upstream_calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  const claimScript = scripts.find((script) => script.includes("snapshot_sha"));
  const discoverScript = scripts.find((script) => script.includes("HGETALL"));
  for (const script of [claimScript, discoverScript]) {
    assert.match(String(script), /redis\.call\(['"]TIME['"]\)/);
    assert.match(String(script), /PLANNING/);
    assert.match(String(script), /planner_lease_until_ms/);
    assert.match(String(script), /HSET[\s\S]*UNKNOWN/);
  }
  assert.match(String(discoverScript), /run_json/);
  assert.match(String(discoverScript), /reservation_count/);
  assert.match(String(discoverScript), /PLANNER_FAILED/);
  assert.equal(upstreamCalls, 0);
});

test("D36 STEP uses the real adapter's app-scope-only by-run read while external DISCOVER remains nonce+input bound", async () => {
  const transact = d36Transaction();
  const fixture = new FakeD36ImageLedger();
  const run = fixture.seedReadyRun({ runId: "image-run-d36-real-adapter-read" });
  const input = d36StepInput(run);
  const redisCommands = [];
  const record = [
    "status", "READY",
    "app_scope", D36_APP_SCOPE,
    "bootstrap_nonce", run.bootstrapNonce,
    "input_sha", run.inputSha256,
    "recoverable_until_ms", String(Date.parse(run.recoverableUntil)),
    "snapshot_json", JSON.stringify(run.snapshot),
    "manifest_json", JSON.stringify(run.referenceManifest),
    "run_json", JSON.stringify(run.compactRun),
    "checkpoint_json", JSON.stringify(run.checkpointPreimage),
    "checkpoint_sha", run.checkpointPreimageSha256,
    "logical_step_id", run.logicalStepId,
  ];
  const imageLedger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    productionReadiness: D36_PRODUCTION_READINESS,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      redisCommands.push(body);
      if (body[0] === "PING") return { ok: true, json: async () => ({ result: "PONG" }) };
      if (body[0] === "EVAL" && String(body[1]).includes("HGETALL")) return { ok: true, json: async () => ({ result: ["FOUND", ...record] }) };
      if (body[0] === "EVAL" && String(body[1]).includes("reservation_count")) return { ok: true, json: async () => ({ result: ["BUDGET_EXHAUSTED"] }) };
      if (body[0] === "HGETALL") return { ok: true, json: async () => ({ result: record }) };
      throw new Error(`UNEXPECTED_REDIS_COMMAND:${body[0]}`);
    },
  });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    await assert.rejects(
      () => transact(input, D36_SETTINGS, {
        imageLedger,
        nowMs: 1_788_192_000_000,
        accessExpiresAtMs: 1_788_192_360_000,
        appScopeId: D36_APP_SCOPE,
      }),
      /BUDGET_EXHAUSTED/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  const byRunRead = redisCommands.find((body) => body[0] === "EVAL" && String(body[1]).includes("HGETALL"));
  assert.ok(byRunRead, "STEP must use the adapter's atomic by-run read");
  assert.deepEqual(byRunRead.slice(-4), [D36_APP_SCOPE, "", "", "0"]);
  assert.equal(upstreamCalls, 0);
});

test("D36 START durably claims, materializes and reads references, then claims planner before planner upstream", async () => {
  const transact = d36Transaction();
  const events = [];
  const imageLedger = new FakeD36ImageLedger({ events });
  const input = await d36StartInput();
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    events.push("provider:planner");
    return { ok: true, json: async () => ({ output: [{ type: "function_call", name: "return_xiaoshimei_page_plan", arguments: JSON.stringify({ pages: [d36PlannerPage()] }) }] }) };
  };
  try {
    const result = await transact(input, D36_SETTINGS, {
      imageLedger,
      nowMs: 1_788_192_000_000,
      accessExpiresAtMs: 1_788_192_000_000 + 360_000,
      appScopeId: D36_APP_SCOPE,
    });
    assert.equal(result.status, "READY");
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 1);
  assertOrdered(events, [
    "ledger:readiness",
    "ledger:claimStart",
    "ledger:putRunAsset",
    "ledger:readRunAsset",
    "ledger:claimPlanner",
    "provider:planner",
    "ledger:commitPlanner",
  ]);
});

test("D36 planner rejection is cached as a zero-image-call terminal state", async () => {
  const transact = d36Transaction();
  const imageLedger = new FakeD36ImageLedger();
  const input = await d36StartInput({ nonce: "a".repeat(64) });
  let plannerCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    plannerCalls += 1;
    return { ok: true, json: async () => ({ output: [] }) };
  };
  try {
    const failed = await transact(input, D36_SETTINGS, {
      imageLedger,
      nowMs: 1_788_192_000_000,
      accessExpiresAtMs: 1_788_192_360_000,
      appScopeId: D36_APP_SCOPE,
    });
    assert.equal(failed.status, "ERROR");
    assert.equal(failed.error.code, "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS");
    assert.equal(failed.progress.image_upstream_calls, 0);
    assert.equal(failed.upstream_calls, 1);
    assert.equal(imageLedger.runs.get(failed.run_id).status, "PLANNER_FAILED");

    const discovered = await transact(
      { mode: "DISCOVER", bootstrap_nonce: input.bootstrap_nonce, input_sha256: input.input_sha256 },
      D36_SETTINGS,
      { imageLedger, nowMs: 1_788_192_001_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE },
    );
    assert.equal(discovered.status, "ERROR");
    assert.equal(discovered.error.code, "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS");
    assert.equal(discovered.cached, true);
    assert.equal(discovered.upstream_calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(plannerCalls, 1);
});

test("D36 same nonce and input DISCOVER reads cached READY with one planner while a different input hash conflicts", async () => {
  const transact = d36Transaction();
  const imageLedger = new FakeD36ImageLedger();
  const input = await d36StartInput({ nonce: "b".repeat(64) });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return { ok: true, json: async () => ({ output: [{ type: "function_call", name: "return_xiaoshimei_page_plan", arguments: JSON.stringify({ pages: [d36PlannerPage()] }) }] }) };
  };
  try {
    const ready = await transact(input, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE });
    const discovered = await transact(
      { mode: "DISCOVER", bootstrap_nonce: input.bootstrap_nonce, input_sha256: input.input_sha256 },
      D36_SETTINGS,
      { imageLedger, nowMs: 1_788_192_001_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE },
    );
    assert.equal(ready.run_id, discovered.run_id);
    assert.equal(discovered.status, "READY_DISCOVERY");
    assert.equal(discovered.cached, true);

    const conflicting = await d36StartInput({ nonce: input.bootstrap_nonce, operationOverrides: { mutation_epoch: 2 } });
    await assert.rejects(
      () => transact(conflicting, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_002_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
      /BOOTSTRAP.*CONFLICT|INPUT.*CONFLICT/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 1);
});

test("D36 paid capability with less than 270 seconds remaining stops before ledger claim and Provider", async () => {
  const transact = d36Transaction();
  const events = [];
  const imageLedger = new FakeD36ImageLedger({ events });
  const input = await d36StartInput({ nonce: "c".repeat(64) });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    await assert.rejects(
      () => transact(input, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_269_999, appScopeId: D36_APP_SCOPE }),
      /EXPIRY_WINDOW_TOO_SHORT/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
  assert.equal(events.includes("ledger:claimStart"), false);
});

test("D41 covered narrative checkpoint commits COMPLETE with zero additional Provider calls", async () => {
  const events = [];
  const imageLedger = new FakeD36ImageLedger({ events });
  const run = await seedD41CoveredNarrativeRun(imageLedger);
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    const result = await d36Transaction()(d36StepInput(run), D36_SETTINGS, { imageLedger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_720_000, appScopeId: D36_APP_SCOPE });
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.upstream_calls, 0);
    assert.equal(result.progress.actual_image_calls, 1);
    assert.equal(result.progress.completed_image_steps, 1);
    assert.equal(result.progress.total_image_steps, 1);
    assert.equal(result.content_package.visible_pages, 2);
    assert.equal(result.content_package.generation.production_mode, "narrative");
    assert.equal(result.content_package.pages.every((page) => !page.info_panels?.length), true);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
  assertOrdered(events, ["ledger:readiness", "ledger:reserveStep", "ledger:readRunAsset", "ledger:commitStep"]);
});

test("D36 STEP reserves one logical action; an alternate nonce cannot enter the image upstream", async () => {
  const transact = d36Transaction();
  const imageLedger = new FakeD36ImageLedger();
  const run = imageLedger.seedReadyRun();
  const input = d36StepInput(run);
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
    throw new Error("FAKE_D36_IMAGE_PROVIDER_FAILURE");
  };
  try {
    const first = transact(input, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE });
    await started;
    await assert.rejects(
      () => transact({ ...input, attempt_nonce: "f".repeat(64) }, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_001_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
      /NONCE.*CONFLICT|IMAGE_STEP_IN_FLIGHT/,
    );
    releaseUpstream();
    await assert.rejects(first, /FAKE_D36_IMAGE_PROVIDER_FAILURE|IMAGE_STEP/);
  } finally {
    releaseUpstream?.();
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 1);
});

test("D36 lost step commit is reused only after committed readback and never repeats Provider", async () => {
  const transact = d36Transaction();
  const imageLedger = new FakeD36ImageLedger({ commitMode: "apply-then-throw-once" });
  const run = imageLedger.seedReadyRun({ runId: "image-run-d36-commit-loss" });
  const input = d36StepInput(run);
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("FAKE_D36_COMMITTED_PROVIDER_ERROR"); };
  let firstCode = "";
  try {
    await assert.rejects(
      () => transact(input, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
      (error) => { firstCode = error.message; return /FAKE_D36_COMMITTED_PROVIDER_ERROR|IMAGE_STEP/.test(firstCode); },
    );
    await assert.rejects(
      () => transact(input, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_001_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
      (error) => error.message === firstCode,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 1);
});

test("D36 expired in-flight STEP freezes UNKNOWN and never permits takeover", async () => {
  const transact = d36Transaction();
  const imageLedger = new FakeD36ImageLedger();
  const run = imageLedger.seedReadyRun({ runId: "image-run-d36-lease-expired" });
  const input = d36StepInput(run);
  imageLedger.seedInflightStep(input, { reservedAtMs: 1_788_191_000_000 });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    await assert.rejects(
      () => transact(input, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
      /IMAGE_STEP_UNKNOWN|UNKNOWN/,
    );
    await assert.rejects(
      () => transact({ ...input, attempt_nonce: "f".repeat(64) }, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_001_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
      /IMAGE_STEP_UNKNOWN|UNKNOWN/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
});

test("D36 missing or corrupt reference bytes fail before planner upstream", async () => {
  const transact = d36Transaction();
  const validBytes = await d36ReferenceBytes();
  const missing = await d36StartInput({ nonce: "d".repeat(64), includeMedia: false, referenceBytes: validBytes });
  const corruptBytes = Buffer.from(validBytes);
  corruptBytes[Math.floor(corruptBytes.length / 2)] ^= 0xff;
  const corrupt = await d36StartInput({ nonce: "e".repeat(64), referenceBytes: corruptBytes, manifestSha: missing.reference_manifest[0].sha256 });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    await assert.rejects(
      () => transact(missing, D36_SETTINGS, { imageLedger: new FakeD36ImageLedger(), nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
      /REFERENCE.*MISSING|IMAGE_ASSET_MISSING/,
    );
    await assert.rejects(
      () => transact(corrupt, D36_SETTINGS, { imageLedger: new FakeD36ImageLedger(), nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
      /HASH_MISMATCH|REFERENCE.*CORRUPT|IMAGE_ASSET_HASH_MISMATCH/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
});

test("D36 readiness drift in eviction, auto-upgrade, foreign keys, usage or calibration closes the lane", async () => {
  const transact = d36Transaction();
  const input = await d36StartInput({ nonce: "1".repeat(64) });
  const cases = [
    { eviction: "allkeys-lru" },
    { autoUpgrade: "on" },
    { foreignKeys: 1 },
    { usage: "UNKNOWN" },
    { calibration: "UNKNOWN" },
  ];
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    for (const readiness of cases) {
      await assert.rejects(
        () => transact(input, D36_SETTINGS, { imageLedger: new FakeD36ImageLedger({ readiness }), nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
        /IMAGE_LEDGER_PRODUCTION_NOT_READY/,
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
});

test("D36 exact assets are content-addressed inside one run but never physically shared across runs", async () => {
  const transact = d36Transaction();
  const imageLedger = new FakeD36ImageLedger();
  const bytes = await d36ReferenceBytes();
  const first = await d36StartInput({ nonce: "2".repeat(64), referenceBytes: bytes });
  const second = await d36StartInput({ nonce: "3".repeat(64), referenceBytes: bytes });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return { ok: true, json: async () => ({ output: [{ type: "function_call", name: "return_xiaoshimei_page_plan", arguments: JSON.stringify({ pages: [d36PlannerPage()] }) }] }) };
  };
  try {
    const one = await transact(first, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE });
    const two = await transact(second, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_001_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE });
    assert.notEqual(one.run_id, two.run_id);
  } finally {
    globalThis.fetch = previousFetch;
  }
  const sha = first.reference_manifest[0].sha256;
  const matching = [...imageLedger.assets.keys()].filter((key) => key.endsWith(`:${sha}`));
  assert.equal(matching.length, 2);
  assert.notEqual(matching[0], matching[1]);
  assert.equal(upstreamCalls, 2);
});

test("D36 real adapter atomically inventories every meta, asset, and step physical-key creation", async () => {
  const commands = [];
  const bytes = await d36ReferenceBytes();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = { schema: "xiaoshimei.media-asset-manifest.v1", media_ref: `xiaoshimei-media://sha256/${sha256}`, sha256, size_bytes: bytes.length, mime: "image/jpeg", name: "inventory asset", width: 96, height: 128 };
  const runId = "images-2026-09-01T00-00-00-000Z-1a2b3c4d";
  const imageLedger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      commands.push(body);
      if (body[0] === "EVAL" && String(body[1]).includes("snapshot_sha")) return { ok: true, json: async () => ({ result: ["MATERIALIZING", "", "0", "1788796800000"] }) };
      if (body[0] === "EVAL" && String(body[1]).includes("CAS_CONFLICT")) return { ok: true, json: async () => ({ result: ["STORED"] }) };
      if (body[0] === "EVAL" && String(body[1]).includes("reservation_count")) return { ok: true, json: async () => ({ result: ["RESERVED", "step-owner", "1"] }) };
      if (body[0] === "GET") return { ok: true, json: async () => ({ result: bytes.toString("base64") }) };
      throw new Error(`UNEXPECTED_REDIS_COMMAND:${body[0]}`);
    },
  });
  await imageLedger.claimStart({ runId, appScopeId: D36_APP_SCOPE, bootstrapNonce: "6".repeat(64), inputSha256: "7".repeat(64), snapshot: { schema: "snapshot" }, referenceManifest: [manifest], accessExpiresAtMs: 1_788_192_360_000 });
  await imageLedger.putRunAsset({ runId, manifest, bytes });
  await imageLedger.reserveStep({ runId, checkpointPreimageSha256: "8".repeat(64), logicalStepId: "render-job-01", attemptNonce: "9".repeat(64), accessExpiresAtMs: 1_788_192_720_000 });

  const claim = commands.find((body) => body[0] === "EVAL" && String(body[1]).includes("snapshot_sha"));
  const asset = commands.find((body) => body[0] === "EVAL" && String(body[1]).includes("CAS_CONFLICT"));
  const step = commands.find((body) => body[0] === "EVAL" && String(body[1]).includes("required_remaining"));
  assert.equal(claim[2], "2");
  assert.equal(asset[2], "3");
  assert.equal(step[2], "3");
  for (const command of [claim, asset, step]) {
    assert.match(String(command[1]), /SADD/);
    assert.match(String(command[1]), /inventory_count|xiaoshimei\.d36-key-inventory\.v1/);
  }
  assert.match(String(asset[1]), /redis\.call\(['"]SET['"], KEYS\[3\]/);
  assert.match(String(step[1]), /redis\.call\(['"]HSET['"], KEYS\[3\]/);
  assert.match(String(step[1]), /physical_expire_at[\s\S]*PEXPIREAT[\s\S]*KEYS\[3\][\s\S]*physical_expire_at/);
  assert.equal(asset[3].replace(/:meta$/, ":inventory"), asset[4]);
  assert.equal(step[3].replace(/:meta$/, ":inventory"), step[4]);
});

test("D36 reserve resolves exact committed or late action cache before current cursor and rejects a different attempt", async () => {
  const commands = [];
  const cachedResponse = { status: "PARTIAL", run_id: "cached-run" };
  const imageLedger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      commands.push(body);
      if (body[0] === "EVAL") return { ok: true, json: async () => ({ result: ["CACHED", "COMMITTED"] }) };
      if (body[0] === "HGET") return { ok: true, json: async () => ({ result: JSON.stringify(cachedResponse) }) };
      throw new Error(`UNEXPECTED_REDIS_COMMAND:${body[0]}`);
    },
  });
  const reserved = await imageLedger.reserveStep({ runId: "images-2026-09-01T00-00-00-000Z-acde1234", checkpointPreimageSha256: "a".repeat(64), logicalStepId: "render-job-01", attemptNonce: "b".repeat(64), accessExpiresAtMs: 1_788_192_720_000 });
  assert.equal(reserved.status, "CACHED");
  assert.equal(reserved.cacheKind, "COMMITTED");
  assert.deepEqual(reserved.cachedResponse, cachedResponse);
  const lua = String(commands.find((body) => body[0] === "EVAL")[1]);
  const oldActionIndex = lua.indexOf("EXISTS', KEYS[3]");
  const runCursorIndex = lua.indexOf("HGET', KEYS[1], 'checkpoint_sha'");
  assert.ok(oldActionIndex >= 0 && runCursorIndex > oldActionIndex, "existing action must be resolved before current run cursor");
  assert.match(lua, /attempt_nonce'[\s\S]*NONCE_CONFLICT/);
  assert.match(lua, /action_status == 'COMMITTED' or action_status == 'LATE_RESULT'[\s\S]*CACHED/);
});

test("D36 committed replay returns the old exact cache even after the run cursor has advanced", async () => {
  const ledger = new FakeD36ImageLedger();
  const run = ledger.seedReadyRun({ runId: "image-run-d36-advanced-cursor-cache" });
  const input = d36StepInput(run);
  const cachedResponse = {
    schema: "xiaoshimei.image-generation-response.v1",
    status: "READY",
    bootstrap_nonce: run.bootstrapNonce,
    input_sha256: run.inputSha256,
    run_id: run.runId,
    checkpoint_preimage: structuredClone(run.checkpointPreimage),
    checkpoint_preimage_sha256: run.checkpointPreimageSha256,
    logical_step_id: run.logicalStepId,
    progress: { state: "READY" },
    assets: [],
    media_delta: [],
    error: null,
    cached: false,
    recoverable_until: run.recoverableUntil,
    upstream_calls: 1,
  };
  ledger.reserveStep = async () => ({ status: "CACHED", cacheKind: "COMMITTED", cachedResponse });
  run.checkpointPreimageSha256 = "f".repeat(64);
  run.logicalStepId = "render-job-02";
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    const replay = await d36Transaction()(input, D36_SETTINGS, { imageLedger: ledger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_720_000, appScopeId: D36_APP_SCOPE });
    assert.equal(replay.status, "READY");
    assert.equal(replay.cached, true);
    assert.equal(replay.upstream_calls, 0);
    assert.equal(replay.checkpoint_preimage_sha256, cachedResponse.checkpoint_preimage_sha256);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
});

test("D36 late owner commit stores a recovery-only result, keeps run UNKNOWN, and returns only non-actionable LATE_RESULT on replay", async () => {
  const runId = "images-2026-09-01T00-00-00-000Z-feed1234";
  const checkpointSha = "c".repeat(64);
  const logicalStepId = "render-job-01";
  const attemptNonce = "d".repeat(64);
  const actionId = createHash("sha256").update(`xiaoshimei-image-step-v1\0${runId}\0${checkpointSha}\0${logicalStepId}`).digest("hex");
  const response = { status: "PARTIAL", run_id: runId, upstream_calls: 1 };
  const commands = [];
  const imageLedger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      commands.push(body);
      if (body[0] === "EVAL") return { ok: true, json: async () => ({ result: ["LATE_RESULT"] }) };
      throw new Error(`UNEXPECTED_REDIS_COMMAND:${body[0]}`);
    },
  });
  const late = await imageLedger.commitStep({ runId, checkpointPreimageSha256: checkpointSha, logicalStepId, attemptNonce, actionId, ownerToken: "original-owner", fence: 1, compactRun: { run_id: runId }, checkpointPreimage: { schema: "checkpoint" }, nextCheckpointPreimageSha256: "e".repeat(64), nextLogicalStepId: "render-job-02", response, status: "PARTIAL" });
  assert.equal(late.status, "LATE_RESULT");
  const commitLua = String(commands.find((body) => body[0] === "EVAL")[1]);
  const lateBranch = commitLua.slice(commitLua.indexOf("if now_ms >"), commitLua.indexOf("return {'LATE_RESULT'}") + 24);
  assert.match(lateBranch, /status', 'LATE_RESULT'/);
  assert.match(lateBranch, /result_sha'[\s\S]*result_json'[\s\S]*recovery_only', '1'/);
  assert.match(lateBranch, /KEYS\[1\], 'status', 'UNKNOWN'/);
  assert.doesNotMatch(lateBranch, /checkpoint_json|run_json/);

  const fixture = new FakeD36ImageLedger();
  const run = fixture.seedReadyRun({ runId: "image-run-d36-late-replay" });
  const stepInput = d36StepInput(run);
  fixture.reserveStep = async () => ({ status: "CACHED", cacheKind: "LATE_RESULT", cachedResponse: { ...response, status: "PARTIAL" } });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    const replay = await d36Transaction()(stepInput, D36_SETTINGS, { imageLedger: fixture, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_720_000, appScopeId: D36_APP_SCOPE });
    assert.equal(replay.status, "LATE_RESULT");
    assert.equal(replay.progress.recovery_only, true);
    assert.deepEqual(replay.assets, []);
    assert.deepEqual(replay.media_delta, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
});

test("D36 real reserve uses Redis TIME and aligned run/inventory/step TTL gates before any paid upstream", async () => {
  const fixture = new FakeD36ImageLedger();
  const run = fixture.seedReadyRun({ runId: "image-run-d36-expiry-margin" });
  const input = d36StepInput(run);
  const redisCommands = [];
  const record = [
    "status", "READY", "app_scope", D36_APP_SCOPE, "bootstrap_nonce", run.bootstrapNonce, "input_sha", run.inputSha256,
    "recoverable_until_ms", String(Date.parse(run.recoverableUntil)), "snapshot_json", JSON.stringify(run.snapshot),
    "manifest_json", JSON.stringify(run.referenceManifest), "run_json", JSON.stringify(run.compactRun),
    "checkpoint_json", JSON.stringify(run.checkpointPreimage), "checkpoint_sha", run.checkpointPreimageSha256,
    "logical_step_id", run.logicalStepId,
  ];
  const imageLedger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    productionReadiness: D36_PRODUCTION_READINESS,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      redisCommands.push(body);
      if (body[0] === "PING") return { ok: true, json: async () => ({ result: "PONG" }) };
      if (body[0] === "EVAL" && String(body[1]).includes("HGETALL")) return { ok: true, json: async () => ({ result: ["FOUND", ...record] }) };
      if (body[0] === "EVAL" && String(body[1]).includes("reservation_count")) return { ok: true, json: async () => ({ result: ["RUN_EXPIRY_WINDOW_TOO_SHORT"] }) };
      throw new Error(`UNEXPECTED_REDIS_COMMAND:${body[0]}`);
    },
  });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    await assert.rejects(
      () => d36Transaction()(input, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_720_000, appScopeId: D36_APP_SCOPE }),
      /RUN_EXPIRY_WINDOW_TOO_SHORT/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  const reserve = redisCommands.find((body) => body[0] === "EVAL" && String(body[1]).includes("required_remaining = tonumber(ARGV[5])"));
  const lua = String(reserve[1]);
  assert.match(lua, /redis\.call\(['"]TIME['"]\)/);
  assert.match(lua, /required_remaining = tonumber\(ARGV\[5\]\) \+ tonumber\(ARGV\[6\]\)/);
  assert.match(lua, /PTTL', KEYS\[1\]/);
  assert.match(lua, /PTTL', KEYS\[2\]/);
  assert.match(lua, /PEXPIREAT', KEYS\[3\], physical_expire_at/);
  assert.match(lua, /PEXPIREAT', KEYS\[2\], physical_expire_at/);
  assert.equal(upstreamCalls, 0);
});

test("D36 authenticated raw asset route returns exact private bytes and rejects unauthenticated or forged membership without Provider", async () => {
  const env = accessEnv();
  const nowMs = 1_788_192_000_000;
  const accessConfig = inspectServerAccessConfig(env);
  const session = mintAccessSession(accessConfig, { nowMs, sessionId: "session-d36-raw-asset" });
  const cookie = `${session.cookieName}=${session.token}`;
  const imageLedger = new FakeD36ImageLedger();
  const run = imageLedger.seedReadyRun({ runId: "image-run-d36-raw-asset" });
  run.appScopeId = accessConfig.appScope;
  const bytes = await d36ReferenceBytes();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = { schema: "xiaoshimei.media-asset-manifest.v1", media_ref: `xiaoshimei-media://sha256/${sha256}`, sha256, size_bytes: bytes.length, mime: "image/jpeg", name: "raw asset", width: 96, height: 128 };
  await imageLedger.putRunAsset({ runId: run.runId, manifest, bytes });
  const rawHandler = createProviderHandler({ env, nowMs, imageLedger });
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  const header = (response, name) => Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  try {
    const { origin: _normalGetOmitsOrigin, ...browserGetHeaders } = sameOriginHeaders(env, { cookie });
    const accepted = responseProbe();
    await rawHandler({ method: "GET", query: { route: `assets/${run.runId}/${sha256}` }, headers: browserGetHeaders }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(Buffer.from(accepted.body), bytes);
    assert.equal(header(accepted, "content-type"), "image/jpeg");
    assert.equal(Number(header(accepted, "content-length")), bytes.length);
    assert.equal(header(accepted, "x-content-sha256"), sha256);
    assert.match(String(header(accepted, "cache-control")), /private/);
    assert.match(String(header(accepted, "cache-control")), /no-store/);
    assert.equal(header(accepted, "x-content-type-options"), "nosniff");
    assert.equal(header(accepted, "access-control-allow-origin"), undefined);

    for (const headers of [
      sameOriginHeaders(env, { cookie, origin: "https://attacker.example" }),
      sameOriginHeaders(env, { cookie, "sec-fetch-site": "cross-site" }),
    ]) {
      const rejectedRead = responseProbe();
      await rawHandler({ method: "GET", query: { route: `assets/${run.runId}/${sha256}` }, headers }, rejectedRead);
      assert.equal(rejectedRead.statusCode, 403);
    }

    const anonymous = responseProbe();
    const { origin: _anonymousGetOmitsOrigin, ...anonymousGetHeaders } = sameOriginHeaders(env);
    await rawHandler({ method: "GET", query: { route: `assets/${run.runId}/${sha256}` }, headers: anonymousGetHeaders }, anonymous);
    assert.equal(anonymous.statusCode, 401);

    const forged = responseProbe();
    await rawHandler({ method: "GET", query: { route: `assets/${run.runId}/${"f".repeat(64)}` }, headers: sameOriginHeaders(env, { cookie }) }, forged);
    assert.notEqual(forged.statusCode, 200);
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
  assert.equal(imageLedger.readAssetCalls, 2);
});

test("D36 seventh paid image action is rejected before Provider", async () => {
  const transact = d36Transaction();
  const imageLedger = new FakeD36ImageLedger();
  const run = imageLedger.seedReadyRun({ runId: "image-run-d36-budget", paidCalls: 6 });
  const input = d36StepInput(run);
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    await assert.rejects(
      () => transact(input, D36_SETTINGS, { imageLedger, nowMs: 1_788_192_000_000, accessExpiresAtMs: 1_788_192_360_000, appScopeId: D36_APP_SCOPE }),
      /IMAGE_CALL_BUDGET_EXHAUSTED|BUDGET_EXHAUSTED/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(upstreamCalls, 0);
});

test("D36 physical capacity releases only after exact DEL and absence readback", async () => {
  const bytes = await d36ReferenceBytes();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const blocked = new FakeD36ImageLedger({ retainPhysicalKeys: true });
  const blockedRun = blocked.seedReadyRun({ runId: "image-run-d36-cleanup-blocked" });
  blockedRun.status = "UNKNOWN";
  const manifest = { schema: "xiaoshimei.media-asset-manifest.v1", media_ref: `xiaoshimei-media://sha256/${sha256}`, sha256, size_bytes: bytes.length, mime: "image/jpeg", name: "cleanup asset", width: 96, height: 128 };
  await blocked.putRunAsset({ runId: blockedRun.runId, manifest, bytes });
  const retained = await blocked.cleanupRun({ runId: blockedRun.runId });
  assert.equal(retained.released, false);
  assert.equal(blocked.releasedRuns.has(blockedRun.runId), false);
  assertOrdered(blocked.events, ["ledger:cleanup:DEL", "ledger:cleanup:ABSENCE_READBACK"]);
  assert.equal(blocked.events.includes("ledger:cleanup:RELEASE_CAPACITY"), false);

  const released = new FakeD36ImageLedger();
  const releasedRun = released.seedReadyRun({ runId: "image-run-d36-cleanup-released" });
  releasedRun.status = "COMPLETE";
  await released.putRunAsset({ runId: releasedRun.runId, manifest, bytes });
  const result = await released.cleanupRun({ runId: releasedRun.runId });
  assert.equal(result.released, true);
  assertOrdered(released.events, ["ledger:cleanup:DEL", "ledger:cleanup:ABSENCE_READBACK", "ledger:cleanup:RELEASE_CAPACITY"]);
});

test("D36 direct cleanup helper proves only physical absence and never claims global capacity release", async () => {
  const commands = [];
  const runId = "images-2026-09-01T00-00-00-000Z-deadbeef";
  const root = `xiaoshimei:image-d36:{${runId}}`;
  const keys = [`${root}:meta`, `${root}:inventory`, `${root}:asset:${"a".repeat(64)}`].sort();
  const imageLedger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      commands.push(body);
      const command = body[0];
      if (command === "EXISTS") return { ok: true, json: async () => ({ result: 0 }) };
      if (command === "EVAL") return { ok: true, json: async () => ({ result: ["FROZEN", ...keys] }) };
      if (command === "SCAN") return { ok: true, json: async () => ({ result: ["0", [...keys].reverse()] }) };
      if (command === "DEL") return { ok: true, json: async () => ({ result: keys.length }) };
      throw new Error(`UNEXPECTED_REDIS_COMMAND:${command}`);
    },
  });
  assert.equal(typeof imageLedger.cleanupRun, "function", "Upstash image ledger must expose cleanupRun");
  const result = await imageLedger.cleanupRun({ runId });
  assert.equal(result.status, "PHYSICAL_ABSENT_READBACK");
  assert.equal(result.physicalReleased, true);
  assert.equal(result.released, false);
  assert.deepEqual(result.keys, keys);

  const flatCommands = commands.map((body) => body[0]);
  const delIndex = flatCommands.indexOf("DEL");
  const existsIndex = flatCommands.indexOf("EXISTS");
  const lua = commands.filter((body) => body[0] === "EVAL").map((body) => String(body[1])).join("\n");
  const luaDel = lua.search(/redis\.call\(['\"]DEL['\"]/);
  const luaExists = lua.search(/redis\.call\(['\"]EXISTS['\"]/);
  const separateProof = delIndex >= 0 && existsIndex > delIndex;
  const atomicProof = luaDel >= 0 && luaExists > luaDel;
  assert.equal(separateProof || atomicProof, true, "cleanup must prove DEL precedes physical absence readback");
  assert.equal(flatCommands.filter((command) => command === "EXISTS").length, keys.length);
});

test("D36 signed expiry finalizer waits through 7d-1ms, then releases capacity only after exact DEL and root absence", async () => {
  const nowMs = 1_788_192_000_000;
  for (const due of [false, true]) {
    const accessEnv = {
      XIAOSHIMEI_ACCESS_CODE_SHA256: "a".repeat(64),
      XIAOSHIMEI_SESSION_SECRET: "s".repeat(64),
      XIAOSHIMEI_APP_ORIGIN: "https://xiaoshimei.example",
    };
    const appScope = inspectServerAccessConfig(accessEnv).appScope;
    const signed = signedRuntimeAttestation({ nowMs, appScope });
    const tag = createHash("sha256").update(appScope).digest("hex").slice(0, 32);
    const productRoot = "xiaoshimei:image-d37:{xiaoshimei-studio-v2}";
    const appRoot = `${productRoot}:scope:${tag}`;
    const runId = "images-2026-09-01T00-00-00-000Z-deadbeef";
    const runRoot = `${appRoot}:run:${runId}`;
    const meta = `${runRoot}:meta`;
    const inventory = `${runRoot}:inventory`;
    const asset = `${runRoot}:asset:${"a".repeat(64)}`;
    const keys = [asset, inventory, meta].sort();
    const expiry = `${appRoot}:expiry`;
    const readiness = `${appRoot}:readiness`;
    const capacity = `${productRoot}:capacity`;
    const member = `${meta}|${signed.envelope.payload.capacity_generation}|${signed.envelope.payload.worst_case_run_bytes}`;
    const commands = [];
    let physicalPresent = true;
    let capacityReleased = false;
    const ledger = createUpstashImageLedgerFromEnv({
      ...accessEnv,
      UPSTASH_REDIS_REST_URL: "https://fake.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "runtime-rest-token-123456",
      XIAOSHIMEI_LEDGER_ATTESTATION_PUBLIC_KEY: signed.publicKey,
      XIAOSHIMEI_UPSTASH_DATABASE_ID_SHA256: signed.envelope.payload.database_id_sha256,
      XIAOSHIMEI_VERCEL_PROJECT_ID: signed.envelope.payload.vercel_project_id,
      VERCEL_ENV: signed.envelope.payload.vercel_environment,
      XIAOSHIMEI_CANDIDATE_COMMIT: signed.envelope.payload.candidate_commit,
    }, {
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        commands.push(body);
        let result;
        if (body[0] === "TIME") result = [String(Math.floor(nowMs / 1000)), String((nowMs % 1000) * 1000)];
        else if (body[0] === "GET" && body[1] === readiness) result = JSON.stringify(signed.envelope);
        else if (body[0] === "ZRANGEBYSCORE") result = due ? [member] : [];
        else if (body[0] === "EXISTS") result = physicalPresent && keys.includes(body[1]) ? 1 : 0;
        else if (body[0] === "SCAN") result = ["0", physicalPresent ? [...keys].reverse() : []];
        else if (body[0] === "DEL") { physicalPresent = false; result = keys.length; }
        else if (body[0] === "EVAL" && String(body[1]).includes("cleanup_from_status")) result = ["FROZEN", ...keys];
        else if (body[0] === "EVAL" && String(body[1]).includes("live_reservations")) { capacityReleased = true; result = ["RELEASED"]; }
        else throw new Error(`UNEXPECTED_FINALIZER_COMMAND:${body.join(":")}`);
        return { ok: true, json: async () => ({ result }) };
      },
    });
    const result = await ledger.finalizeExpiredRuns({ appScopeId: appScope });
    if (!due) {
      assert.deepEqual(result, []);
      assert.equal(commands.some((body) => body[0] === "DEL"), false, "7d-1ms must retain every physical key");
      assert.equal(capacityReleased, false);
      continue;
    }
    assert.equal(result.length, 1);
    assert.equal(result[0].released, true);
    assert.equal(capacityReleased, true);
    const sequence = commands.map((body) => body[0]);
    const delAt = sequence.indexOf("DEL");
    const releaseAt = commands.findIndex((body) => body[0] === "EVAL" && String(body[1]).includes("live_reservations"));
    assert.equal(delAt >= 0 && releaseAt > delAt, true);
    assert.equal(commands.slice(delAt + 1, releaseAt).some((body) => body[0] === "EXISTS"), true);
    assert.equal(commands.slice(delAt + 1, releaseAt).some((body) => body[0] === "SCAN"), true);
    assert.equal(commands.find((body) => body[0] === "EVAL" && String(body[1]).includes("live_reservations"))[3], capacity);
    assert.equal(commands.find((body) => body[0] === "EVAL" && String(body[1]).includes("live_reservations"))[4], expiry);
  }
});

test("D36 Upstash cleanup freezes only terminal runs and refuses missing or physically incomplete inventory without DEL", async () => {
  const runId = "images-2026-09-01T00-00-00-000Z-facecafe";
  const root = `xiaoshimei:image-d36:{${runId}}`;
  const meta = `${root}:meta`;
  const inventory = `${root}:inventory`;
  for (const refusal of ["INVENTORY_MISSING", "NON_TERMINAL"]) {
    const commands = [];
    const ledger = createUpstashImageLedger({
      url: "https://ledger.example",
      token: "upstash-token-for-test",
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        commands.push(body);
        return { ok: true, json: async () => ({ result: [refusal] }) };
      },
    });
    const result = await ledger.cleanupRun({ runId });
    assert.equal(result.status, refusal);
    assert.equal(result.released, false);
    assert.equal(commands.some((body) => body[0] === "DEL"), false);
  }

  const commands = [];
  const ledger = createUpstashImageLedger({
    url: "https://ledger.example",
    token: "upstash-token-for-test",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      commands.push(body);
      if (body[0] === "EVAL") return { ok: true, json: async () => ({ result: ["FROZEN", meta, inventory] }) };
      if (body[0] === "SCAN") return { ok: true, json: async () => ({ result: ["0", [meta, inventory, `${root}:rogue`]] }) };
      throw new Error(`UNEXPECTED_REDIS_COMMAND:${body[0]}`);
    },
  });
  const incomplete = await ledger.cleanupRun({ runId });
  assert.equal(incomplete.status, "INVENTORY_INCOMPLETE");
  assert.equal(incomplete.released, false);
  assert.equal(commands.some((body) => body[0] === "DEL"), false);
  const freezeLua = String(commands.find((body) => body[0] === "EVAL")[1]);
  assert.match(freezeLua, /COMPLETE'[\s\S]*UNKNOWN'[\s\S]*CLEANUP_FROZEN/);
  assert.match(freezeLua, /inventory_count/);
  assert.match(freezeLua, /SMEMBERS/);
});

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

function sameOriginHeaders(env, extra = {}) {
  const origin = new URL(env.XIAOSHIMEI_APP_ORIGIN);
  return {
    origin: origin.origin,
    host: origin.host,
    "x-forwarded-host": origin.host,
    "x-forwarded-proto": "https",
    "sec-fetch-site": "same-origin",
    ...extra,
  };
}

function setCookieValues(response) {
  const value = response.headers["set-cookie"];
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cookiePairFromSetCookie(value) {
  return String(value).split(";", 1)[0];
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

test("server-managed access login mints a canonical token-bound __Host slot after exact same-origin admission", async () => {
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
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: sameOriginHeaders(env, { origin: "https://attacker.example" }), get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, denied);
  assert.equal(denied.statusCode, 403);

  const wrongCode = responseProbe();
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: sameOriginHeaders(env), body: { code: "wrong" } }, wrongCode);
  assert.equal(wrongCode.statusCode, 401);
  assert.equal(wrongCode.headers["set-cookie"], undefined);

  const login = responseProbe();
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: sameOriginHeaders(env), body: { code: "open-sesame" } }, login);
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.authenticated, true);
  const setCookie = setCookieValues(login).at(-1);
  assert.match(setCookie, new RegExp(`^${ACCESS_SESSION_COOKIE}[0-9a-f]{32}=`));
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.match(setCookie, /; Max-Age=43200/);
  assert.equal(setCookie.includes("Expires="), false);
  assert.equal(setCookie.includes("Domain="), false);

  const cookie = cookiePairFromSetCookie(setCookie);
  const authenticated = responseProbe();
  await accessHandler({ method: "GET", query: { route: "config" }, headers: { cookie } }, authenticated);
  assert.equal(authenticated.body.authenticated, true);
});

test("access tokens are canonical, app/origin bound, name bound, and header order independent", async () => {
  const env = accessEnv();
  const nowMs = Date.now();
  const accessConfig = inspectServerAccessConfig(env);
  const first = mintAccessSession(accessConfig, { nowMs, sessionId: "session-canonical-first" });
  const later = mintAccessSession(accessConfig, { nowMs: nowMs + 1_000, sessionId: "session-canonical-later" });
  assert.equal(verifyAccessSession(first.token, accessConfig, { nowMs }), true);
  assert.equal(verifyAccessSession(`${first.token}=`, accessConfig, { nowMs }), false);
  assert.equal(verifyAccessSession(first.token.replace(".", "=."), accessConfig, { nowMs }), false);
  assert.equal(verifyAccessSession(first.token, inspectServerAccessConfig({ ...env, XIAOSHIMEI_APP_ORIGIN: "https://other.example" }), { nowMs }), false);

  const validFirst = `${first.cookieName}=${first.token}`;
  const validLater = `${later.cookieName}=${later.token}`;
  const forgedSameName = `${first.cookieName}=${first.token.slice(0, -1)}x`;
  for (const cookie of [
    `${forgedSameName}; ${validFirst}; ${validLater}`,
    `${validLater}; ${validFirst}; ${forgedSameName}`,
  ]) {
    const inspected = inspectAccessSessionCandidates(cookie, accessConfig, { nowMs });
    assert.equal(inspected.authenticated, true);
    assert.equal(inspected.valid.length, 2);
    assert.equal(inspected.preferred.token, later.token);
    assert.equal(inspected.capabilityExpiresAtMs, later.expiresAt.getTime());
  }

  const mismatchedSuffix = later.cookieName.endsWith("0") ? "1" : "0";
  const mismatchedName = `${later.cookieName.slice(0, -1)}${mismatchedSuffix}=${later.token}`;
  assert.equal(inspectAccessSessionCandidates(mismatchedName, accessConfig, { nowMs }).authenticated, false);
});

test("GET config is a pure no-store readback for duplicate, overflow, and oversized Cookie headers", async () => {
  const env = accessEnv();
  const nowMs = Date.now();
  const accessConfig = inspectServerAccessConfig(env);
  const session = mintAccessSession(accessConfig, { nowMs, sessionId: "session-config-readback" });
  const valid = `${session.cookieName}=${session.token}`;
  const family = Array.from({ length: 17 }, (_, index) => `${ACCESS_SESSION_COOKIE}${String(index).padStart(32, "0")}=${index}`).join("; ");
  const oversized = `other=${"x".repeat(8_193)}`;
  const accessHandler = createProviderHandler({ env, nowMs });
  for (const cookie of [valid, `${valid}; ${valid}`, family, oversized]) {
    const response = responseProbe();
    await accessHandler({ method: "GET", query: { route: "config" }, headers: { cookie } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(setCookieValues(response).length, 0);
  }
});

test("correct-code login can bounded-clean 17 visible family groups while wrong code writes zero cookies", async () => {
  const env = accessEnv();
  const nowMs = Date.now();
  const accessHandler = createProviderHandler({ env, nowMs, sessionId: "session-overflow-recovery" });
  const family = Array.from({ length: 17 }, (_, index) => `${ACCESS_SESSION_COOKIE}${index.toString(16).padStart(32, "0")}=${index}`).join("; ");

  const wrong = responseProbe();
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: sameOriginHeaders(env, { cookie: family }), body: { code: "wrong" } }, wrong);
  assert.equal(wrong.statusCode, 401);
  assert.equal(setCookieValues(wrong).length, 0);

  const recovered = responseProbe();
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: sameOriginHeaders(env, { cookie: family }), body: { code: "open-sesame" } }, recovered);
  assert.equal(recovered.statusCode, 200);
  const writes = setCookieValues(recovered);
  assert.equal(writes.length, 17);
  assert.equal(writes.slice(0, -1).every((value) => /Max-Age=0/.test(value)), true);
  assert.match(writes.at(-1), new RegExp(`^${ACCESS_SESSION_COOKIE}[0-9a-f]{32}=`));
  assert.equal(/Max-Age=43200/.test(writes.at(-1)), true);
});

test("business admission enforces same-origin metadata and Cookie limits before body, ledger, or Provider", async () => {
  const env = accessEnv();
  const nowMs = Date.now();
  const configValue = inspectServerAccessConfig(env);
  const session = mintAccessSession(configValue, { nowMs, sessionId: "session-business-bounds" });
  const valid = `${session.cookieName}=${session.token}`;
  let ledgerCalls = 0;
  let upstreamCalls = 0;
  const boundedHandler = createProviderHandler({
    env,
    nowMs,
    imageLedger: async () => { ledgerCalls += 1; throw new Error("LEDGER_MUST_NOT_RUN"); },
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    for (const headers of [
      { ...sameOriginHeaders(env, { cookie: valid }), "sec-fetch-site": "cross-site" },
      { ...sameOriginHeaders(env, { cookie: valid }), host: "attacker.example" },
      { ...sameOriginHeaders(env, { cookie: valid }), "x-forwarded-host": "attacker.example" },
      { ...sameOriginHeaders(env, { cookie: valid }), "x-forwarded-proto": "http" },
    ]) {
      const response = responseProbe();
      await boundedHandler({ method: "POST", query: { route: "generate-images" }, headers, get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, response);
      assert.equal(response.statusCode, 403);
    }

    const family = Array.from({ length: 17 }, (_, index) => `${ACCESS_SESSION_COOKIE}${index.toString(16).padStart(32, "0")}=${index}`).join("; ");
    const tooMany = responseProbe();
    await boundedHandler({ method: "POST", query: { route: "generate-images" }, headers: sameOriginHeaders(env, { cookie: family }), get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, tooMany);
    assert.equal(tooMany.statusCode, 431);
    assert.equal(tooMany.body.error, "ACCESS_SESSION_CANDIDATE_LIMIT_EXCEEDED");

    const oversized = responseProbe();
    await boundedHandler({ method: "POST", query: { route: "generate-images" }, headers: sameOriginHeaders(env, { cookie: `other=${"x".repeat(8_193)}` }), get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, oversized);
    assert.equal(oversized.statusCode, 431);
    assert.equal(oversized.body.error, "COOKIE_HEADER_TOO_LARGE");
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(ledgerCalls, 0);
  assert.equal(upstreamCalls, 0);
});

test("server-managed business admission rejects invalid bodies before Redis and absent Redis before Provider", async () => {
  const env = accessEnv();
  const nowMs = Date.now();
  const accessHandler = createProviderHandler({ env, nowMs, sessionId: "session-id-for-test" });
  const login = responseProbe();
  await accessHandler({ method: "POST", query: { route: "access-session" }, headers: sameOriginHeaders(env), body: { code: "open-sesame" } }, login);
  const cookie = cookiePairFromSetCookie(setCookieValues(login).at(-1));
  let upstreamCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("UPSTREAM_MUST_NOT_RUN"); };
  try {
    const crossOrigin = responseProbe();
    await accessHandler({ method: "POST", query: { route: "text-draft" }, headers: sameOriginHeaders(env, { origin: "https://attacker.example", cookie }), get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, crossOrigin);
    assert.equal(crossOrigin.statusCode, 403);

    const anonymous = responseProbe();
    await accessHandler({ method: "POST", query: { route: "text-draft" }, headers: sameOriginHeaders(env), get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, anonymous);
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.body.error, "ACCESS_SESSION_REQUIRED");

    const candidates = responseProbe();
    await accessHandler({ method: "POST", query: { route: "page-candidates" }, headers: sameOriginHeaders(env, { cookie }), get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, candidates);
    assert.equal(candidates.statusCode, 403);
    assert.equal(candidates.body.error, "SERVER_MANAGED_PAGE_CANDIDATES_DISABLED");

    let malformedLedgerCalls = 0;
    const parseFirstHandler = createProviderHandler({
      env,
      nowMs,
      imageLedger: async () => { malformedLedgerCalls += 1; return new FakeD36ImageLedger(); },
    });
    const malformed = responseProbe();
    await parseFirstHandler({ method: "POST", query: { route: "generate-images" }, headers: sameOriginHeaders(env, { cookie }), body: { schema: "wrong" } }, malformed);
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformedLedgerCalls, 0);

    const validImageBody = { schema: "xiaoshimei.image-generation-request.v1", input: await d36StartInput() };
    const images = responseProbe();
    await accessHandler({ method: "POST", query: { route: "generate-images" }, headers: sameOriginHeaders(env, { cookie }), body: validImageBody }, images);
    assert.equal(images.statusCode, 503);
    assert.equal(images.body.error, "IMAGE_LEDGER_CONFIGURATION_REQUIRED");

    let ledgerCalls = 0;
    const ledgerDownHandler = createProviderHandler({
      env: { ...env, UPSTASH_REDIS_REST_URL: "https://ledger.example", UPSTASH_REDIS_REST_TOKEN: "upstash-token-for-test" },
      nowMs,
      ledgerFetchImpl: async () => { ledgerCalls += 1; return { ok: false, json: async () => ({ error: "DOWN" }) }; },
    });
    const ledgerDown = responseProbe();
    await ledgerDownHandler({ method: "POST", query: { route: "generate-images" }, headers: sameOriginHeaders(env, { cookie }), body: validImageBody }, ledgerDown);
    assert.equal(ledgerDown.statusCode, 503);
    assert.equal(ledgerDown.body.error, "ARK_PROBE_FAILED");
    assert.equal(ledgerDown.body.code, "IMAGE_LEDGER_UNAVAILABLE");
    assert.equal(ledgerCalls, 1);

    const forged = responseProbe();
    await accessHandler({ method: "POST", query: { route: "text-draft" }, headers: sameOriginHeaders(env, { cookie: `${cookie}x` }), get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, forged);
    assert.equal(forged.statusCode, 401);

    const expiredHandler = createProviderHandler({ env, nowMs: nowMs + (ACCESS_SESSION_TTL_SECONDS + 1) * 1000 });
    const expired = responseProbe();
    await expiredHandler({ method: "POST", query: { route: "text-draft" }, headers: sameOriginHeaders(env, { cookie }), get body() { throw new Error("BODY_MUST_NOT_BE_PARSED"); } }, expired);
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
  const stepInput = {
    mode: "STEP",
    run_id: "image-run-contract-0001",
    checkpoint_preimage: { schema: "xiaoshimei.image-checkpoint.v1", cursor: 1 },
    checkpoint_preimage_sha256: "d".repeat(64),
    logical_step_id: "render-page-2",
    attempt_nonce: "e".repeat(64),
  };
  const mediaSha256 = "c".repeat(64);
  const response = {
    schema: "xiaoshimei.image-generation-response.v1",
    status: "PARTIAL",
    bootstrap_nonce: "a".repeat(64),
    input_sha256: "b".repeat(64),
    run_id: stepInput.run_id,
    checkpoint_preimage: { schema: "xiaoshimei.image-checkpoint.v1", cursor: 2 },
    checkpoint_preimage_sha256: "f".repeat(64),
    logical_step_id: "render-page-3",
    progress: { completed_steps: 2, total_steps: 3 },
    assets: [],
    media_delta: [{
      schema: "xiaoshimei.media-asset-manifest.v1",
      media_ref: `xiaoshimei-media://sha256/${mediaSha256}`,
      sha256: mediaSha256,
      size_bytes: 3,
      mime: "image/jpeg",
      name: "第二页配图",
      width: 3,
      height: 4,
      asset_url: `/api/provider/assets/${stepInput.run_id}/${mediaSha256}`,
    }],
    error: null,
    cached: false,
    recoverable_until: "2026-09-08T00:00:00.000Z",
    upstream_calls: 1,
  };
  let fetches = 0;
  const provider = createLocalHttpProvider({
    endpoint: "http://127.0.0.1:9909/generate",
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => response };
    },
  });
  await assert.rejects(
    () => provider.generateImages(stepInput, async () => ({ action: "STOP" })),
    (error) => error.providerCode === "IMAGE_RUN_STOPPED_AFTER_CHECKPOINT"
      && error.checkpointPersisted === true
      && error.intentionalStop === true
      && error.providerDetails?.run_id === stepInput.run_id,
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
