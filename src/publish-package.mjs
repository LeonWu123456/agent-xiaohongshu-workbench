import JSZip from "jszip";
import { buildManifest, publishCopy } from "./content-engine.mjs";
import { detectImageMime, sha256MediaBytes } from "./media-asset-store.mjs";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PACKAGE_MEDIA_CONTRACT = "archive-relative-v1";

function isEphemeralMediaRef(value) {
  return typeof value === "string" && (/^blob:/i.test(value) || /^data:image\//i.test(value));
}

function collectEphemeralMediaRefs(value, refs = new Set()) {
  if (isEphemeralMediaRef(value)) refs.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectEphemeralMediaRefs(item, refs));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectEphemeralMediaRefs(item, refs));
  return refs;
}

function replaceEphemeralMediaRefs(value, replacements) {
  if (isEphemeralMediaRef(value)) return replacements.get(value);
  if (Array.isArray(value)) return value.map((item) => replaceEphemeralMediaRefs(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceEphemeralMediaRefs(item, replacements)]));
  }
  return value;
}

function mediaExtension(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  throw new TypeError("PACKAGE_MEDIA_MIME_UNSUPPORTED");
}

function mediaBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new TypeError("PACKAGE_MEDIA_BYTES_INVALID");
}

async function fetchMediaBytes(ref, fetchApi = globalThis.fetch) {
  if (typeof fetchApi !== "function") throw new TypeError("PACKAGE_MEDIA_FETCH_UNAVAILABLE");
  const response = await fetchApi(ref);
  if (!response?.ok) throw new TypeError("PACKAGE_MEDIA_FETCH_FAILED");
  return new Uint8Array(await response.arrayBuffer());
}

async function packageMedia(value, options) {
  const refs = [...collectEphemeralMediaRefs(value)].sort();
  const replacements = new Map();
  const files = new Map();
  const resolveMedia = options.resolveMedia || ((ref) => fetchMediaBytes(ref, options.fetchApi));
  for (const ref of refs) {
    let bytes;
    try { bytes = mediaBytes(await resolveMedia(ref)); }
    catch (error) { throw new TypeError(`PACKAGE_MEDIA_RESOLVE_FAILED: ${error?.message || "unknown"}`); }
    const mime = detectImageMime(bytes);
    const sha256 = await sha256MediaBytes(bytes, { cryptoApi: options.cryptoApi });
    const name = `media/${sha256}.${mediaExtension(mime)}`;
    replacements.set(ref, `./${name}`);
    if (!files.has(name)) files.set(name, bytes);
  }
  return {
    content: replaceEphemeralMediaRefs(value, replacements),
    files: [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
  };
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
  const contentWithoutLocalState = structuredClone(content);
  delete contentWithoutLocalState.id;
  delete contentWithoutLocalState.saved_at;
  delete contentWithoutLocalState.reality_feedback;
  const packagedMedia = await packageMedia(contentWithoutLocalState, options);
  const portableContent = packagedMedia.content;
  const names = [];
  pngPages.forEach((page, index) => {
    const dimensions = inspectPng(page);
    if (dimensions.width !== 1080 || dimensions.height !== 1440) throw new TypeError(`page ${index + 1} must be 1080x1440 PNG`);
    const name = `${String(index + 1).padStart(2, "0")}.png`;
    names.push(name);
    zip.file(name, page, { date: entryDate });
  });
  zip.file("publish-copy.txt", publishCopy(content), { date: entryDate });
  for (const [name, bytes] of packagedMedia.files) zip.file(name, bytes, { date: entryDate, createFolders: false });
  zip.file("content.json", JSON.stringify(portableContent, null, 2), { date: entryDate });
  const manifest = buildManifest(portableContent, names, createdAt);
  const mediaNames = packagedMedia.files.map(([name]) => name);
  manifest.files = [...names, "publish-copy.txt", ...mediaNames, "content.json", "manifest.json"];
  manifest.content_media_contract = PACKAGE_MEDIA_CONTRACT;
  manifest.content_media_files = mediaNames;
  zip.file("manifest.json", JSON.stringify(manifest, null, 2), { date: entryDate });
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 9 } });
}
