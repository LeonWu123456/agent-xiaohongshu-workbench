#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { pathToFileURL } from "node:url";

export const ATTESTATION_SCHEMA = "xiaoshimei.image-ledger-attestation.v1";
export const ATTESTATION_ENVELOPE_SCHEMA = "xiaoshimei.image-ledger-attestation-envelope.v1";
export const CAPACITY_SCHEMA = "xiaoshimei.image-ledger-capacity.v2";
export const AUDIT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const RENEW_MAX_MS = 6 * 24 * 60 * 60 * 1000;
export const HARD_EXPIRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;
// Keep each REST command comfortably below common proxy/body thresholds. The
// capacity proof still measures the full worst-case run; only its transport is
// split into bounded chunks so the external renewal runner matches local use.
export const CALIBRATION_CHUNK_BYTES = 1_000_000;
export const D43_RECOVERY_EVIDENCE_SHA256 = "2b0ba3321bbf1f4ac4c86f8c4f04b28b010608c2c290afb26eefbf724f8f27b1";
export const D43_RECOVERY_EXPECTED_RESERVATION_COUNT = 2;

const INSTALL_ATTESTATION_LUA = `
local prior_generation = redis.call('HGET', KEYS[1], 'capacity_generation') or ''
if prior_generation ~= '' and prior_generation ~= ARGV[2] then
  local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved_bytes') or '0')
  local live = tonumber(redis.call('HGET', KEYS[1], 'live_reservations') or '0')
  local inventory = tonumber(redis.call('HGET', KEYS[1], 'unfinalized_inventory') or '0')
  if reserved ~= 0 or live ~= 0 or inventory ~= 0 then return {'CAPACITY_ROTATION_BLOCKED'} end
end
local reserved = prior_generation == ARGV[2] and (redis.call('HGET', KEYS[1], 'reserved_bytes') or '0') or '0'
local live = prior_generation == ARGV[2] and (redis.call('HGET', KEYS[1], 'live_reservations') or '0') or '0'
local inventory = prior_generation == ARGV[2] and (redis.call('HGET', KEYS[1], 'unfinalized_inventory') or '0') or '0'
redis.call('HSET', KEYS[1],
  'schema', ARGV[1],
  'capacity_generation', ARGV[2],
  'attestation_generation', ARGV[3],
  'capacity_limit_bytes', ARGV[4],
  'headroom_bytes', ARGV[5],
  'worst_case_run_bytes', ARGV[6],
  'reserved_bytes', reserved,
  'live_reservations', live,
  'unfinalized_inventory', inventory)
redis.call('SET', KEYS[2], ARGV[7])
if #KEYS == 3 then redis.call('SET', KEYS[3], ARGV[7]) end
return {'INSTALLED', reserved, live, inventory}
`;

const RECOVER_ZERO_PROVIDER_FALSE_UNKNOWN_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'RUN_MISSING'} end
if redis.call('EXISTS', KEYS[2]) == 0 then return {'INVENTORY_MISSING'} end
if redis.call('HGET', KEYS[1], 'app_scope') ~= ARGV[1]
  or redis.call('HGET', KEYS[1], 'checkpoint_sha') ~= ARGV[2]
  or redis.call('HGET', KEYS[1], 'logical_step_id') ~= ARGV[3]
  or redis.call('HGET', KEYS[1], 'run_state_sha') ~= ARGV[6] then return {'META_PREIMAGE_MISMATCH'} end
local count = tonumber(redis.call('HGET', KEYS[1], 'reservation_count') or '-1')
if redis.call('HGET', KEYS[1], 'status') == 'PARTIAL'
  and redis.call('EXISTS', KEYS[3]) == 0
  and count == tonumber(ARGV[5]) - 1
  and redis.call('SISMEMBER', KEYS[2], KEYS[3]) == 0 then return {'ALREADY_RECOVERED', tostring(count)} end
if redis.call('HGET', KEYS[1], 'status') ~= 'UNKNOWN'
  or count ~= tonumber(ARGV[5]) then return {'META_STATE_MISMATCH'} end
if redis.call('EXISTS', KEYS[3]) == 0
  or redis.call('SISMEMBER', KEYS[2], KEYS[1]) ~= 1
  or redis.call('SISMEMBER', KEYS[2], KEYS[2]) ~= 1
  or redis.call('SISMEMBER', KEYS[2], KEYS[3]) ~= 1 then return {'INVENTORY_PREIMAGE_MISMATCH'} end
if redis.call('HGET', KEYS[3], 'status') ~= 'UNKNOWN'
  or redis.call('HGET', KEYS[3], 'checkpoint_sha') ~= ARGV[2]
  or redis.call('HGET', KEYS[3], 'logical_step_id') ~= ARGV[3]
  or redis.call('HGET', KEYS[3], 'attempt_nonce') ~= ARGV[4]
  or tonumber(redis.call('HGET', KEYS[3], 'fence') or '-1') ~= tonumber(ARGV[5])
  or redis.call('HEXISTS', KEYS[3], 'result_sha') == 1
  or redis.call('HEXISTS', KEYS[3], 'result_json') == 1 then return {'ACTION_PREIMAGE_MISMATCH'} end
local prior_inventory_count = tonumber(redis.call('HGET', KEYS[1], 'inventory_count') or '-1')
if prior_inventory_count < 3 then return {'INVENTORY_COUNT_INVALID'} end
local prior_step = redis.call('HGETALL', KEYS[3])
local prior_step_ttl = redis.call('PTTL', KEYS[3])
local function rollback()
  redis.call('HSET', KEYS[1], 'status', 'UNKNOWN', 'reservation_count', tostring(count), 'inventory_count', tostring(prior_inventory_count))
  if redis.call('EXISTS', KEYS[3]) == 1 then redis.call('DEL', KEYS[3]) end
  if #prior_step > 0 then redis.call('HSET', KEYS[3], unpack(prior_step)) end
  redis.call('SADD', KEYS[2], KEYS[3])
  if prior_step_ttl > 0 then redis.call('PEXPIRE', KEYS[3], prior_step_ttl) end
end
redis.call('HSET', KEYS[1], 'status', 'PARTIAL', 'reservation_count', tostring(count - 1))
local removed = redis.call('SREM', KEYS[2], KEYS[3])
local deleted = redis.call('DEL', KEYS[3])
if removed ~= 1 or deleted ~= 1 then rollback() return {'ROLLED_BACK_MUTATION_INCOMPLETE'} end
redis.call('HSET', KEYS[1], 'inventory_count', tostring(prior_inventory_count - 1))
if redis.call('HGET', KEYS[1], 'status') ~= 'PARTIAL'
  or tonumber(redis.call('HGET', KEYS[1], 'reservation_count') or '-1') ~= count - 1
  or tonumber(redis.call('HGET', KEYS[1], 'inventory_count') or '-1') ~= prior_inventory_count - 1
  or redis.call('EXISTS', KEYS[3]) ~= 0
  or redis.call('SISMEMBER', KEYS[2], KEYS[3]) ~= 0 then rollback() return {'ROLLED_BACK_POST_READBACK_FAILED'} end
return {'RECOVERED', tostring(count - 1), tostring(prior_inventory_count - 1)}
`;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(env, name) {
  const value = String(env?.[name] || "").trim();
  if (!value) throw new Error(`ATTESTATION_ENV_REQUIRED:${name}`);
  return value;
}

function integerEnv(env, name) {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`ATTESTATION_ENV_INVALID:${name}`);
  return value;
}

function enabledEnv(env, name) {
  const value = String(env?.[name] || "").trim().toLowerCase();
  if (!value || ["0", "false", "off", "no"].includes(value)) return false;
  if (["1", "true", "on", "yes"].includes(value)) return true;
  throw new Error(`ATTESTATION_ENV_INVALID:${name}`);
}

function booleanFalse(value, code) {
  if (value === false || value === 0 || value === "0" || value === "false" || value === "off" || value === "noeviction") return false;
  throw new Error(code);
}

function booleanTrue(value, code) {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "on") return true;
  throw new Error(code);
}

function numberFrom(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(code);
  return number;
}

const D37_PRODUCT_ROOT = "xiaoshimei:image-d37:{xiaoshimei-studio-v2}";

function appRoot(appScope) {
  if (!/^xiaoshimei-studio:[0-9a-f]{32}$/.test(appScope) && appScope !== "xiaoshimei-test-scope") throw new Error("ATTESTATION_APP_SCOPE_INVALID");
  return `${D37_PRODUCT_ROOT}:scope:${sha256(Buffer.from(appScope)).slice(0, 32)}`;
}

function readinessKey(appScope, candidateCommit) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error("ATTESTATION_CANDIDATE_INVALID");
  return `${appRoot(appScope)}:candidate:${candidateCommit}:readiness`;
}

function productCapacityKey() {
  return `${D37_PRODUCT_ROOT}:capacity`;
}

function publicKeyDerBase64(privateKey) {
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
}

async function fetchJson(url, options, fetchImpl) {
  let response;
  try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error(`ATTESTATION_FETCH_FAILED:${new URL(url).pathname}`); }
  const body = await response.json().catch(() => null);
  if (!response.ok || body == null) throw new Error(`ATTESTATION_HTTP_${response.status}:${new URL(url).pathname}`);
  return body;
}

function developerHeaders(env) {
  const email = required(env, "UPSTASH_DEVELOPER_EMAIL");
  const apiKey = required(env, "UPSTASH_DEVELOPER_API_KEY");
  return { authorization: `Basic ${Buffer.from(`${email}:${apiKey}`, "utf8").toString("base64")}`, accept: "application/json" };
}

function listBody(value) {
  if (Array.isArray(value)) return value;
  for (const field of ["data", "result", "results", "items", "logs"]) if (Array.isArray(value?.[field])) return value[field];
  throw new Error("ATTESTATION_AUDIT_LOGS_INVALID");
}

function auditTimestampMs(value) {
  const raw = value?.timestamp ?? value?.created_at ?? value?.createdAt ?? value?.time;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? Math.floor(numeric * 1000) : Math.floor(numeric);
  const parsed = Date.parse(String(raw || ""));
  if (!Number.isFinite(parsed)) throw new Error("ATTESTATION_AUDIT_TIMESTAMP_INVALID");
  return parsed;
}

function auditId(value) {
  const id = String(value?.id ?? value?.log_id ?? value?.uuid ?? "").trim();
  if (!id) throw new Error("ATTESTATION_AUDIT_ID_INVALID");
  return id;
}

export function canonicalRelevantAuditSet(logs, databaseId) {
  const relevant = listBody(logs)
    .filter((entry) => canonicalJson(entry).includes(databaseId))
    .map((entry) => ({
      log_id: auditId(entry),
      timestamp_ms: auditTimestampMs(entry),
      action: String(entry.action ?? entry.event ?? entry.operation ?? "UNKNOWN"),
      resource: String(entry.resource ?? entry.resource_id ?? entry.target ?? databaseId),
    }))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms || a.log_id.localeCompare(b.log_id));
  if (!relevant.length) throw new Error("ATTESTATION_AUDIT_CONTINUITY_UNKNOWN");
  return relevant;
}

function verifyPriorEnvelope(value, publicKey) {
  if (!value) return null;
  if (value.schema !== ATTESTATION_ENVELOPE_SCHEMA || !value.payload || typeof value.signature !== "string") throw new Error("ATTESTATION_PRIOR_INVALID");
  const signature = Buffer.from(value.signature, "base64");
  if (signature.length !== 64 || !verify(null, Buffer.from(canonicalJson(value.payload)), publicKey, signature)) throw new Error("ATTESTATION_PRIOR_SIGNATURE_INVALID");
  return value.payload;
}

function assertPriorBinding(payload, { databaseId, redisUrl, appScope, projectId, environment, candidateCommit }) {
  if (payload?.schema !== ATTESTATION_SCHEMA) throw new Error("ATTESTATION_PRIOR_SCHEMA_INVALID");
  const expected = {
    database_id_sha256: sha256(Buffer.from(databaseId)),
    rest_origin: new URL(redisUrl).origin,
    app_scope: appScope,
    vercel_project_id: projectId,
    vercel_environment: environment,
    candidate_commit: candidateCommit,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (payload[field] !== value) throw new Error(`ATTESTATION_PRIOR_BINDING_MISMATCH:${field}`);
  }
  const signedAtMs = Number(payload.signed_at_ms);
  const renewAtMs = Number(payload.renew_at_ms);
  const hardExpiryMs = Number(payload.hard_expiry_ms);
  if (![signedAtMs, renewAtMs, hardExpiryMs].every((value) => Number.isSafeInteger(value) && value > 0)
    || renewAtMs <= signedAtMs
    || hardExpiryMs <= renewAtMs
    || renewAtMs - signedAtMs > RENEW_MAX_MS
    || hardExpiryMs - signedAtMs > HARD_EXPIRY_MAX_MS) {
    throw new Error("ATTESTATION_PRIOR_WINDOW_INVALID");
  }
}

async function redisCommand(endpoint, token, args, fetchImpl) {
  return (await fetchJson(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args.map((value) => Buffer.isBuffer(value) ? value.toString("base64") : String(value))),
  }, fetchImpl)).result;
}

async function redisTimeMs(redis) {
  const value = await redis.command(["TIME"]);
  if (!Array.isArray(value) || value.length !== 2) throw new Error("ATTESTATION_REDIS_TIME_INVALID");
  const result = Number(value[0]) * 1000 + Math.floor(Number(value[1]) / 1000);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("ATTESTATION_REDIS_TIME_INVALID");
  return result;
}

function hashObject(value) {
  if (!Array.isArray(value) || value.length % 2 !== 0) throw new Error("ATTESTATION_REDIS_HASH_INVALID");
  const result = {};
  for (let index = 0; index < value.length; index += 2) result[String(value[index])] = value[index + 1];
  return result;
}

function exactHex(value, name, length) {
  const text = String(value || "").trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(text)) throw new Error(`ZERO_PROVIDER_RECOVERY_INPUT_INVALID:${name}`);
  return text;
}

function coveredNarrativeRun(run) {
  if (!run || run.production_mode !== "narrative" || run.status === "COMPLETE") return false;
  const pageCount = Number(run.final_page_count);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) return false;
  const unitPages = new Map((run.illustration_units || []).map((unit) => [unit.unit_id, Number(unit.page_index)]));
  const coveredPages = new Set((run.assets || []).map((asset) => unitPages.get(asset.unit_id)).filter(Number.isSafeInteger));
  return Array.from({ length: pageCount }, (_value, pageIndex) => coveredPages.has(pageIndex)).every(Boolean);
}

export async function recoverZeroProviderFalseUnknown({ env = process.env, fetchImpl = globalThis.fetch, redisOverride = null } = {}) {
  const redisUrl = required(env, "UPSTASH_REDIS_REST_URL").replace(/\/$/, "");
  const redisToken = required(env, "UPSTASH_REDIS_REST_TOKEN");
  const appScope = required(env, "XIAOSHIMEI_APP_SCOPE");
  const runId = required(env, "XIAOSHIMEI_ZERO_PROVIDER_RECOVERY_RUN_ID");
  if (!/^images-[0-9TZ-]+-[0-9a-f]{8}$/.test(runId)) throw new Error("ZERO_PROVIDER_RECOVERY_INPUT_INVALID:run_id");
  const checkpointSha256 = exactHex(required(env, "XIAOSHIMEI_ZERO_PROVIDER_RECOVERY_CHECKPOINT_SHA256"), "checkpoint_sha256", 64);
  const logicalStepId = required(env, "XIAOSHIMEI_ZERO_PROVIDER_RECOVERY_LOGICAL_STEP_ID");
  if (!/^render-job-[0-9]{2}$/.test(logicalStepId)) throw new Error("ZERO_PROVIDER_RECOVERY_INPUT_INVALID:logical_step_id");
  const attemptNonce = exactHex(required(env, "XIAOSHIMEI_ZERO_PROVIDER_RECOVERY_ATTEMPT_NONCE"), "attempt_nonce", 64);
  const evidenceSha256 = exactHex(required(env, "XIAOSHIMEI_ZERO_PROVIDER_RECOVERY_EVIDENCE_SHA256"), "evidence_sha256", 64);
  if (evidenceSha256 !== D43_RECOVERY_EVIDENCE_SHA256) throw new Error("ZERO_PROVIDER_RECOVERY_EVIDENCE_MISMATCH");
  const root = `${appRoot(appScope)}:run:${runId}`;
  const metaKey = `${root}:meta`;
  const inventoryKey = `${root}:inventory`;
  const actionId = sha256(Buffer.from(`xiaoshimei-image-step-v1\0${runId}\0${checkpointSha256}\0${logicalStepId}`, "utf8"));
  const stepKey = `${root}:step:${actionId}`;
  const redis = redisOverride || { command: (args) => redisCommand(redisUrl, redisToken, args, fetchImpl) };
  const meta = hashObject(await redis.command(["HGETALL", metaKey]));
  if (!meta.run_json || meta.run_state_sha !== sha256(Buffer.from(meta.run_json))) throw new Error("ZERO_PROVIDER_RECOVERY_RUN_HASH_MISMATCH");
  let compactRun;
  try { compactRun = JSON.parse(meta.run_json); } catch { throw new Error("ZERO_PROVIDER_RECOVERY_RUN_JSON_INVALID"); }
  if (!coveredNarrativeRun(compactRun)) throw new Error("ZERO_PROVIDER_RECOVERY_NARRATIVE_COVERAGE_MISSING");
  const reply = await redis.command(["EVAL", RECOVER_ZERO_PROVIDER_FALSE_UNKNOWN_LUA, "3", metaKey, inventoryKey, stepKey,
    appScope,
    checkpointSha256,
    logicalStepId,
    attemptNonce,
    D43_RECOVERY_EXPECTED_RESERVATION_COUNT,
    meta.run_state_sha,
  ]);
  const status = Array.isArray(reply) ? String(reply[0] || "") : "";
  if (!new Set(["RECOVERED", "ALREADY_RECOVERED"]).has(status)) throw new Error(`ZERO_PROVIDER_RECOVERY_DENIED:${status || "UNKNOWN"}`);
  const [postMetaRaw, postStepExists, postStepMember] = await Promise.all([
    redis.command(["HGETALL", metaKey]),
    redis.command(["EXISTS", stepKey]),
    redis.command(["SISMEMBER", inventoryKey, stepKey]),
  ]);
  const postMeta = hashObject(postMetaRaw);
  if (postMeta.status !== "PARTIAL"
    || Number(postMeta.reservation_count) !== D43_RECOVERY_EXPECTED_RESERVATION_COUNT - 1
    || Number(postStepExists) !== 0
    || Number(postStepMember) !== 0
    || postMeta.run_state_sha !== meta.run_state_sha) throw new Error("ZERO_PROVIDER_RECOVERY_POST_READBACK_FAILED");
  return {
    status,
    run_id: runId,
    checkpoint_sha256: checkpointSha256,
    logical_step_id: logicalStepId,
    evidence_sha256: evidenceSha256,
    reservation_count: Number(postMeta.reservation_count),
    inventory_count: Number(postMeta.inventory_count),
    provider_calls: 0,
  };
}

function controlConfig(database, stats, databaseId) {
  const state = String(database.state ?? database.status ?? "").toLowerCase();
  if (state !== "active") throw new Error("ATTESTATION_DATABASE_NOT_ACTIVE");
  const modifyingValue = database.modifying_state ?? database.modifying ?? database.is_modifying ?? false;
  const modifying = modifyingValue === "" ? false : booleanFalse(modifyingValue, "ATTESTATION_DATABASE_MODIFYING");
  const tls = booleanTrue(database.tls ?? database.tls_enabled ?? database.ssl, "ATTESTATION_TLS_UNKNOWN");
  const eviction = booleanFalse(database.eviction ?? database.eviction_enabled ?? database.maxmemory_policy, "ATTESTATION_EVICTION_UNKNOWN");
  const dbEviction = booleanFalse(database.db_eviction ?? database.database_eviction ?? database.eviction, "ATTESTATION_DB_EVICTION_UNKNOWN");
  const autoUpgrade = booleanFalse(database.auto_upgrade ?? database.autoUpgrade ?? false, "ATTESTATION_AUTO_UPGRADE_UNKNOWN");
  const storageThresholdBytes = numberFrom(
    stats.storage_threshold_bytes ?? stats.max_storage_bytes ?? stats.max_data_size ?? database.storage_threshold_bytes ?? database.db_disk_threshold ?? database.max_data_size,
    "ATTESTATION_STORAGE_THRESHOLD_UNKNOWN",
  );
  const currentStorageBytes = numberFrom(
    stats.current_storage_bytes ?? stats.current_storage ?? stats.total_data_size ?? stats.storage_bytes ?? database.current_storage_bytes ?? 0,
    "ATTESTATION_CURRENT_STORAGE_UNKNOWN",
  );
  if (storageThresholdBytes <= 0 || currentStorageBytes > storageThresholdBytes) throw new Error("ATTESTATION_STORAGE_INVALID");
  return {
    database_id_sha256: sha256(Buffer.from(databaseId)),
    database_state: state,
    database_modifying: false,
    tls,
    eviction,
    db_eviction: dbEviction,
    auto_upgrade: autoUpgrade,
    storage_threshold_bytes: storageThresholdBytes,
    current_storage_bytes: currentStorageBytes,
  };
}

async function calibrateWorstCase(redis, root, worstCaseRunBytes) {
  const fixtureRoot = `${root}:calibration:${sha256(randomBytes(32)).slice(0, 32)}`;
  const fixtureKeys = [];
  const calibrationHash = createHash("sha256");
  let physicalBytes = 0;
  try {
    for (let offset = 0, index = 0; offset < worstCaseRunBytes; offset += CALIBRATION_CHUNK_BYTES, index += 1) {
      const logicalBytes = Math.min(CALIBRATION_CHUNK_BYTES, worstCaseRunBytes - offset);
      const fixtureKey = `${fixtureRoot}:${index}`;
      const bytes = randomBytes(logicalBytes);
      fixtureKeys.push(fixtureKey);
      calibrationHash.update(bytes);
      if (await redis.command(["SET", fixtureKey, bytes.toString("base64"), "PX", "600000"]) !== "OK") throw new Error("ATTESTATION_CALIBRATION_WRITE_FAILED");
      const readback = await redis.command(["GET", fixtureKey]);
      if (typeof readback !== "string" || !Buffer.from(readback, "base64").equals(bytes)) throw new Error("ATTESTATION_CALIBRATION_READBACK_FAILED");
      const chunkPhysicalBytes = numberFrom(await redis.command(["MEMORY", "USAGE", fixtureKey]), "ATTESTATION_CALIBRATION_USAGE_UNKNOWN");
      if (chunkPhysicalBytes <= 0) throw new Error("ATTESTATION_CALIBRATION_USAGE_UNKNOWN");
      physicalBytes += chunkPhysicalBytes;
    }
    return { calibration_sha256: calibrationHash.digest("hex"), calibration_bytes: physicalBytes };
  } finally {
    for (const fixtureKey of fixtureKeys) {
      await redis.command(["DEL", fixtureKey]).catch(() => null);
      const exists = await redis.command(["EXISTS", fixtureKey]).catch(() => 1);
      if (Number(exists) !== 0) throw new Error("ATTESTATION_CALIBRATION_DELETE_UNKNOWN");
    }
  }
}

export async function buildAndInstallAttestation({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const databaseId = required(env, "UPSTASH_DATABASE_ID");
  const redisUrl = required(env, "UPSTASH_REDIS_REST_URL").replace(/\/$/, "");
  const redisToken = required(env, "UPSTASH_REDIS_REST_TOKEN");
  const appScope = required(env, "XIAOSHIMEI_APP_SCOPE");
  const projectId = required(env, "XIAOSHIMEI_VERCEL_PROJECT_ID");
  const environment = required(env, "VERCEL_ENV");
  const candidateCommit = required(env, "XIAOSHIMEI_CANDIDATE_COMMIT").toLowerCase();
  const worstCaseRunBytes = integerEnv(env, "XIAOSHIMEI_WORST_CASE_RUN_BYTES");
  const onlyIfDue = enabledEnv(env, "XIAOSHIMEI_ATTESTATION_ONLY_IF_DUE");
  const allowCandidateRotation = enabledEnv(env, "XIAOSHIMEI_ATTESTATION_ALLOW_CANDIDATE_ROTATION");
  const legacyRuntimeCompat = enabledEnv(env, "XIAOSHIMEI_ATTESTATION_LEGACY_RUNTIME_COMPAT");
  if (onlyIfDue && allowCandidateRotation) throw new Error("ATTESTATION_CANDIDATE_ROTATION_MODE_INVALID");
  if (!/^[0-9a-f]{40}$/.test(candidateCommit)) throw new Error("ATTESTATION_CANDIDATE_INVALID");
  if (legacyRuntimeCompat) {
    const productionCommit = String(env?.XIAOSHIMEI_PRODUCTION_COMMIT || "").trim().toLowerCase();
    const rollbackCommit = String(env?.XIAOSHIMEI_ROLLBACK_COMMIT || "").trim().toLowerCase();
    if (String(env?.GITHUB_EVENT_NAME || "") !== "schedule"
      || environment !== "production"
      || !/^[0-9a-f]{40}$/.test(productionCommit)
      || !/^[0-9a-f]{40}$/.test(rollbackCommit)
      || candidateCommit !== rollbackCommit
      || candidateCommit === productionCommit) {
      throw new Error("ATTESTATION_LEGACY_RUNTIME_COMPAT_SCOPE_INVALID");
    }
  }
  const privateKey = createPrivateKey(required(env, "XIAOSHIMEI_LEDGER_ATTESTATION_PRIVATE_KEY"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("ATTESTATION_PRIVATE_KEY_INVALID");
  const publicKey = createPublicKey(privateKey);
  const redis = { command: (args) => redisCommand(redisUrl, redisToken, args, fetchImpl) };
  const signedAtMs = await redisTimeMs(redis);
  const root = appRoot(appScope);
  const candidateReadinessKey = readinessKey(appScope, candidateCommit);
  const legacyReadinessKey = legacyRuntimeCompat ? `${root}:readiness` : "";
  const capacityKey = productCapacityKey();
  const priorRaw = await redis.command(["GET", candidateReadinessKey]);
  let priorEnvelope = null;
  if (typeof priorRaw === "string") {
    try { priorEnvelope = JSON.parse(priorRaw); } catch { throw new Error("ATTESTATION_PRIOR_INVALID"); }
  } else if (priorRaw != null) {
    throw new Error("ATTESTATION_PRIOR_INVALID");
  }
  const prior = verifyPriorEnvelope(priorEnvelope, publicKey);
  if (prior) assertPriorBinding(
    prior,
    { databaseId, redisUrl, appScope, projectId, environment, candidateCommit },
  );

  if (onlyIfDue && prior) {
    const renewLeadMs = integerEnv(env, "XIAOSHIMEI_ATTESTATION_RENEW_LEAD_MS");
    if (renewLeadMs > RENEW_MAX_MS) throw new Error("ATTESTATION_RENEW_LEAD_INVALID");
    if (signedAtMs >= prior.hard_expiry_ms) throw new Error("ATTESTATION_PRIOR_EXPIRED");
    const dueAtMs = prior.renew_at_ms - renewLeadMs;
    const sharedCapacity = hashObject(await redis.command(["HGETALL", capacityKey]));
    const capacityStillMatches = sharedCapacity.schema === CAPACITY_SCHEMA
      && sharedCapacity.capacity_generation === prior.capacity_generation;
    if (signedAtMs < dueAtMs && capacityStillMatches) {
      if (legacyReadinessKey) {
        if (await redis.command(["GET", legacyReadinessKey]) !== priorRaw) {
          if (await redis.command(["SET", legacyReadinessKey, priorRaw]) !== "OK"
            || await redis.command(["GET", legacyReadinessKey]) !== priorRaw) {
            throw new Error("ATTESTATION_LEGACY_SENTINEL_READBACK_FAILED");
          }
        }
      }
      return {
        status: "ATTESTATION_NOT_DUE",
        public_key_spki_base64: publicKeyDerBase64(privateKey),
        readiness_key: candidateReadinessKey,
        legacy_readiness_key: legacyReadinessKey || null,
        capacity_key: capacityKey,
        attestation_generation: prior.attestation_generation,
        capacity_generation: prior.capacity_generation,
        now_ms: signedAtMs,
        due_at_ms: dueAtMs,
        renew_at_ms: prior.renew_at_ms,
        hard_expiry_ms: prior.hard_expiry_ms,
      };
    }
  }

  const developerBase = String(env.UPSTASH_DEVELOPER_API_BASE || "https://api.upstash.com/v2").replace(/\/$/, "");
  const auditBase = String(env.UPSTASH_AUDIT_API_BASE || "https://api.upstash.com").replace(/\/$/, "");
  const headers = developerHeaders(env);
  const [database, stats, auditLogs] = await Promise.all([
    fetchJson(`${developerBase}/redis/database/${encodeURIComponent(databaseId)}?credentials=hide`, { headers }, fetchImpl),
    fetchJson(`${developerBase}/redis/stats/${encodeURIComponent(databaseId)}`, { headers }, fetchImpl),
    fetchJson(`${auditBase}/auditlogs`, { headers }, fetchImpl),
  ]);
  const control = controlConfig(database, stats, databaseId);
  const allAudits = canonicalRelevantAuditSet(auditLogs, databaseId);
  const audits = allAudits.filter((entry) => entry.timestamp_ms >= signedAtMs - HARD_EXPIRY_MAX_MS && entry.timestamp_ms <= signedAtMs);
  if (!audits.length) throw new Error("ATTESTATION_AUDIT_CONTINUITY_UNKNOWN");
  if (prior) {
    const priorFound = allAudits.some((entry) => entry.log_id === prior.audit_high_water.log_id && entry.timestamp_ms === prior.audit_high_water.timestamp_ms);
    if (!priorFound || signedAtMs - prior.audit_fetch_at_ms > HARD_EXPIRY_MAX_MS) throw new Error("ATTESTATION_AUDIT_CONTINUITY_UNKNOWN");
  }
  const auditHighWater = audits.at(-1);
  if (auditHighWater.timestamp_ms > signedAtMs) throw new Error("ATTESTATION_AUDIT_CONTINUITY_UNKNOWN");
  if (worstCaseRunBytes > control.storage_threshold_bytes) throw new Error("ATTESTATION_CAPACITY_INSUFFICIENT");
  const calibration = await calibrateWorstCase(redis, root, worstCaseRunBytes);
  const headroomBytes = Math.max(Math.ceil(control.storage_threshold_bytes * 0.2), calibration.calibration_bytes * 2);
  if (control.current_storage_bytes + calibration.calibration_bytes + headroomBytes > control.storage_threshold_bytes) {
    throw new Error("ATTESTATION_CAPACITY_INSUFFICIENT");
  }
  const capacityIdentity = {
    database_id_sha256: control.database_id_sha256,
    rest_origin: new URL(redisUrl).origin,
    key_schema: "xiaoshimei.image-d37.product-capacity-hash-tag.v2",
    calibration_schema: "xiaoshimei.image-ledger-random-bytes-base64.v1",
    logical_worst_case_run_bytes: worstCaseRunBytes,
    calibration_bytes: calibration.calibration_bytes,
    worst_case_run_bytes: calibration.calibration_bytes,
    headroom_bytes: headroomBytes,
    capacity_limit_bytes: control.storage_threshold_bytes,
  };
  const capacityGeneration = sha256(Buffer.from(canonicalJson(capacityIdentity)));
  const priorCapacity = hashObject(await redis.command(["HGETALL", capacityKey]));
  if (prior?.capacity_generation && prior.capacity_generation !== capacityGeneration) {
    if (Number(priorCapacity.live_reservations || 0) !== 0 || Number(priorCapacity.unfinalized_inventory || 0) !== 0 || Number(priorCapacity.reserved_bytes || 0) !== 0) {
      throw new Error("ATTESTATION_CAPACITY_ROTATION_BLOCKED");
    }
  }
  const controlConfigHash = sha256(Buffer.from(canonicalJson(control)));
  const relevantAuditSetHash = sha256(Buffer.from(canonicalJson(audits)));
  const attestationGeneration = sha256(Buffer.from(canonicalJson({
    prior: prior?.attestation_generation || null,
    control_config_hash: controlConfigHash,
    relevant_audit_set_hash: relevantAuditSetHash,
    signed_at_ms: signedAtMs,
  })));
  const payload = {
    schema: ATTESTATION_SCHEMA,
    database_id_sha256: control.database_id_sha256,
    rest_origin: new URL(redisUrl).origin,
    app_scope: appScope,
    vercel_project_id: projectId,
    vercel_environment: environment,
    candidate_commit: candidateCommit,
    database_state: control.database_state,
    database_modifying: control.database_modifying,
    tls: control.tls,
    eviction: control.eviction,
    db_eviction: control.db_eviction,
    auto_upgrade: control.auto_upgrade,
    storage_threshold_bytes: control.storage_threshold_bytes,
    current_storage_bytes: control.current_storage_bytes,
    control_config_hash: controlConfigHash,
    relevant_audit_set_hash: relevantAuditSetHash,
    audit_high_water: { timestamp_ms: auditHighWater.timestamp_ms, log_id: auditHighWater.log_id },
    audit_fetch_at_ms: signedAtMs,
    audit_retention_seconds: AUDIT_RETENTION_SECONDS,
    calibration_sha256: calibration.calibration_sha256,
    calibration_bytes: calibration.calibration_bytes,
    worst_case_run_bytes: calibration.calibration_bytes,
    headroom_bytes: headroomBytes,
    capacity_limit_bytes: control.storage_threshold_bytes,
    attestation_generation: attestationGeneration,
    capacity_generation: capacityGeneration,
    signed_at_ms: signedAtMs,
    renew_at_ms: signedAtMs + RENEW_MAX_MS,
    hard_expiry_ms: signedAtMs + HARD_EXPIRY_MAX_MS,
  };
  const envelope = {
    schema: ATTESTATION_ENVELOPE_SCHEMA,
    payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64"),
  };
  const serialized = canonicalJson(envelope);
  const readinessKeys = legacyReadinessKey ? [capacityKey, candidateReadinessKey, legacyReadinessKey] : [capacityKey, candidateReadinessKey];
  const installed = await redis.command(["EVAL", INSTALL_ATTESTATION_LUA, String(readinessKeys.length), ...readinessKeys,
    CAPACITY_SCHEMA,
    capacityGeneration,
    attestationGeneration,
    payload.capacity_limit_bytes,
    payload.headroom_bytes,
    payload.worst_case_run_bytes,
    serialized,
  ]);
  if (!Array.isArray(installed) || installed[0] !== "INSTALLED") {
    if (Array.isArray(installed) && installed[0] === "CAPACITY_ROTATION_BLOCKED") throw new Error("ATTESTATION_CAPACITY_ROTATION_BLOCKED");
    throw new Error("ATTESTATION_SENTINEL_WRITE_FAILED");
  }
  if (await redis.command(["GET", candidateReadinessKey]) !== serialized) throw new Error("ATTESTATION_SENTINEL_READBACK_FAILED");
  if (legacyReadinessKey && await redis.command(["GET", legacyReadinessKey]) !== serialized) throw new Error("ATTESTATION_LEGACY_SENTINEL_READBACK_FAILED");
  const installedCapacity = hashObject(await redis.command(["HGETALL", capacityKey]));
  if (installedCapacity.attestation_generation !== attestationGeneration || installedCapacity.capacity_generation !== capacityGeneration) {
    throw new Error("ATTESTATION_CAPACITY_READBACK_FAILED");
  }
  return {
    envelope,
    public_key_spki_base64: publicKeyDerBase64(privateKey),
    readiness_key: candidateReadinessKey,
    legacy_readiness_key: legacyReadinessKey || null,
    capacity_key: capacityKey,
    control_config_hash: controlConfigHash,
    relevant_audit_set_hash: relevantAuditSetHash,
    audit_entry_count: audits.length,
    // These counters were already read back above. Reporting them must never
    // reset reservations or imply that a valid signature admits a new run.
    capacity_snapshot: {
      ...Object.fromEntries(["capacity_limit_bytes", "headroom_bytes", "worst_case_run_bytes", "reserved_bytes", "live_reservations", "unfinalized_inventory"].map(key => [key, Number(installedCapacity[key])])),
      database_reported_storage_bytes: control.current_storage_bytes,
    },
  };
}


// Read-only operational evidence. No source text, asset bytes, credentials or
// recovery tokens are emitted. Keep signature readiness separate from capacity.
export async function inspectCapacityMetadata({env=process.env,fetchImpl=globalThis.fetch,redis=null}={}) {
 const store=redis||{command:args=>redisCommand(required(env,'UPSTASH_REDIS_REST_URL'),required(env,'UPSTASH_REDIS_REST_TOKEN'),args,fetchImpl)};
 const now=await redisTimeMs(store),keys=new Set();let cursor='0',pages=0;
 do{const reply=await store.command(['SCAN',cursor,'MATCH','xiaoshimei:image-*','COUNT','500']);if(!Array.isArray(reply)||!Array.isArray(reply[1]))throw new Error('CAPACITY_DIAGNOSTIC_SCAN_INVALID');cursor=String(reply[0]);reply[1].forEach(k=>keys.add(String(k)));if(++pages>30||keys.size>2000)throw new Error('CAPACITY_DIAGNOSTIC_BOUNDED_LIMIT');}while(cursor!=='0');
 let physicalBytes=0;const runs=[],capacity=hashObject(await store.command(['HGETALL',productCapacityKey()]));
 for(const key of keys){const bytes=Number(await store.command(['MEMORY','USAGE',key]));if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('CAPACITY_DIAGNOSTIC_USAGE_INVALID');physicalBytes+=bytes;
  if(!/:run:images-[^:]+:meta$/.test(key))continue;
  const v=await store.command(['HMGET',key,'status','recoverable_until_ms','physical_expire_at_ms','capacity_reservation_bytes','capacity_released','reservation_count','cached_response_json']);
  runs.push({key_sha256:sha256(Buffer.from(key)),status:v[0],recoverable_until_ms:Number(v[1]),physical_expire_at_ms:Number(v[2]),reservation_bytes:Number(v[3]),released:Number(v[4]),image_reservations:Number(v[5]),cached_response_sha256:typeof v[6]==='string'?sha256(Buffer.from(v[6])):null,recovery_expired:Number(v[1])>0&&Number(v[1])<now,own_scope:key.startsWith(appRoot(env.XIAOSHIMEI_APP_SCOPE||'xiaoshimei-test-scope')+':')});
 }
 return {observed_at_ms:now,physical_bytes:physicalBytes,key_count:keys.size,capacity:Object.fromEntries(['reserved_bytes','live_reservations','unfinalized_inventory','headroom_bytes','capacity_limit_bytes','worst_case_run_bytes'].map(k=>[k,Number(capacity[k])])),runs};
}

async function main() {
  if (enabledEnv(process.env, "XIAOSHIMEI_ZERO_PROVIDER_RECOVERY_MODE")) {
    process.stdout.write(`${JSON.stringify(await recoverZeroProviderFalseUnknown(), null, 2)}\n`);
    return;
  }
  const result = await buildAndInstallAttestation();
  if (result.status === "ATTESTATION_NOT_DUE") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const capacityMetadata = process.env.VERCEL_ENV === "preview" ? await inspectCapacityMetadata() : null;
  process.stdout.write(`${JSON.stringify({
    status: "ATTESTATION_INSTALLED",
    public_key_spki_base64: result.public_key_spki_base64,
    readiness_key: result.readiness_key,
    capacity_key: result.capacity_key,
    control_config_hash: result.control_config_hash,
    relevant_audit_set_hash: result.relevant_audit_set_hash,
    audit_entry_count: result.audit_entry_count,
    capacity_snapshot: result.capacity_snapshot,
    ...(capacityMetadata ? {capacity_metadata: capacityMetadata} : {}),
    attestation_generation: result.envelope.payload.attestation_generation,
    capacity_generation: result.envelope.payload.capacity_generation,
    renew_at_ms: result.envelope.payload.renew_at_ms,
    hard_expiry_ms: result.envelope.payload.hard_expiry_ms,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
