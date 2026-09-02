import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImagesTransaction } from "../api/provider.mjs";
import { createLocalImageLedger } from "../src/local-image-ledger.mjs";

const SETTINGS = {
  apiKey: "test-key-not-sent-during-discovery",
  textModel: "text-model",
  imageModel: "image-model",
  credentialMode: "SERVER_MANAGED",
};

test("loopback DISCOVER uses the transactional ledger instead of the legacy draft shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "xsm-local-ledger-"));
  try {
    const statePath = join(root, "ledger.json");
    const ledger = await createLocalImageLedger({ statePath });
    const result = await generateImagesTransaction({
      mode: "DISCOVER",
      bootstrap_nonce: "a".repeat(64),
      input_sha256: "b".repeat(64),
    }, SETTINGS, {
      imageLedger: ledger,
      appScopeId: "xiaoshimei-local-workbench",
    });
    assert.equal(result.status, "ERROR");
    assert.equal(result.error.code, "IMAGE_LEDGER_RUN_MISSING");
    assert.equal(result.upstream_calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local image ledger persists exact run assets for browser readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "xsm-local-ledger-"));
  try {
    const statePath = join(root, "ledger.json");
    const first = await createLocalImageLedger({ statePath });
    const start = await first.claimStart({
      runId: "images-local-test",
      appScopeId: "xiaoshimei-local-workbench",
      bootstrapNonce: "c".repeat(64),
      inputSha256: "d".repeat(64),
      snapshot: { schema: "xiaoshimei.image-operation-snapshot.v1" },
      referenceManifest: [],
    });
    assert.equal(start.status, "MATERIALIZING");
    const bytes = Buffer.from([0xff, 0xd8, ...Array.from({ length: 128 }, (_, index) => index % 251), 0xff, 0xd9]);
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal((await first.putRunAsset({ runId: "images-local-test", manifest: { sha256: digest, mime: "image/jpeg", size_bytes: bytes.length }, bytes })).status, "STORED");
    const second = await createLocalImageLedger({ statePath });
    const asset = await second.readAsset({ runId: "images-local-test", appScopeId: "xiaoshimei-local-workbench", sha256: digest });
    assert.equal(asset.status, "FOUND");
    assert.deepEqual(asset.bytes, bytes);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).schema, "xiaoshimei.local-image-ledger.v1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
