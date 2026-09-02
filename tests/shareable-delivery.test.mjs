import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ALTERNATE_ENTRY_URL,
  JOURNEY_SCHEMA,
  classifyTargetUrl,
  collectEntrypointAssetPaths,
  compareArtifacts,
  evaluateDelivery,
  isPublicAddress,
  inspectAlternateEntry,
  readRollbackReadback,
  readProviderReadiness,
  readRemoteArtifact,
  resolvePublicTarget,
  validateJourneyReceipt,
  validateProviderReadiness,
  validateRollbackReadback,
} from "../scripts/verify-shareable-delivery.mjs";

const commit = "a".repeat(40);
const url = "https://xiaoshimei-full-workbench.vercel.app/";
const deploymentUrl = "https://xiaoshimei-full-workbench-build-892350620-5733s-projects.vercel.app/";
const rollbackDeploymentUrl = "https://xiaoshimei-full-workbench-rollback-892350620-5733s-projects.vercel.app/";
const artifact = {
  html_sha256: "1".repeat(64),
  html_size_bytes: 123,
  assets: {
    "/assets/index.js": { sha256: "2".repeat(64), size_bytes: 456 },
    "/assets/index.css": { sha256: "3".repeat(64), size_bytes: 789 },
  },
};

function receipt(role = "operator") {
  return {
    schema: JOURNEY_SCHEMA,
    target_url: url,
    source_commit: commit,
    observed_at: new Date().toISOString(),
    actor: { role, identity: role === "xiaoshimei" ? "xiaoshimei" : "release-operator" },
    deployment: { production_deployment_id: "dpl_current123", rollback_deployment_id: "dpl_rollback456" },
    steps: { open: true, access: true, edit: true, save: true, reopen: true, copy: true, download: true },
    fresh_user: { new_draft: true, generate_text: true, text_draft_id: "text-draft-new", body_length: 294, tag_count: 5, image_calls: 0 },
    rollback_verification: {
      deployment_id: "dpl_rollback456",
      deployment_url: rollbackDeploymentUrl,
      source_commit: "b".repeat(40),
      ready_state: "READY",
      action: "promote_existing_deployment",
      evidence_ref: "Evidence/KNOWN_GOOD_ROLLBACK.json",
      evidence_sha256: "c".repeat(64),
      verified_at: new Date(Date.now() - 60_000).toISOString(),
      provider_readiness: { configured: true, access_required: true, credential_mode: "SERVER_MANAGED", image_ledger_configured: true, image_ledger_attested: true, image_ledger_attestation_status: "READY", image_ledger_attestation_candidate_commit: "b".repeat(40) },
    },
    same_draft: { initial_draft_id: "draft-one", saved_draft_id: "draft-one", reopened_draft_id: "draft-one", export_source_draft_id: "draft-one" },
  };
}

const passingDependencies = {
  inspectAlternateEntry: async (alternateUrl) => ({ url: alternateUrl, status: 302, state: "PROTECTED_BY_VERCEL" }),
  inspectCandidate: async () => ({ root: "/candidate", head: commit, worktree: "CLEAN" }),
  resolvePublicTarget: async () => ["76.76.21.21"],
  readLocalArtifact: async () => structuredClone(artifact),
  readRemoteArtifact: async () => structuredClone(artifact),
  readProviderReadiness: async () => ({
    status: "ACCESS_SESSION_REQUIRED",
    configured: true,
    access_required: true,
    access_configured: true,
    authenticated: false,
    authentication_mode: "STUDIO_ACCESS_SESSION",
    image_ledger_configured: true,
    image_ledger_attested: true,
    image_ledger_attestation_status: "READY",
    image_ledger_attestation_candidate_commit: commit,
    credential_mode: "SERVER_MANAGED",
    key_store: "Vercel Sensitive Environment Variable",
  }),
  readRollbackReadback: async () => ({
    deployment_id: "dpl_rollback456",
    deployment_url: rollbackDeploymentUrl,
    ready_state: "READY",
    source_commit: "b".repeat(40),
    vercel_project_id: "prj_5XpPkMtqpWfY6rYkAaD1RDE5yH9X",
    observed_at: new Date().toISOString(),
    provider_readiness: {
      configured: true,
      access_required: true,
      credential_mode: "SERVER_MANAGED",
      image_ledger_configured: true,
      image_ledger_attested: true,
      image_ledger_attestation_status: "READY",
      image_ledger_attestation_candidate_commit: "b".repeat(40),
    },
  }),
};

function deliveryInput(overrides = {}) {
  return { targetUrl: url, expectedCommit: commit, candidateRoot: "/candidate", alternateUrls: [deploymentUrl], receipt: receipt(), ...overrides };
}

test("loopback, LAN, HTTP and credentialed URLs never become shareable", () => {
  for (const value of ["http://127.0.0.1:4184/", "https://localhost/", "https://192.168.1.8/", "https://[::1]/"]) {
    assert.equal(classifyTargetUrl(value).kind, "LOCAL_ONLY", value);
  }
  assert.equal(classifyTargetUrl("http://example.com/").kind, "BLOCKED");
  assert.equal(classifyTargetUrl("https://user:pass@example.com/").kind, "BLOCKED");
  assert.equal(classifyTargetUrl("https://example.com:8443/").kind, "BLOCKED");
});

test("a different public HTTPS origin is not the stable delivery target", async () => {
  const result = await evaluateDelivery(deliveryInput({ targetUrl: "https://example.com/" }), passingDependencies);
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "STABLE_TARGET_REQUIRED"));
});

test("private, reserved and public IP ranges are separated", () => {
  for (const value of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(isPublicAddress(value), false, value);
  }
  assert.equal(isPublicAddress("76.76.21.21"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("the fixed stable host tolerates a local proxy synthetic address without generalizing the exception", async () => {
  const fakeLookup = async () => [{ address: "198.18.0.74", family: 4 }];
  assert.deepEqual(await resolvePublicTarget(url, fakeLookup), ["198.18.0.74"]);
  await assert.rejects(() => resolvePublicTarget("https://example.com/", fakeLookup), (error) => error.code === "DNS_PRIVATE_ADDRESS");
});

test("a redirect to loopback is rejected before the second fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:4184/" } });
  };
  await assert.rejects(() => readRemoteArtifact(url, fetchImpl), (error) => error.code === "TARGET_REDIRECT_NOT_PUBLIC");
  assert.equal(calls, 1);
});

test("alternate deployment URLs must be protected or redirect to the one canonical origin", async () => {
  const protectedResult = await inspectAlternateEntry(deploymentUrl, {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: `https://vercel.com/sso-api?url=${encodeURIComponent(deploymentUrl)}` } }),
  });
  assert.equal(protectedResult.state, "PROTECTED_BY_VERCEL");
  const redirectedResult = await inspectAlternateEntry(deploymentUrl, {
    fetchImpl: async () => new Response(null, { status: 308, headers: { location: url } }),
  });
  assert.equal(redirectedResult.state, "REDIRECTS_TO_CANONICAL");
  await assert.rejects(
    () => inspectAlternateEntry(deploymentUrl, { fetchImpl: async () => new Response("second truth", { status: 200 }) }),
    (error) => error.code === "ALTERNATE_PUBLIC_ENTRY_ACTIVE",
  );
  await assert.rejects(
    () => inspectAlternateEntry("https://example.com/", { fetchImpl: async () => new Response(null, { status: 403 }) }),
    (error) => error.code === "ALTERNATE_ENTRY_HOST_UNTRUSTED",
  );
  await assert.rejects(
    () => inspectAlternateEntry(deploymentUrl, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://vercel.com/sso-api?url=https%3A%2F%2Fevil.example%2F" } }) }),
    (error) => error.code === "ALTERNATE_ENTRY_REDIRECT_UNSAFE",
  );
  assert.notEqual(DEFAULT_ALTERNATE_ENTRY_URL, url);
});

test("entrypoint assets and byte identity are exact", () => {
  const html = '<link rel="stylesheet" href="/assets/index.css"><script type="module" src="/assets/index.js"></script>';
  assert.deepEqual(collectEntrypointAssetPaths(html), ["/assets/index.css", "/assets/index.js"]);
  assert.deepEqual(compareArtifacts(artifact, structuredClone(artifact)), []);
  const old = structuredClone(artifact);
  old.assets["/assets/index.js"].sha256 = "9".repeat(64);
  assert.deepEqual(compareArtifacts(artifact, old).map((row) => row.code), ["ENTRY_ASSET_MISMATCH"]);
});

test("a public URL with the wrong deployed artifact is BLOCKED", async () => {
  const old = structuredClone(artifact);
  old.html_sha256 = "9".repeat(64);
  const result = await evaluateDelivery(deliveryInput(), { ...passingDependencies, readRemoteArtifact: async () => old });
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "HTML_ARTIFACT_MISMATCH"));
});

test("missing journey evidence cannot be upgraded by a public exact artifact", async () => {
  const result = await evaluateDelivery(deliveryInput({ receipt: undefined }), passingDependencies);
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "JOURNEY_RECEIPT_REQUIRED"));
});

test("BYOK or an absent server-managed production key blocks handoff", async () => {
  const health = {
    status: "AWAITING_BYOK",
    configured: false,
    access_required: false,
    access_configured: false,
    authenticated: false,
    authentication_mode: "BROWSER_BYOK",
    image_ledger_configured: true,
    credential_mode: "BROWSER_BYOK",
    key_store: "当前标签页 sessionStorage",
  };
  assert.deepEqual(validateProviderReadiness(health).map((row) => row.code), [
    "PROVIDER_SERVER_KEY_MISSING",
    "PROVIDER_CREDENTIAL_MODE_INVALID",
    "PROVIDER_KEY_STORE_INVALID",
    "PROVIDER_ACCESS_NOT_REQUIRED",
    "PROVIDER_ACCESS_NOT_CONFIGURED",
    "PROVIDER_AUTHENTICATION_MODE_INVALID",
    "PROVIDER_PUBLIC_STATUS_INVALID",
    "PROVIDER_IMAGE_LEDGER_NOT_ATTESTED",
  ]);
  const result = await evaluateDelivery(deliveryInput(), { ...passingDependencies, readProviderReadiness: async () => health });
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "PROVIDER_SERVER_KEY_MISSING"));
});

test("provider health must be same-origin JSON without redirects", async () => {
  await assert.rejects(
    () => readProviderReadiness(url, async () => new Response(null, { status: 302, headers: { location: "https://example.com/" } })),
    (error) => error.code === "PROVIDER_HEALTH_REDIRECTED",
  );
  await assert.rejects(
    () => readProviderReadiness(url, async () => new Response("not-json", { status: 200 })),
    (error) => error.code === "PROVIDER_HEALTH_JSON_INVALID",
  );
});

test("rollback readback is collected from Vercel deployment identity and the same exact deployment health", async () => {
  const calls = [];
  const health = (await passingDependencies.readRollbackReadback()).provider_readiness;
  const syncSpawn = (_command, args) => {
    calls.push(args);
    const payload = args.includes("api")
      ? {
        id: "dpl_rollback456",
        url: new URL(rollbackDeploymentUrl).hostname,
        readyState: "READY",
        source: "cli",
        meta: { gitCommitSha: "b".repeat(40) },
        project: { id: "prj_5XpPkMtqpWfY6rYkAaD1RDE5yH9X" },
        team: { slug: "892350620-5733s-projects" },
      }
      : health;
    return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
  };
  const observed = await readRollbackReadback({
    deploymentId: "dpl_rollback456",
    deploymentUrl: rollbackDeploymentUrl,
    expectedCommit: "b".repeat(40),
  }, {
    spawnImpl: syncSpawn,
    cliPath: "/opt/vercel/index.js",
    scope: "892350620-5733s-projects",
    now: () => new Date("2026-09-03T00:00:00Z"),
  });
  assert.equal(observed.source_commit, "b".repeat(40));
  assert.equal(observed.observed_at, "2026-09-03T00:00:00.000Z");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("/v13/deployments/dpl_rollback456?withGitRepoInfo=true"));
  assert.ok(calls[1].includes(new URL("/api/provider/health", rollbackDeploymentUrl).href));
});

test("Vercel rollback probe rejects a forged receipt commit before reading deployment health", async () => {
  let calls = 0;
  const spawnImpl = () => {
    calls += 1;
    return {
      status: 0,
      stdout: JSON.stringify({
        id: "dpl_rollback456",
        url: new URL(rollbackDeploymentUrl).hostname,
        readyState: "READY",
        source: "cli",
        meta: { gitCommitSha: "b".repeat(40) },
        project: { id: "prj_5XpPkMtqpWfY6rYkAaD1RDE5yH9X" },
        team: { slug: "892350620-5733s-projects" },
      }),
      stderr: "",
    };
  };
  await assert.rejects(
    () => readRollbackReadback({
      deploymentId: "dpl_rollback456",
      deploymentUrl: rollbackDeploymentUrl,
      expectedCommit: "f".repeat(40),
    }, { spawnImpl, cliPath: "/opt/vercel/index.js" }),
    (error) => error.code === "ROLLBACK_SOURCE_COMMIT_MISMATCH",
  );
  assert.equal(calls, 1);
});

test("GitHub rollback probe accepts only GitHub commit metadata from the exact repository", async () => {
  const health = (await passingDependencies.readRollbackReadback()).provider_readiness;
  const githubDeployment = {
    id: "dpl_rollback456",
    url: new URL(rollbackDeploymentUrl).hostname,
    readyState: "READY",
    source: "git",
    meta: {
      githubCommitSha: "b".repeat(40),
      githubCommitOrg: "LeonWu123456",
      githubCommitRepo: "agent-xiaohongshu-workbench",
    },
    project: { id: "prj_5XpPkMtqpWfY6rYkAaD1RDE5yH9X" },
    team: { slug: "892350620-5733s-projects" },
  };
  let calls = 0;
  const spawnImpl = () => {
    calls += 1;
    return { status: 0, stdout: JSON.stringify(calls === 1 ? githubDeployment : health), stderr: "" };
  };
  const observed = await readRollbackReadback({
    deploymentId: "dpl_rollback456",
    deploymentUrl: rollbackDeploymentUrl,
    expectedCommit: "b".repeat(40),
  }, { spawnImpl, cliPath: "/opt/vercel/index.js" });
  assert.equal(observed.source_commit, "b".repeat(40));

  const wrongFieldOnly = structuredClone(githubDeployment);
  wrongFieldOnly.meta = { gitCommitSha: "b".repeat(40), githubCommitOrg: "LeonWu123456", githubCommitRepo: "agent-xiaohongshu-workbench" };
  await assert.rejects(
    () => readRollbackReadback({
      deploymentId: "dpl_rollback456",
      deploymentUrl: rollbackDeploymentUrl,
      expectedCommit: "b".repeat(40),
    }, { spawnImpl: () => ({ status: 0, stdout: JSON.stringify(wrongFieldOnly), stderr: "" }), cliPath: "/opt/vercel/index.js" }),
    (error) => error.code === "ROLLBACK_SOURCE_COMMIT_MISMATCH",
  );
});

test("configured-but-unattested Production and rollback both block handoff", async () => {
  const health = await passingDependencies.readProviderReadiness();
  health.image_ledger_attested = false;
  health.image_ledger_attestation_status = "IMAGE_LEDGER_ATTESTATION_MISSING";
  const production = await evaluateDelivery(deliveryInput(), { ...passingDependencies, readProviderReadiness: async () => health });
  assert.equal(production.verdict, "BLOCKED");
  assert.ok(production.errors.some((row) => row.code === "PROVIDER_IMAGE_LEDGER_NOT_ATTESTED"));

  const rollbackResult = await evaluateDelivery(deliveryInput(), {
    ...passingDependencies,
    readRollbackReadback: async () => {
      const observed = await passingDependencies.readRollbackReadback();
      observed.provider_readiness.image_ledger_attested = false;
      observed.provider_readiness.image_ledger_attestation_status = "IMAGE_LEDGER_ATTESTATION_BINDING_MISMATCH";
      return observed;
    },
  });
  assert.equal(rollbackResult.verdict, "BLOCKED");
  assert.ok(rollbackResult.errors.some((row) => row.code === "ROLLBACK_IMAGE_LEDGER_NOT_ATTESTED"));
});

test("current readiness must publicly bind the exact candidate commit", async () => {
  const wrongCurrent = await passingDependencies.readProviderReadiness();
  wrongCurrent.image_ledger_attestation_candidate_commit = "c".repeat(40);
  const currentResult = await evaluateDelivery(deliveryInput(), { ...passingDependencies, readProviderReadiness: async () => wrongCurrent });
  assert.equal(currentResult.verdict, "BLOCKED");
  assert.ok(currentResult.errors.some((row) => row.code === "PROVIDER_IMAGE_LEDGER_CANDIDATE_MISMATCH"));

});

test("two matching caller-supplied rollback objects cannot replace the Vercel probe", async () => {
  const forged = receipt();
  forged.rollback_verification.source_commit = "f".repeat(40);
  forged.rollback_verification.provider_readiness.image_ledger_attestation_candidate_commit = "f".repeat(40);
  const forgedReadback = await passingDependencies.readRollbackReadback();
  forgedReadback.source_commit = "f".repeat(40);
  forgedReadback.provider_readiness.image_ledger_attestation_candidate_commit = "f".repeat(40);
  const result = await evaluateDelivery(deliveryInput({ receipt: forged, rollbackReadback: forgedReadback }), passingDependencies);
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_SOURCE_COMMIT_MISMATCH"));
});

test("rollback readiness is absent unless an independent deployment readback is supplied", async () => {
  const withoutRollbackReadback = {
    ...passingDependencies,
    readRollbackReadback: async () => { throw Object.assign(new Error("probe unavailable"), { code: "ROLLBACK_VERCEL_PROBE_FAILED" }); },
  };
  const result = await evaluateDelivery(deliveryInput(), withoutRollbackReadback);
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_PROVIDER_READBACK_REQUIRED"));
  assert.equal(validateRollbackReadback(null, { deploymentId: "dpl_rollback456" })[0].code, "ROLLBACK_PROVIDER_READBACK_REQUIRED");
});

test("an old-draft edit/export receipt cannot replace fresh-user creation and text generation", async () => {
  const legacy = receipt();
  delete legacy.fresh_user;
  const result = await evaluateDelivery(deliveryInput({ receipt: legacy }), passingDependencies);
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "FRESH_USER_NEW_DRAFT_NOT_PASS"));
  assert.ok(result.errors.some((row) => row.code === "FRESH_USER_TEXT_GENERATION_NOT_PASS"));
  assert.ok(result.errors.some((row) => row.code === "FRESH_USER_TEXT_DRAFT_ID_MISSING"));
  assert.ok(result.errors.some((row) => row.code === "FRESH_USER_TEXT_BODY_EMPTY"));
  assert.ok(result.errors.some((row) => row.code === "FRESH_USER_TAGS_EMPTY"));
  assert.ok(result.errors.some((row) => row.code === "FRESH_USER_IMAGE_CALLS_NOT_ZERO"));
});

test("a rollback to an unconfigured or unverified deployment blocks handoff", async () => {
  const broken = receipt();
  broken.deployment.rollback_deployment_id = "dpl_previousBroken";
  broken.rollback_verification = {
    deployment_id: "dpl_previousBroken",
    deployment_url: rollbackDeploymentUrl,
    source_commit: "not-a-commit",
    ready_state: "READY",
    action: "promote_existing_deployment",
    evidence_ref: "notes.txt",
    evidence_sha256: "not-a-hash",
    verified_at: broken.observed_at,
    provider_readiness: { configured: false, access_required: false, credential_mode: "BROWSER_BYOK", image_ledger_configured: false },
  };
  const result = await evaluateDelivery(deliveryInput({ receipt: broken }), {
    ...passingDependencies,
    readRollbackReadback: async () => ({
      deployment_id: "dpl_previousBroken",
      deployment_url: rollbackDeploymentUrl,
      ready_state: "READY",
      source_commit: "not-a-commit",
      vercel_project_id: "prj_5XpPkMtqpWfY6rYkAaD1RDE5yH9X",
      observed_at: new Date().toISOString(),
      provider_readiness: { configured: false, access_required: false, credential_mode: "BROWSER_BYOK", image_ledger_configured: false, image_ledger_attested: false },
    }),
  });
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_SOURCE_COMMIT_INVALID"));
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_EVIDENCE_REF_INVALID"));
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_EVIDENCE_HASH_INVALID"));
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_PROVIDER_KEY_MISSING"));
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_ACCESS_NOT_REQUIRED"));
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_CREDENTIAL_MODE_INVALID"));
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_IMAGE_LEDGER_NOT_CONFIGURED"));
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_IMAGE_LEDGER_NOT_ATTESTED"));
});

test("the rollback target must be distinct and its evidence must bind the same deployment", () => {
  const same = receipt();
  same.deployment.rollback_deployment_id = same.deployment.production_deployment_id;
  same.rollback_verification.deployment_id = "dpl_anotherTarget";
  const result = validateJourneyReceipt(same, { targetUrl: url, expectedCommit: commit });
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_DEPLOYMENT_NOT_DISTINCT"));
  assert.ok(result.errors.some((row) => row.code === "ROLLBACK_VERIFICATION_ID_MISMATCH"));
});

test("operator same-draft journey grants HANDOFF_READY only", async () => {
  const result = await evaluateDelivery(deliveryInput(), passingDependencies);
  assert.equal(result.verdict, "HANDOFF_READY");
  assert.equal(result.authority_granted, false);
});

test("a self-labelled Xiaoshimei receipt cannot mint consumer validation", async () => {
  const result = await evaluateDelivery(deliveryInput({ receipt: receipt("xiaoshimei") }), passingDependencies);
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "CONSUMER_SELF_ASSERTION_UNVERIFIED"));
});

test("a save/reopen identity fork blocks both operator and consumer claims", () => {
  const broken = receipt("xiaoshimei");
  broken.same_draft.reopened_draft_id = "draft-two";
  const result = validateJourneyReceipt(broken, { targetUrl: url, expectedCommit: commit });
  assert.ok(result.errors.some((row) => row.code === "JOURNEY_DRAFT_IDENTITY_MISMATCH"));
});

test("a stale operator receipt cannot be reused for a later deployment handoff", () => {
  const stale = receipt();
  stale.observed_at = "2026-08-30T00:00:00Z";
  const result = validateJourneyReceipt(stale, { targetUrl: url, expectedCommit: commit, nowMs: Date.parse("2026-09-02T00:00:00Z") });
  assert.ok(result.errors.some((row) => row.code === "JOURNEY_RECEIPT_STALE"));
});

test("HANDOFF_READY requires an exact alternate-entry census and blocks a second public truth", async () => {
  const missing = await evaluateDelivery(deliveryInput({ alternateUrls: [] }), passingDependencies);
  assert.equal(missing.verdict, "BLOCKED");
  assert.ok(missing.errors.some((row) => row.code === "ALTERNATE_ENTRY_CENSUS_REQUIRED"));
  const repeatedDefault = await evaluateDelivery(deliveryInput({ alternateUrls: [DEFAULT_ALTERNATE_ENTRY_URL] }), passingDependencies);
  assert.ok(repeatedDefault.errors.some((row) => row.code === "ALTERNATE_ENTRY_CENSUS_REQUIRED"));

  const active = await evaluateDelivery(deliveryInput(), {
    ...passingDependencies,
    inspectAlternateEntry: async (alternateUrl) => {
      throw Object.assign(new Error("second public truth"), { code: "ALTERNATE_PUBLIC_ENTRY_ACTIVE", detail: alternateUrl });
    },
  });
  assert.equal(active.verdict, "BLOCKED");
  assert.ok(active.errors.some((row) => row.code === "ALTERNATE_PUBLIC_ENTRY_ACTIVE"));
});

test("a DNS rebinding target that resolves privately is BLOCKED before delivery", async () => {
  let remoteReads = 0;
  const result = await evaluateDelivery(deliveryInput(), {
    ...passingDependencies,
    resolvePublicTarget: async () => { throw Object.assign(new Error("private address"), { code: "DNS_PRIVATE_ADDRESS", detail: "127.0.0.1" }); },
    readRemoteArtifact: async () => { remoteReads += 1; return artifact; },
  });
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "DNS_PRIVATE_ADDRESS"));
  assert.equal(remoteReads, 0);
});
