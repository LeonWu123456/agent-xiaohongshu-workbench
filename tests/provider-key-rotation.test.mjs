import assert from "node:assert/strict";
import test from "node:test";
import { rotatePreviewProviderKey, validateArkApiKey } from "../scripts/rotate-provider-key.mjs";

const OLD_KEY = `ark-${"a".repeat(32)}`;
const NEW_KEY = `ark-${"b".repeat(32)}`;

test("Preview key rotation updates only local Keychain and Preview authority without exposing the value in a receipt", async () => {
  const calls = [];
  const result = await rotatePreviewProviderKey(NEW_KEY, {
    account: "owner",
    platform: "darwin",
    cwd: "/linked/project",
    readCurrent: async () => OLD_KEY,
    writeLocal: async (value, options) => calls.push(["local", value, options.account]),
    writePreview: async (value, options) => calls.push(["preview", value, options.cwd]),
  });
  assert.deepEqual(calls, [
    ["local", NEW_KEY, "owner"],
    ["preview", NEW_KEY, "/linked/project"],
  ]);
  assert.deepEqual(result, { target: "preview", keychainUpdated: true, vercelUpdated: true, redeployRequired: true });
  assert.equal(JSON.stringify(result).includes(NEW_KEY), false);
  assert.equal(JSON.stringify(result).includes(OLD_KEY), false);
});

test("failed Preview update restores both authorities to the previous key", async () => {
  const calls = [];
  await assert.rejects(() => rotatePreviewProviderKey(NEW_KEY, {
    account: "owner",
    platform: "darwin",
    readCurrent: async () => OLD_KEY,
    writeLocal: async (value) => calls.push(["local", value]),
    writePreview: async (value) => {
      calls.push(["preview", value]);
      if (value === NEW_KEY) throw new Error("network failed");
    },
  }), /PREVIEW_KEY_ROTATION_FAILED_ROLLED_BACK/);
  assert.deepEqual(calls, [
    ["local", NEW_KEY],
    ["preview", NEW_KEY],
    ["preview", OLD_KEY],
    ["local", OLD_KEY],
  ]);
});

test("rotation rejects malformed or unchanged keys before mutation", async () => {
  assert.throws(() => validateArkApiKey("not-a-key"), /ARK_API_KEY_FORMAT_INVALID/);
  let writes = 0;
  await assert.rejects(() => rotatePreviewProviderKey(OLD_KEY, {
    account: "owner",
    platform: "darwin",
    readCurrent: async () => OLD_KEY,
    writeLocal: async () => { writes += 1; },
    writePreview: async () => { writes += 1; },
  }), /ARK_API_KEY_UNCHANGED/);
  assert.equal(writes, 0);
});
