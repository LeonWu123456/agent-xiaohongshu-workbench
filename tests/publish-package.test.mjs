import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { generateContentPackage, parseContentPackage } from "../src/content-engine.mjs";
import { buildPublishZip, inspectPng } from "../src/publish-package.mjs";
import { MEDIA_ASSET_BACKUP_SCHEMA, mediaRefForSha256 } from "../src/media-asset-store.mjs";

function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("ZIP contains ordered PNGs, UTF-8 copy, reloadable content and matching manifest", async () => {
  const content = generateContentPackage({ topic: "中文发布包回读" });
  const blob = await buildPublishZip(content, [pngHeader(1080, 1440), pngHeader(1080, 1440)]);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.deepEqual(Object.keys(zip.files), ["01.png", "02.png", "publish-copy.txt", "content.json", "media-assets.json", "manifest.json"]);
  const copy = await zip.file("publish-copy.txt").async("string");
  assert.match(copy, /中文发布包回读/);
  assert.equal((copy.match(/#/g) || []).length, 5);
  const restored = parseContentPackage(await zip.file("content.json").async("string"));
  assert.equal(restored.visible_pages, 2);
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.page_count, 2);
  assert.deepEqual(manifest.files, Object.keys(zip.files));
  assert.equal(manifest.content_media_contract, "canonical-refs-with-verified-backup-assets-v1");
  assert.equal(manifest.media_assets_file, "media-assets.json");
  assert.equal(manifest.media_asset_count, 0);
  assert.deepEqual(JSON.parse(await zip.file("media-assets.json").async("string")), []);
});

test("ZIP keeps canonical refs and embeds the exact verified media backup set", async () => {
  const content = generateContentPackage({ topic: "自包含媒体" });
  const firstSha = "a".repeat(64);
  const secondSha = "b".repeat(64);
  const firstRef = mediaRefForSha256(firstSha);
  const secondRef = mediaRefForSha256(secondSha);
  content.pages[0].image_style.src = firstRef;
  content.pages[0].image_style.original_src = firstRef;
  content.pages[1].image_style.src = secondRef;
  const mediaAssets = [
    { schema: MEDIA_ASSET_BACKUP_SCHEMA, media_ref: secondRef, sha256: secondSha, size_bytes: 24, mime: "image/png", bytes_base64: "second" },
    { schema: MEDIA_ASSET_BACKUP_SCHEMA, media_ref: firstRef, sha256: firstSha, size_bytes: 24, mime: "image/png", bytes_base64: "first" },
  ];
  const blob = await buildPublishZip(content, [pngHeader(1080, 1440), pngHeader(1080, 1440)], {
    mediaAssets,
  });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const portableText = await zip.file("content.json").async("string");
  assert.equal(portableText.includes("blob:"), false);
  assert.equal(portableText.includes("data:image/"), false);
  const portable = JSON.parse(portableText);
  assert.equal(portable.pages[0].image_style.src, firstRef);
  assert.equal(portable.pages[0].image_style.original_src, portable.pages[0].image_style.src);
  assert.equal(portable.pages[1].image_style.src, secondRef);
  const packagedAssets = JSON.parse(await zip.file("media-assets.json").async("string"));
  assert.deepEqual(packagedAssets.map((item) => item.media_ref), [firstRef, secondRef]);
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.content_media_contract, "canonical-refs-with-verified-backup-assets-v1");
  assert.equal(manifest.media_assets_file, "media-assets.json");
  assert.equal(manifest.media_asset_count, 2);
  assert.deepEqual(manifest.files, Object.keys(zip.files));
});

test("ZIP refuses runtime media and a canonical ref without its verified backup asset", async () => {
  const content = generateContentPackage({ topic: "临时引用拒绝" });
  content.pages[0].image_style.src = "blob:http://127.0.0.1:4184/missing";
  await assert.rejects(() => buildPublishZip(content, [pngHeader(1080, 1440), pngHeader(1080, 1440)]), /PUBLISH_CONTENT_MEDIA_NOT_CANONICAL/);
  content.pages[0].image_style.src = mediaRefForSha256("c".repeat(64));
  await assert.rejects(() => buildPublishZip(content, [pngHeader(1080, 1440), pngHeader(1080, 1440)]), /PUBLISH_MEDIA_ASSET_SET_MISMATCH/);
});

test("ZIP creation rejects a partial render", async () => {
  const content = generateContentPackage({ topic: "半包拒绝" });
  await assert.rejects(() => buildPublishZip(content, [pngHeader(1080, 1440)]), /all visible pages/);
});

test("PNG verification rejects fake bytes and wrong dimensions", async () => {
  assert.throws(() => inspectPng(new Uint8Array([1, 2, 3])), /not a PNG/);
  const content = generateContentPackage({ topic: "尺寸拒绝" });
  await assert.rejects(() => buildPublishZip(content, [pngHeader(1080, 1440), pngHeader(720, 960)]), /must be 1080x1440/);
});

test("frozen evidence time makes the same publish package byte-for-byte reproducible", async () => {
  const content = generateContentPackage({ topic: "冻结哈希" });
  content.created_at = "2026-08-14T00:00:00.000Z";
  const pages = [pngHeader(1080, 1440), pngHeader(1080, 1440)];
  const options = { createdAt: "2026-08-14T00:51:10+08:00" };
  const first = new Uint8Array(await (await buildPublishZip(content, pages, options)).arrayBuffer());
  const second = new Uint8Array(await (await buildPublishZip(content, pages, options)).arrayBuffer());
  assert.deepEqual(first, second);
});

test("local draft id and save timestamp do not make the portable ZIP hash drift", async () => {
  const content = generateContentPackage({ topic: "跨回载稳定" });
  const pages = [pngHeader(1080, 1440), pngHeader(1080, 1440)];
  const options = { createdAt: content.created_at };
  const first = { ...content, id: "draft-a", saved_at: "2026-08-14T01:00:00Z" };
  const second = { ...content, id: "draft-b", saved_at: "2026-08-14T02:00:00Z" };
  const firstBytes = new Uint8Array(await (await buildPublishZip(first, pages, options)).arrayBuffer());
  const secondBytes = new Uint8Array(await (await buildPublishZip(second, pages, options)).arrayBuffer());
  assert.deepEqual(firstBytes, secondBytes);
  const zip = await JSZip.loadAsync(firstBytes);
  const portable = JSON.parse(await zip.file("content.json").async("string"));
  assert.equal(portable.id, undefined);
  assert.equal(portable.saved_at, undefined);
});
