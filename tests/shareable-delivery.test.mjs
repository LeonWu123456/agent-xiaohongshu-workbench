import assert from "node:assert/strict";
import test from "node:test";

import {
  JOURNEY_SCHEMA,
  classifyTargetUrl,
  collectEntrypointAssetPaths,
  compareArtifacts,
  evaluateDelivery,
  isPublicAddress,
  readRemoteArtifact,
  resolvePublicTarget,
  validateJourneyReceipt,
} from "../scripts/verify-shareable-delivery.mjs";

const commit = "a".repeat(40);
const url = "https://xiaoshimei-full-workbench.vercel.app/";
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
    steps: { open: true, access: true, edit: true, save: true, reopen: true, copy: true, download: true },
    same_draft: { initial_draft_id: "draft-one", saved_draft_id: "draft-one", reopened_draft_id: "draft-one", export_source_draft_id: "draft-one" },
  };
}

const passingDependencies = {
  inspectCandidate: async () => ({ root: "/candidate", head: commit, worktree: "CLEAN" }),
  resolvePublicTarget: async () => ["76.76.21.21"],
  readLocalArtifact: async () => structuredClone(artifact),
  readRemoteArtifact: async () => structuredClone(artifact),
};

test("loopback, LAN, HTTP and credentialed URLs never become shareable", () => {
  for (const value of ["http://127.0.0.1:4184/", "https://localhost/", "https://192.168.1.8/", "https://[::1]/"]) {
    assert.equal(classifyTargetUrl(value).kind, "LOCAL_ONLY", value);
  }
  assert.equal(classifyTargetUrl("http://example.com/").kind, "BLOCKED");
  assert.equal(classifyTargetUrl("https://user:pass@example.com/").kind, "BLOCKED");
  assert.equal(classifyTargetUrl("https://example.com:8443/").kind, "BLOCKED");
});

test("a different public HTTPS origin is not the stable delivery target", async () => {
  const result = await evaluateDelivery({ targetUrl: "https://example.com/", expectedCommit: commit, candidateRoot: "/candidate", receipt: receipt() }, passingDependencies);
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
  const result = await evaluateDelivery({ targetUrl: url, expectedCommit: commit, candidateRoot: "/candidate", receipt: receipt() }, { ...passingDependencies, readRemoteArtifact: async () => old });
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "HTML_ARTIFACT_MISMATCH"));
});

test("missing journey evidence cannot be upgraded by a public exact artifact", async () => {
  const result = await evaluateDelivery({ targetUrl: url, expectedCommit: commit, candidateRoot: "/candidate" }, passingDependencies);
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "JOURNEY_RECEIPT_REQUIRED"));
});

test("operator same-draft journey grants HANDOFF_READY only", async () => {
  const result = await evaluateDelivery({ targetUrl: url, expectedCommit: commit, candidateRoot: "/candidate", receipt: receipt() }, passingDependencies);
  assert.equal(result.verdict, "HANDOFF_READY");
  assert.equal(result.authority_granted, false);
});

test("a self-labelled Xiaoshimei receipt cannot mint consumer validation", async () => {
  const result = await evaluateDelivery({ targetUrl: url, expectedCommit: commit, candidateRoot: "/candidate", receipt: receipt("xiaoshimei") }, passingDependencies);
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

test("a DNS rebinding target that resolves privately is BLOCKED before delivery", async () => {
  let remoteReads = 0;
  const result = await evaluateDelivery({ targetUrl: url, expectedCommit: commit, candidateRoot: "/candidate", receipt: receipt() }, {
    ...passingDependencies,
    resolvePublicTarget: async () => { throw Object.assign(new Error("private address"), { code: "DNS_PRIVATE_ADDRESS", detail: "127.0.0.1" }); },
    readRemoteArtifact: async () => { remoteReads += 1; return artifact; },
  });
  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.errors.some((row) => row.code === "DNS_PRIVATE_ADDRESS"));
  assert.equal(remoteReads, 0);
});
