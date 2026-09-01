import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_REFERENCE_MAX_COUNT,
  ACTION_REFERENCE_MAX_EDGE,
  ACTION_REFERENCE_MAX_ENCODED_BYTES,
  ACTION_REFERENCE_MAX_SOURCE_BYTES,
  assertActionReferenceManifestBatch,
  canonicalizeActionReference,
  canonicalizeActionReferences,
  persistActionReferences,
} from "../src/action-reference-media.mjs";
import { createMediaAssetStore, createMemoryMediaDatabase } from "../src/media-asset-store.mjs";

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

function fileLike(bytes, { name = "reference.png", type = "image/png", size = bytes.byteLength, onRead } = {}) {
  return {
    name,
    type,
    size,
    async arrayBuffer() {
      onRead?.();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function browserPipeline({ width = 640, height = 480, orientation = 1, orientationApplied = true, hasAlpha = false, encoded = jpegBytes(9) } = {}) {
  const calls = { decode: [], encode: [] };
  return {
    calls,
    decodeImage: async (input) => {
      calls.decode.push(input);
      return { image: { fixture: true }, width, height, orientation, orientationApplied, hasAlpha, release() {} };
    },
    encodeJpeg: async (input) => {
      calls.encode.push(input);
      return encoded;
    },
  };
}

test("batch count and declared source size fail before any file bytes are read", async () => {
  let reads = 0;
  const pipeline = browserPipeline();
  const tooMany = Array.from({ length: ACTION_REFERENCE_MAX_COUNT + 1 }, (_, index) => fileLike(pngBytes(index + 1), { onRead: () => { reads += 1; } }));
  await assert.rejects(() => canonicalizeActionReferences(tooMany, pipeline), /ACTION_REFERENCE_COUNT_EXCEEDED/);
  assert.equal(reads, 0);
  await assert.rejects(() => canonicalizeActionReference(fileLike(pngBytes(), {
    size: ACTION_REFERENCE_MAX_SOURCE_BYTES + 1,
    onRead: () => { reads += 1; },
  }), pipeline), /ACTION_REFERENCE_SOURCE_TOO_LARGE/);
  assert.equal(reads, 0);
});

test("PNG/WebP/JPEG inputs canonicalize to bounded JPEG and EXIF rotation plus alpha are explicit", async () => {
  const pipeline = browserPipeline({ width: 4000, height: 2000, orientation: 6, orientationApplied: false, hasAlpha: true });
  const result = await canonicalizeActionReference(fileLike(pngBytes(), { name: "弓步.png" }), pipeline);
  assert.equal(result.mime, "image/jpeg");
  assert.match(result.media_ref, /^xiaoshimei-media:\/\/sha256\/[0-9a-f]{64}$/);
  assert.equal(result.sha256, result.media_ref.slice(-64));
  assert.equal(result.width, 640);
  assert.equal(result.height, ACTION_REFERENCE_MAX_EDGE);
  assert.ok(result.size_bytes <= ACTION_REFERENCE_MAX_ENCODED_BYTES);
  assert.equal(pipeline.calls.encode[0].width, 640);
  assert.equal(pipeline.calls.encode[0].height, ACTION_REFERENCE_MAX_EDGE);
  assert.equal(pipeline.calls.encode[0].orientation, 6);
  assert.equal(pipeline.calls.encode[0].background, "#ffffff");
  assert.equal(pipeline.calls.encode[0].sourceHasAlpha, true);

  for (const [bytes, type] of [[jpegBytes(), "image/jpeg"], [webpBytes(), "image/webp"]]) {
    const converted = await canonicalizeActionReference(fileLike(bytes, { type }), browserPipeline());
    assert.equal(converted.mime, "image/jpeg");
  }
});

test("MIME spoof, corrupt data, decompression bomb, extreme aspect and tiny images fail closed", async () => {
  let decoded = 0;
  await assert.rejects(() => canonicalizeActionReference(fileLike(pngBytes(), { type: "image/jpeg" }), {
    decodeImage: async () => { decoded += 1; return { width: 10, height: 10 }; },
    encodeJpeg: async () => jpegBytes(),
  }), /ACTION_REFERENCE_MIME_MISMATCH/);
  assert.equal(decoded, 0);
  await assert.rejects(() => canonicalizeActionReference(fileLike(Uint8Array.of(1, 2, 3), { type: "image/png" }), browserPipeline()), /MEDIA_MAGIC_UNSUPPORTED/);

  for (const [width, height, code] of [
    [10_000, 10_000, /ACTION_REFERENCE_PIXEL_BOMB/],
    [10_000, 100, /ACTION_REFERENCE_ASPECT_RATIO_EXTREME/],
    [16, 16, /ACTION_REFERENCE_DIMENSIONS_TOO_SMALL/],
  ]) {
    await assert.rejects(() => canonicalizeActionReference(fileLike(pngBytes()), browserPipeline({ width, height })), code);
  }
});

test("encoder output remains magic-byte JPEG and cannot exceed the per-asset ceiling", async () => {
  let attempts = 0;
  await assert.rejects(() => canonicalizeActionReference(fileLike(pngBytes()), {
    ...browserPipeline(),
    encodeJpeg: async () => {
      attempts += 1;
      return jpegBytes(attempts, ACTION_REFERENCE_MAX_ENCODED_BYTES + 1);
    },
  }), /ACTION_REFERENCE_CANONICAL_TOO_LARGE/);
  assert.ok(attempts > 1, "canonicalizer should try bounded quality/scale fallbacks before rejecting");
  await assert.rejects(() => canonicalizeActionReference(fileLike(pngBytes()), {
    ...browserPipeline(),
    encodeJpeg: async () => pngBytes(),
  }), /ACTION_REFERENCE_ENCODER_NOT_JPEG/);
});

test("media-first persistence returns ref-only ordered manifests and content-addressed duplicates dedupe", async () => {
  const database = createMemoryMediaDatabase();
  const store = createMediaAssetStore({ database });
  const encoder = browserPipeline({ encoded: jpegBytes(7) });
  const manifests = await persistActionReferences([
    fileLike(pngBytes(1), { name: "动作一.png" }),
    fileLike(pngBytes(2), { name: "动作二.png" }),
  ], { ...encoder, mediaStore: store });
  assert.equal(manifests.length, 2);
  assert.equal(manifests[0].media_ref, manifests[1].media_ref);
  assert.equal(database.stats.puts, 1);
  for (const manifest of manifests) {
    assert.deepEqual(Object.keys(manifest).sort(), ["height", "media_ref", "mime", "name", "schema", "sha256", "size_bytes", "width"]);
    assert.equal("bytes" in manifest, false);
    assert.equal(JSON.stringify(manifest).includes("data:"), false);
    assert.equal(JSON.stringify(manifest).includes("blob:"), false);
  }
  assert.deepEqual(assertActionReferenceManifestBatch(manifests), manifests);
});

test("manifest validation enforces exact ref/hash/MIME/dimensions and total bounds without network", () => {
  const sha = "a".repeat(64);
  const valid = {
    schema: "xiaoshimei.media-asset-manifest.v1",
    media_ref: `xiaoshimei-media://sha256/${sha}`,
    sha256: sha,
    size_bytes: ACTION_REFERENCE_MAX_ENCODED_BYTES,
    mime: "image/jpeg",
    name: "动作",
    width: 960,
    height: 1280,
  };
  assert.equal(assertActionReferenceManifestBatch([valid, { ...valid, name: "动作二" }, { ...valid, name: "动作三" }]).length, 3);
  assert.throws(() => assertActionReferenceManifestBatch([{ ...valid, media_ref: `xiaoshimei-media://sha256/${"b".repeat(64)}` }]), /ACTION_REFERENCE_REF_HASH_MISMATCH/);
  assert.throws(() => assertActionReferenceManifestBatch([{ ...valid, mime: "image/png" }]), /ACTION_REFERENCE_CANONICAL_MIME_INVALID/);
  assert.throws(() => assertActionReferenceManifestBatch([{ ...valid, size_bytes: ACTION_REFERENCE_MAX_ENCODED_BYTES + 1 }]), /ACTION_REFERENCE_CANONICAL_TOO_LARGE/);
  assert.throws(() => assertActionReferenceManifestBatch([{ ...valid, width: ACTION_REFERENCE_MAX_EDGE + 1 }]), /ACTION_REFERENCE_DIMENSIONS_TOO_LARGE/);
});
