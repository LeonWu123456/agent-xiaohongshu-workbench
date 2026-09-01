import JSZip from "jszip";
import { buildManifest, publishCopy } from "./content-engine.mjs";
import { MEDIA_ASSET_BACKUP_SCHEMA, MEDIA_REF_PREFIX } from "./media-asset-store.mjs";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function collectPublishMediaRefs(value, refs = new Set()) {
  if (typeof value === "string") {
    if (/^(?:data|blob):/i.test(value)) throw new TypeError("PUBLISH_CONTENT_MEDIA_NOT_CANONICAL");
    if (value.startsWith(MEDIA_REF_PREFIX)) {
      const sha256 = value.slice(MEDIA_REF_PREFIX.length);
      if (!SHA256_PATTERN.test(sha256)) throw new TypeError("PUBLISH_CONTENT_MEDIA_REF_INVALID");
      refs.add(value);
    }
  } else if (Array.isArray(value)) value.forEach((item) => collectPublishMediaRefs(item, refs));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectPublishMediaRefs(item, refs));
  return [...refs].sort();
}

function exactMediaAssets(content, mediaAssets) {
  if (!Array.isArray(mediaAssets)) throw new TypeError("PUBLISH_MEDIA_ASSETS_INVALID");
  const expectedRefs = collectPublishMediaRefs(content);
  const assets = mediaAssets.map((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset) || asset.schema !== MEDIA_ASSET_BACKUP_SCHEMA) {
      throw new TypeError("PUBLISH_MEDIA_ASSET_SCHEMA_INVALID");
    }
    const sha256 = String(asset.sha256 || "");
    if (!SHA256_PATTERN.test(sha256) || asset.media_ref !== `${MEDIA_REF_PREFIX}${sha256}` || typeof asset.bytes_base64 !== "string") {
      throw new TypeError("PUBLISH_MEDIA_ASSET_IDENTITY_INVALID");
    }
    return structuredClone(asset);
  }).sort((left, right) => left.sha256.localeCompare(right.sha256));
  const actualRefs = assets.map((asset) => asset.media_ref);
  if (new Set(actualRefs).size !== actualRefs.length || JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) {
    throw new TypeError("PUBLISH_MEDIA_ASSET_SET_MISMATCH");
  }
  return assets;
}

export function inspectPng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new TypeError("rendered page is not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunkType !== "IHDR") throw new TypeError("PNG IHDR is missing");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export async function buildPublishZip(content, pngPages, options = {}) {
  if (!Array.isArray(pngPages) || pngPages.length !== content.visible_pages) throw new TypeError("all visible pages must be rendered before ZIP creation");
  const zip = new JSZip();
  const createdAt = options.createdAt || new Date().toISOString();
  const entryDate = new Date(createdAt);
  if (Number.isNaN(entryDate.getTime())) throw new TypeError("ZIP createdAt is invalid");
  const portableContent = structuredClone(content);
  delete portableContent.id;
  delete portableContent.saved_at;
  delete portableContent.reality_feedback;
  const mediaAssets = exactMediaAssets(portableContent, options.mediaAssets || []);
  const names = [];
  pngPages.forEach((page, index) => {
    const dimensions = inspectPng(page);
    if (dimensions.width !== 1080 || dimensions.height !== 1440) throw new TypeError(`page ${index + 1} must be 1080x1440 PNG`);
    const name = `${String(index + 1).padStart(2, "0")}.png`;
    names.push(name);
    zip.file(name, page, { date: entryDate });
  });
  zip.file("publish-copy.txt", publishCopy(content), { date: entryDate });
  zip.file("content.json", JSON.stringify(portableContent, null, 2), { date: entryDate });
  zip.file("media-assets.json", JSON.stringify(mediaAssets, null, 2), { date: entryDate });
  const manifest = buildManifest(portableContent, names, createdAt, {
    publicationAuthority: options.publicationAuthority,
  });
  manifest.files = [...names, "publish-copy.txt", "content.json", "media-assets.json", "manifest.json"];
  manifest.content_media_contract = "canonical-refs-with-verified-backup-assets-v1";
  manifest.media_assets_file = "media-assets.json";
  manifest.media_asset_count = mediaAssets.length;
  zip.file("manifest.json", JSON.stringify(manifest, null, 2), { date: entryDate });
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } });
}
