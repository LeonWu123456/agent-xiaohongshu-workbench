import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function field(value, ...names) {
  for (const name of names) if (value && Object.prototype.hasOwnProperty.call(value, name)) return value[name];
  return undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function copy(value) {
  return value == null ? value : structuredClone(value);
}

export class LocalImageLedger {
  constructor({ statePath = "" } = {}) {
    this.statePath = statePath;
    this.runs = new Map();
    this.bootstrap = new Map();
    this.assets = new Map();
    this.steps = new Map();
  }

  async load() {
    if (!this.statePath) return this;
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8"));
      this.runs = new Map(value.runs || []);
      this.bootstrap = new Map(value.bootstrap || []);
      this.steps = new Map(value.steps || []);
      this.assets = new Map((value.assets || []).map(([key, asset]) => [key, { ...asset, bytes: Buffer.from(asset.bytes_base64, "base64") }]));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this;
  }

  async persist() {
    if (!this.statePath) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    const assets = [...this.assets].map(([key, asset]) => [key, { ...asset, bytes: undefined, bytes_base64: Buffer.from(asset.bytes).toString("base64") }]);
    await writeFile(tempPath, `${JSON.stringify({ schema: "xiaoshimei.local-image-ledger.v1", runs: [...this.runs], bootstrap: [...this.bootstrap], steps: [...this.steps], assets }, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.statePath);
  }

  async assertProductionReady() {
    return { status: "READY", storage: "LOCAL_FILE", checked_at: new Date().toISOString() };
  }

  async claimStart(value = {}) {
    const appScopeId = String(field(value, "appScopeId", "app_scope_id") || "");
    const bootstrapNonce = String(field(value, "bootstrapNonce", "bootstrap_nonce") || "");
    const inputSha256 = String(field(value, "inputSha256", "input_sha256") || "");
    const key = `${appScopeId}:${bootstrapNonce}`;
    const existingId = this.bootstrap.get(key);
    if (existingId) {
      const existing = this.runs.get(existingId);
      if (!existing || existing.inputSha256 !== inputSha256) return { status: "CONFLICT", runId: existingId };
      return { status: existing.status, runId: existingId, ownerToken: existing.ownerToken, fence: existing.fence, recoverableUntil: existing.recoverableUntil, cached: true };
    }
    const runId = String(field(value, "runId", "run_id") || `image-run-local-${bootstrapNonce.slice(0, 16)}`);
    const run = {
      runId, appScopeId, bootstrapNonce, inputSha256, status: "MATERIALIZING",
      ownerToken: randomUUID(), fence: 1, paidCalls: 0,
      checkpointPreimage: null, checkpointPreimageSha256: null, logicalStepId: "planner",
      recoverableUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      snapshot: copy(field(value, "snapshot") || null),
      referenceManifest: copy(field(value, "referenceManifest", "reference_manifest") || []),
      compactRun: null, cachedResponse: null,
    };
    this.bootstrap.set(key, runId);
    this.runs.set(runId, run);
    await this.persist();
    return { status: "MATERIALIZING", runId, ownerToken: run.ownerToken, fence: run.fence, recoverableUntil: run.recoverableUntil };
  }

  async putRunAsset(value = {}) {
    const runId = String(field(value, "runId", "run_id") || "");
    const manifest = field(value, "manifest") || value;
    const bytes = Buffer.from(field(value, "bytes", "exactBytes", "exact_bytes") || []);
    const actualSha = sha256(bytes);
    if (!this.runs.has(runId)) return { status: "RUN_MISSING" };
    if (String(field(manifest, "sha256") || "") !== actualSha) return { status: "HASH_MISMATCH" };
    const key = `${runId}:${actualSha}`;
    this.assets.set(key, { runId, sha256: actualSha, bytes, mime: String(field(manifest, "mime") || "image/jpeg"), sizeBytes: bytes.length, manifest: copy(manifest), member: true });
    await this.persist();
    return { status: "STORED", runId, sha256: actualSha, sizeBytes: bytes.length, manifest: copy(manifest) };
  }

  async readRunAsset(value = {}) {
    const runId = String(field(value, "runId", "run_id") || "");
    const digest = String(field(value, "sha256") || "");
    const asset = this.assets.get(`${runId}:${digest}`);
    if (!asset) return { status: "MISSING" };
    if (sha256(asset.bytes) !== asset.sha256 || asset.bytes.length !== asset.sizeBytes) return { status: "CORRUPT" };
    return { status: "FOUND", ...copy({ ...asset, bytes: undefined }), bytes: Buffer.from(asset.bytes) };
  }

  async listRunAssets(value = {}) {
    const runId = String(field(value, "runId", "run_id") || "");
    const appScopeId = String(field(value, "appScopeId", "app_scope_id") || "");
    const run = this.runs.get(runId);
    if (!run) return { status: "RUN_MISSING", assets: [] };
    if (run.appScopeId !== appScopeId) return { status: "FORBIDDEN", assets: [] };
    const assets = [...this.assets.values()]
      .filter((asset) => asset.runId === runId && asset.member)
      .map((asset) => ({ ...copy({ ...asset, bytes: undefined }), bytes: Buffer.from(asset.bytes) }));
    return { status: "FOUND", assets };
  }

  async findUnknownStep(value = {}) {
    const runId = String(field(value, "runId", "run_id") || "");
    const checkpointSha = String(field(value, "checkpointPreimageSha256", "checkpoint_preimage_sha256") || "");
    const logicalStepId = String(field(value, "logicalStepId", "logical_step_id") || "");
    const actionId = `${runId}:${checkpointSha}:${logicalStepId}`;
    const step = this.steps.get(actionId);
    if (!step || step.status !== "UNKNOWN") return { status: "NOT_FOUND" };
    return { ...copy(step), status: "FOUND", stepStatus: step.status };
  }

  async claimPlanner(value = {}) {
    const run = this.runs.get(String(field(value, "runId", "run_id") || ""));
    if (!run) return { status: "RUN_MISSING" };
    if (new Set(["READY", "PARTIAL", "COMPLETE", "UNKNOWN", "PLANNER_FAILED"]).has(run.status)) return { status: run.status, runId: run.runId };
    run.status = "PLANNING";
    await this.persist();
    return { status: "PLANNING", runId: run.runId, ownerToken: run.ownerToken, fence: run.fence };
  }

  async markPlannerFailed(value = {}) {
    const run = this.runs.get(String(field(value, "runId", "run_id") || ""));
    if (!run || run.status !== "PLANNING") return { status: "CONFLICT" };
    run.status = "PLANNER_FAILED";
    run.plannerFailureCode = String(field(value, "errorCode", "error_code") || "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS");
    run.cachedResponse = copy(field(value, "response") || null);
    await this.persist();
    return { status: "COMMITTED" };
  }

  async markPlannerUnknown(value = {}) {
    const run = this.runs.get(String(field(value, "runId", "run_id") || ""));
    if (!run) return { status: "RUN_MISSING" };
    run.status = "UNKNOWN";
    await this.persist();
    return { status: "UNKNOWN" };
  }

  async commitPlanner(value = {}) {
    const run = this.runs.get(String(field(value, "runId", "run_id") || ""));
    if (!run) return { status: "RUN_MISSING" };
    run.status = "READY";
    run.compactRun = copy(field(value, "compactRun", "compact_run") || null);
    run.checkpointPreimage = copy(field(value, "checkpointPreimage", "checkpoint_preimage") || null);
    run.checkpointPreimageSha256 = String(field(value, "checkpointPreimageSha256", "checkpoint_preimage_sha256") || "");
    run.logicalStepId = String(field(value, "logicalStepId", "logical_step_id") || "");
    run.cachedResponse = copy(field(value, "response") || null);
    await this.persist();
    return { status: "COMMITTED", runId: run.runId };
  }

  async discover(value = {}) {
    const appScopeId = String(field(value, "appScopeId", "app_scope_id") || "");
    const bootstrapNonce = String(field(value, "bootstrapNonce", "bootstrap_nonce") || "");
    const explicitRunId = String(field(value, "runId", "run_id") || "");
    const runId = explicitRunId || this.bootstrap.get(`${appScopeId}:${bootstrapNonce}`);
    if (!runId) return { status: "NOT_FOUND" };
    const run = this.runs.get(runId);
    if (!run) return { status: "NOT_FOUND", runId };
    if (run.appScopeId !== appScopeId) return { status: "CONFLICT", runId };
    const inputSha256 = String(field(value, "inputSha256", "input_sha256") || "");
    if (inputSha256 && inputSha256 !== run.inputSha256) return { status: "CONFLICT", runId };
    return copy({ ...run, cached: new Set(["READY", "PARTIAL", "COMPLETE", "PLANNER_FAILED"]).has(run.status) });
  }

  async discoverByRun(value = {}) { return this.discover(value); }

  async reserveStep(value = {}) {
    const runId = String(field(value, "runId", "run_id") || "");
    const run = this.runs.get(runId);
    if (!run) return { status: "RUN_MISSING" };
    if (run.status === "UNKNOWN") return { status: "UNKNOWN" };
    const checkpointSha = String(field(value, "checkpointPreimageSha256", "checkpoint_preimage_sha256") || "");
    const logicalStepId = String(field(value, "logicalStepId", "logical_step_id") || "");
    const attemptNonce = String(field(value, "attemptNonce", "attempt_nonce") || "");
    if (run.checkpointPreimageSha256 !== checkpointSha || run.logicalStepId !== logicalStepId) return { status: "CHECKPOINT_CONFLICT" };
    const actionId = `${runId}:${checkpointSha}:${logicalStepId}`;
    const existing = this.steps.get(actionId);
    if (existing) {
      if (existing.attemptNonce !== attemptNonce) return { status: "NONCE_CONFLICT", actionId };
      if (existing.status === "COMMITTED") return { status: "CACHED", actionId, cachedResponse: copy(existing.cachedResponse) };
      if (existing.status === "UNKNOWN") return { status: "UNKNOWN", actionId };
      return { status: "IN_FLIGHT", actionId };
    }
    const maxCalls = Number(field(value, "maxCalls", "max_calls") || 6);
    if (run.paidCalls >= maxCalls) return { status: "BUDGET_EXHAUSTED" };
    const step = { actionId, runId, attemptNonce, status: "IN_FLIGHT", ownerToken: randomUUID(), fence: 1, cachedResponse: null };
    this.steps.set(actionId, step);
    run.status = "IN_FLIGHT";
    run.paidCalls += 1;
    await this.persist();
    return { status: "RESERVED", actionId, ownerToken: step.ownerToken, fence: step.fence };
  }

  async commitStep(value = {}) {
    const actionId = String(field(value, "actionId", "action_id") || "");
    const step = this.steps.get(actionId);
    if (!step) return { status: "RUN_MISSING" };
    const run = this.runs.get(step.runId);
    if (!run) return { status: "RUN_MISSING" };
    step.status = "COMMITTED";
    step.cachedResponse = copy(field(value, "response") || null);
    run.status = String(field(value, "runStatus", "run_status", "status") || "PARTIAL");
    run.compactRun = copy(field(value, "compactRun", "compact_run") || run.compactRun);
    run.checkpointPreimage = copy(field(value, "checkpointPreimage", "checkpoint_preimage") || run.checkpointPreimage);
    run.checkpointPreimageSha256 = String(field(value, "nextCheckpointPreimageSha256", "next_checkpoint_preimage_sha256") || run.checkpointPreimageSha256);
    run.logicalStepId = String(field(value, "nextLogicalStepId", "next_logical_step_id") || run.logicalStepId);
    run.cachedResponse = copy(field(value, "response") || null);
    await this.persist();
    return { status: "COMMITTED", actionId };
  }

  async markStepUnknown(value = {}) {
    const actionId = String(field(value, "actionId", "action_id") || "");
    const step = this.steps.get(actionId);
    if (!step) return { status: "RUN_MISSING" };
    if (step.status === "COMMITTED") return { status: "COMMITTED", cachedResponse: copy(step.cachedResponse) };
    step.status = "UNKNOWN";
    const run = this.runs.get(step.runId);
    if (run) run.status = "UNKNOWN";
    await this.persist();
    return { status: "UNKNOWN" };
  }

  async readAsset(value = {}) {
    const appScopeId = String(field(value, "appScopeId", "app_scope_id") || "");
    const runId = String(field(value, "runId", "run_id") || "");
    const digest = String(field(value, "sha256") || "");
    const run = this.runs.get(runId);
    if (!run) return { status: "RUN_MISSING" };
    if (run.appScopeId !== appScopeId) return { status: "FORBIDDEN" };
    const asset = this.assets.get(`${runId}:${digest}`);
    if (!asset?.member) return { status: "NOT_MEMBER" };
    if (sha256(asset.bytes) !== digest || asset.bytes.length !== asset.sizeBytes) return { status: "CORRUPT" };
    return { status: "FOUND", bytes: Buffer.from(asset.bytes), manifest: copy(asset.manifest) };
  }
}

export async function createLocalImageLedger(options = {}) {
  return new LocalImageLedger(options).load();
}
