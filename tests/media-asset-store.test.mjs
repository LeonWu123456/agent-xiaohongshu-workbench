import assert from "node:assert/strict";
import test from "node:test";

import {
  MEDIA_ASSET_BACKUP_SCHEMA,
  MEDIA_ASSET_MANIFEST_SCHEMA,
  assertRefOnlyPersistentValue,
  createMediaAssetStore,
  createMemoryMediaDatabase,
  detectImageMime,
  mediaRefForSha256,
  parseMediaRef,
  readMediaStorageStatus,
  requestPersistentMediaStorage,
} from "../src/media-asset-store.mjs";

function jpegBytes(marker = 1, size = 32) {
  const bytes = new Uint8Array(Math.max(8, size));
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, marker & 0xff], 0);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
}

function pngBytes(marker = 1) {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, marker, 0x00, 0x00, 0x00, marker,
  ]);
}

function webpBytes(marker = 1) {
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    marker, 0, 0, 0,
  ]);
}

test("magic bytes, ref grammar and claimed MIME are authoritative", async () => {
  assert.equal(detectImageMime(jpegBytes()), "image/jpeg");
  assert.equal(detectImageMime(pngBytes()), "image/png");
  assert.equal(detectImageMime(webpBytes()), "image/webp");
  assert.throws(() => detectImageMime(Uint8Array.of(1, 2, 3)), /MEDIA_MAGIC_UNSUPPORTED/);

  const store = createMediaAssetStore({ database: createMemoryMediaDatabase() });
  await assert.rejects(() => store.putVerifiedMedia({ bytes: pngBytes(), mime_type: "image/jpeg" }), /MEDIA_MIME_MISMATCH/);
  const saved = await store.putVerifiedMedia({ bytes: jpegBytes(), mime_type: "image/jpeg" });
  assert.equal(parseMediaRef(saved.media_ref), saved.sha256);
  assert.equal(mediaRefForSha256(saved.sha256), saved.media_ref);
  assert.throws(() => parseMediaRef(`xiaoshimei-media://sha256/${"A".repeat(64)}`), /MEDIA_REF_INVALID/);
});

test("put commits then exact readback verifies bytes/hash/size/MIME and same hash dedupes", async () => {
  const database = createMemoryMediaDatabase();
  const store = createMediaAssetStore({ database });
  const first = await store.putVerifiedMedia({ bytes: jpegBytes(3), mime_type: "image/jpeg" });
  const second = await store.putVerifiedMedia({ bytes: jpegBytes(3), mime_type: "image/jpeg", sha256: first.sha256 });
  assert.equal(first.media_ref, second.media_ref);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(database.stats.puts, 1);
  const read = await store.readVerifiedMedia(first.media_ref);
  assert.equal(read.ref, first.media_ref);
  assert.equal(read.media_ref, first.media_ref);
  assert.equal(read.mime, "image/jpeg");
  assert.equal(read.mime_type, "image/jpeg");
  assert.deepEqual(read.bytes, jpegBytes(3));
});

test("tampered database readback fails before a DraftRecord ref can be committed", async () => {
  const underlying = createMemoryMediaDatabase();
  let corrupt = false;
  const database = {
    async get(sha256) {
      const record = await underlying.get(sha256);
      if (!record || !corrupt) return record;
      const bytes = new Uint8Array(record.bytes);
      bytes[7] ^= 0xff;
      return { ...record, bytes };
    },
    async put(record) {
      await underlying.put(record);
      corrupt = true;
    },
  };
  const store = createMediaAssetStore({ database });
  await assert.rejects(() => store.putVerifiedMedia({ bytes: jpegBytes(4), mime_type: "image/jpeg" }), /MEDIA_READBACK_(HASH|BYTES|MIME)_MISMATCH/);
});

test("hydration creates only transient object URLs and release is idempotent", async () => {
  const created = [];
  const revoked = [];
  const urlApi = {
    createObjectURL(blob) { created.push(blob); return `blob:fixture-${created.length}`; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  const store = createMediaAssetStore({ database: createMemoryMediaDatabase(), urlApi, BlobCtor: Blob });
  const saved = await store.putVerifiedMedia({ bytes: jpegBytes(5), mime_type: "image/jpeg" });
  const hydrated = await store.hydrateMedia(saved.media_ref);
  assert.equal(hydrated.url, "blob:fixture-1");
  assert.equal(hydrated.mime, "image/jpeg");
  assert.equal(created[0].type, "image/jpeg");
  store.releaseHydratedMedia(hydrated);
  store.releaseHydratedMedia(hydrated);
  assert.deepEqual(revoked, ["blob:fixture-1"]);
});

test("storage persistence is requested only from an explicit user gesture and returns estimate readback", async () => {
  const calls = [];
  const storageManager = {
    async persisted() { calls.push("persisted"); return calls.includes("persist"); },
    async persist() { calls.push("persist"); return true; },
    async estimate() { calls.push("estimate"); return { usage: 12_345, quota: 9_999_999 }; },
  };
  const status = await readMediaStorageStatus({ storageManager });
  assert.deepEqual(status, { persisted: false, usage: 12_345, quota: 9_999_999 });
  assert.deepEqual(calls, ["persisted", "estimate"]);
  await assert.rejects(() => requestPersistentMediaStorage({ storageManager, userGesture: false }), /MEDIA_PERSIST_REQUIRES_USER_GESTURE/);
  assert.deepEqual(calls, ["persisted", "estimate"]);
  const requested = await requestPersistentMediaStorage({ storageManager, userGesture: true });
  assert.deepEqual(requested, { requested: true, granted: true, persisted: true, usage: 12_345, quota: 9_999_999 });
  assert.deepEqual(calls, ["persisted", "estimate", "persist", "persisted", "estimate"]);
});

test("same content-addressed database survives a simulated day-8 offline reopen with zero Provider fallback", async () => {
  const durableDatabase = createMemoryMediaDatabase();
  const day0 = createMediaAssetStore({ database: durableDatabase });
  const saved = await day0.putVerifiedMedia({ bytes: jpegBytes(6), mime_type: "image/jpeg" });
  let providerCalls = 0;
  const day8Offline = createMediaAssetStore({ database: durableDatabase, providerFallback: () => { providerCalls += 1; } });
  const reopened = await day8Offline.readVerifiedMedia(saved.media_ref);
  assert.deepEqual(reopened.bytes, jpegBytes(6));
  assert.equal(providerCalls, 0);
});

test("self-contained media backup is sorted, deduped, exact-set verified and restored media-first", async () => {
  const source = createMediaAssetStore({ database: createMemoryMediaDatabase() });
  const assetB = await source.putVerifiedMedia({ bytes: jpegBytes(8), mime_type: "image/jpeg" });
  const assetA = await source.putVerifiedMedia({ bytes: pngBytes(2), mime_type: "image/png" });
  const exported = await source.exportMediaAssets([assetB.media_ref, assetA.media_ref, assetB.media_ref]);
  assert.equal(exported.length, 2);
  assert.ok(exported[0].sha256 < exported[1].sha256);
  assert.ok(exported.every((item) => item.schema === MEDIA_ASSET_BACKUP_SCHEMA && typeof item.bytes_base64 === "string"));

  const targetDatabase = createMemoryMediaDatabase();
  const target = createMediaAssetStore({ database: targetDatabase });
  const restored = await target.importMediaAssets(exported, { expectedRefs: [assetA.media_ref, assetB.media_ref] });
  assert.equal(restored.length, 2);
  assert.equal(targetDatabase.stats.puts, 2);
  assert.deepEqual((await target.readVerifiedMedia(assetA.media_ref)).bytes, pngBytes(2));

  for (const broken of [
    exported.slice(0, 1),
    [...exported, { ...exported[0], sha256: "f".repeat(64), media_ref: mediaRefForSha256("f".repeat(64)) }],
    exported.map((item, index) => index ? item : { ...item, bytes_base64: item.bytes_base64.slice(0, -2) + "AA" }),
  ]) {
    const unopened = createMemoryMediaDatabase();
    const emptyTarget = createMediaAssetStore({ database: unopened });
    await assert.rejects(() => emptyTarget.importMediaAssets(broken, { expectedRefs: [assetA.media_ref, assetB.media_ref] }), /MEDIA_BACKUP_(SET_MISMATCH|HASH_MISMATCH|BYTES_INVALID|SIZE_MISMATCH|MIME_MISMATCH)/);
    assert.equal(unopened.stats.puts, 0, "all backup assets must validate before the first media write");
  }
});

test("persistent workspace structures accept refs but reject data/blob URLs at any depth", () => {
  const sha = "c".repeat(64);
  const manifest = {
    schema: MEDIA_ASSET_MANIFEST_SCHEMA,
    media_ref: mediaRefForSha256(sha),
    sha256: sha,
    size_bytes: 123,
    mime: "image/jpeg",
  };
  assert.deepEqual(assertRefOnlyPersistentValue({ drafts: [{ media: [manifest] }] }), { drafts: [{ media: [manifest] }] });
  assert.throws(() => assertRefOnlyPersistentValue({ src: "data:image/png;base64,AAAA" }), /PERSISTENT_MEDIA_EMBEDDED_URL_FORBIDDEN/);
  assert.throws(() => assertRefOnlyPersistentValue({ nested: [{ src: "blob:abc" }] }), /PERSISTENT_MEDIA_EMBEDDED_URL_FORBIDDEN/);
});
