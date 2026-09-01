import {
  MEDIA_ASSET_MANIFEST_SCHEMA,
  detectImageMime,
  mediaRefForSha256,
  parseMediaRef,
  sha256MediaBytes,
} from "./media-asset-store.mjs";

export const ACTION_REFERENCE_MAX_COUNT = 3;
export const ACTION_REFERENCE_MAX_EDGE = 1280;
export const ACTION_REFERENCE_MAX_ENCODED_BYTES = 900_000;
export const ACTION_REFERENCE_MAX_TOTAL_BYTES = 2_700_000;
export const ACTION_REFERENCE_MAX_SOURCE_BYTES = 20_000_000;
export const ACTION_REFERENCE_MAX_DECODED_PIXELS = 40_000_000;
export const ACTION_REFERENCE_MIN_EDGE = 32;
export const ACTION_REFERENCE_MAX_ASPECT_RATIO = 20;

const JPEG_QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58];
const OUTPUT_SCALES = [1, 0.9, 0.8];
const ALLOWED_INPUT_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

function actionError(code) {
  return new TypeError(code);
}

function bytesView(value, code = "ACTION_REFERENCE_BYTES_INVALID") {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw actionError(code);
}

function canonicalName(value, fallback = "动作参考图") {
  const name = typeof value === "string" ? value.trim() : "";
  return (name || fallback).slice(0, 100);
}

async function readInputBytes(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw actionError("ACTION_REFERENCE_INPUT_INVALID");
  const declaredSize = input.size;
  if (declaredSize != null && (!Number.isInteger(declaredSize) || declaredSize < 1)) throw actionError("ACTION_REFERENCE_SOURCE_SIZE_INVALID");
  if (declaredSize > ACTION_REFERENCE_MAX_SOURCE_BYTES) throw actionError("ACTION_REFERENCE_SOURCE_TOO_LARGE");
  let bytes;
  if (input.bytes != null) bytes = bytesView(input.bytes);
  else if (typeof input.arrayBuffer === "function") bytes = bytesView(await input.arrayBuffer());
  else throw actionError("ACTION_REFERENCE_BYTES_INVALID");
  if (bytes.byteLength < 1) throw actionError("ACTION_REFERENCE_BYTES_INVALID");
  if (bytes.byteLength > ACTION_REFERENCE_MAX_SOURCE_BYTES) throw actionError("ACTION_REFERENCE_SOURCE_TOO_LARGE");
  if (declaredSize != null && declaredSize !== bytes.byteLength) throw actionError("ACTION_REFERENCE_SOURCE_SIZE_MISMATCH");
  const mime = detectImageMime(bytes);
  if (!ALLOWED_INPUT_MIMES.has(mime)) throw actionError("ACTION_REFERENCE_MIME_UNSUPPORTED");
  const claimedMime = typeof input.type === "string" && input.type ? input.type : input.mime;
  if (claimedMime != null && claimedMime !== "" && claimedMime !== mime) throw actionError("ACTION_REFERENCE_MIME_MISMATCH");
  return { bytes, mime, name: canonicalName(input.name) };
}

function uint32be(bytes, offset) {
  return (((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0);
}

function encodedDimensions(bytes, mime) {
  if (mime === "image/png" && bytes.byteLength >= 24) {
    return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 8 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2 || offset + 2 + length > bytes.byteLength) return null;
      if (sof.has(marker) && length >= 7) {
        return { width: (bytes[offset + 7] << 8) | bytes[offset + 8], height: (bytes[offset + 5] << 8) | bytes[offset + 6] };
      }
      offset += 2 + length;
    }
  }
  if (mime === "image/webp" && bytes.byteLength >= 30
    && String.fromCharCode(...bytes.subarray(12, 16)) === "VP8X") {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height };
  }
  return null;
}

function assertSafeDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw actionError("ACTION_REFERENCE_DIMENSIONS_INVALID");
  if (width * height > ACTION_REFERENCE_MAX_DECODED_PIXELS) throw actionError("ACTION_REFERENCE_PIXEL_BOMB");
  const shortest = Math.min(width, height);
  const longest = Math.max(width, height);
  if (shortest < ACTION_REFERENCE_MIN_EDGE) throw actionError("ACTION_REFERENCE_DIMENSIONS_TOO_SMALL");
  if (longest / shortest > ACTION_REFERENCE_MAX_ASPECT_RATIO) throw actionError("ACTION_REFERENCE_ASPECT_RATIO_EXTREME");
}

async function defaultDecodeImage({ bytes, mime }) {
  if (typeof globalThis.createImageBitmap !== "function" || typeof globalThis.Blob !== "function") {
    throw actionError("ACTION_REFERENCE_BROWSER_DECODER_UNAVAILABLE");
  }
  let image;
  try {
    image = await globalThis.createImageBitmap(new globalThis.Blob([bytes], { type: mime }), { imageOrientation: "from-image" });
  } catch {
    throw actionError("ACTION_REFERENCE_DECODE_FAILED");
  }
  return {
    image,
    width: image.width,
    height: image.height,
    orientation: 1,
    orientationApplied: true,
    hasAlpha: mime !== "image/jpeg",
    release() { image.close?.(); },
  };
}

function defaultCanvas(width, height) {
  if (typeof globalThis.OffscreenCanvas === "function") return new globalThis.OffscreenCanvas(width, height);
  if (globalThis.document?.createElement) {
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw actionError("ACTION_REFERENCE_CANVAS_UNAVAILABLE");
}

function drawOriented(context, image, width, height, orientation) {
  context.save();
  switch (orientation) {
    case 2: context.translate(width, 0); context.scale(-1, 1); break;
    case 3: context.translate(width, height); context.rotate(Math.PI); break;
    case 4: context.translate(0, height); context.scale(1, -1); break;
    case 5: context.rotate(Math.PI / 2); context.scale(1, -1); break;
    case 6: context.translate(width, 0); context.rotate(Math.PI / 2); break;
    case 7: context.translate(width, height); context.scale(-1, 1); context.rotate(Math.PI / 2); break;
    case 8: context.translate(0, height); context.rotate(-Math.PI / 2); break;
    default: break;
  }
  const swap = orientation >= 5 && orientation <= 8;
  context.drawImage(image, 0, 0, swap ? height : width, swap ? width : height);
  context.restore();
}

async function blobBytes(value) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return bytesView(value);
  if (value && typeof value.arrayBuffer === "function") return bytesView(await value.arrayBuffer());
  throw actionError("ACTION_REFERENCE_ENCODER_OUTPUT_INVALID");
}

async function defaultEncodeJpeg({ image, width, height, orientation, background, quality, canvasFactory = defaultCanvas }) {
  const canvas = canvasFactory(width, height);
  if (!canvas || !Number.isInteger(canvas.width) || !Number.isInteger(canvas.height)) throw actionError("ACTION_REFERENCE_CANVAS_INVALID");
  const context = canvas.getContext?.("2d", { alpha: false });
  if (!context) throw actionError("ACTION_REFERENCE_CANVAS_INVALID");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  drawOriented(context, image, width, height, orientation);
  if (typeof canvas.convertToBlob === "function") return blobBytes(await canvas.convertToBlob({ type: "image/jpeg", quality }));
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(actionError("ACTION_REFERENCE_ENCODE_FAILED")), "image/jpeg", quality));
    return blobBytes(blob);
  }
  throw actionError("ACTION_REFERENCE_ENCODER_UNAVAILABLE");
}

function displayedDimensions(decoded) {
  const orientation = Number.isInteger(decoded.orientation) ? decoded.orientation : 1;
  if (orientation < 1 || orientation > 8) throw actionError("ACTION_REFERENCE_ORIENTATION_INVALID");
  if (decoded.orientationApplied || orientation < 5) return { width: decoded.width, height: decoded.height, orientation: decoded.orientationApplied ? 1 : orientation };
  return { width: decoded.height, height: decoded.width, orientation };
}

function scaledDimensions(width, height, scaleMultiplier = 1) {
  const fit = Math.min(1, ACTION_REFERENCE_MAX_EDGE / Math.max(width, height)) * scaleMultiplier;
  return {
    width: Math.max(1, Math.round(width * fit)),
    height: Math.max(1, Math.round(height * fit)),
  };
}

export async function canonicalizeActionReference(input, {
  decodeImage = defaultDecodeImage,
  encodeJpeg = defaultEncodeJpeg,
  cryptoApi = globalThis.crypto,
  canvasFactory,
} = {}) {
  const source = await readInputBytes(input);
  const headerDimensions = encodedDimensions(source.bytes, source.mime);
  if (headerDimensions && (headerDimensions.width * headerDimensions.height > ACTION_REFERENCE_MAX_DECODED_PIXELS
    || Math.max(headerDimensions.width, headerDimensions.height) > 65_535)) {
    throw actionError("ACTION_REFERENCE_PIXEL_BOMB");
  }
  let decoded;
  try {
    decoded = await decodeImage({ bytes: source.bytes, mime: source.mime, name: source.name });
  } catch (error) {
    if (error instanceof TypeError && /^ACTION_REFERENCE_/.test(error.message)) throw error;
    throw actionError("ACTION_REFERENCE_DECODE_FAILED");
  }
  try {
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw actionError("ACTION_REFERENCE_DECODE_FAILED");
    assertSafeDimensions(decoded.width, decoded.height);
    const display = displayedDimensions(decoded);
    assertSafeDimensions(display.width, display.height);
    for (const scale of OUTPUT_SCALES) {
      const dimensions = scaledDimensions(display.width, display.height, scale);
      if (Math.min(dimensions.width, dimensions.height) < ACTION_REFERENCE_MIN_EDGE) continue;
      for (const quality of JPEG_QUALITIES) {
        const encoded = await blobBytes(await encodeJpeg({
          image: decoded.image,
          width: dimensions.width,
          height: dimensions.height,
          orientation: display.orientation,
          background: "#ffffff",
          sourceHasAlpha: Boolean(decoded.hasAlpha),
          quality,
          ...(canvasFactory ? { canvasFactory } : {}),
        }));
        let mime;
        try { mime = detectImageMime(encoded); }
        catch { throw actionError("ACTION_REFERENCE_ENCODER_NOT_JPEG"); }
        if (mime !== "image/jpeg") throw actionError("ACTION_REFERENCE_ENCODER_NOT_JPEG");
        if (encoded.byteLength > ACTION_REFERENCE_MAX_ENCODED_BYTES) continue;
        const sha256 = await sha256MediaBytes(encoded, { cryptoApi });
        return {
          schema: MEDIA_ASSET_MANIFEST_SCHEMA,
          media_ref: mediaRefForSha256(sha256),
          sha256,
          size_bytes: encoded.byteLength,
          mime: "image/jpeg",
          name: source.name,
          width: dimensions.width,
          height: dimensions.height,
          bytes: encoded,
        };
      }
    }
    throw actionError("ACTION_REFERENCE_CANONICAL_TOO_LARGE");
  } finally {
    decoded?.release?.();
  }
}

export function assertActionReferenceManifestBatch(value) {
  if (!Array.isArray(value)) throw actionError("ACTION_REFERENCE_MANIFESTS_INVALID");
  if (value.length > ACTION_REFERENCE_MAX_COUNT) throw actionError("ACTION_REFERENCE_COUNT_EXCEEDED");
  let total = 0;
  const normalized = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.schema !== MEDIA_ASSET_MANIFEST_SCHEMA) {
      throw actionError("ACTION_REFERENCE_MANIFEST_INVALID");
    }
    if (!/^[0-9a-f]{64}$/.test(item.sha256 || "")) throw actionError("ACTION_REFERENCE_HASH_INVALID");
    if (parseMediaRef(item.media_ref) !== item.sha256) throw actionError("ACTION_REFERENCE_REF_HASH_MISMATCH");
    if (item.mime !== "image/jpeg") throw actionError("ACTION_REFERENCE_CANONICAL_MIME_INVALID");
    if (!Number.isInteger(item.size_bytes) || item.size_bytes < 1) throw actionError("ACTION_REFERENCE_SIZE_INVALID");
    if (item.size_bytes > ACTION_REFERENCE_MAX_ENCODED_BYTES) throw actionError("ACTION_REFERENCE_CANONICAL_TOO_LARGE");
    if (!Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width < ACTION_REFERENCE_MIN_EDGE || item.height < ACTION_REFERENCE_MIN_EDGE) {
      throw actionError("ACTION_REFERENCE_DIMENSIONS_INVALID");
    }
    if (Math.max(item.width, item.height) > ACTION_REFERENCE_MAX_EDGE) throw actionError("ACTION_REFERENCE_DIMENSIONS_TOO_LARGE");
    const name = canonicalName(item.name);
    total += item.size_bytes;
    return {
      schema: MEDIA_ASSET_MANIFEST_SCHEMA,
      media_ref: item.media_ref,
      sha256: item.sha256,
      size_bytes: item.size_bytes,
      mime: item.mime,
      name,
      width: item.width,
      height: item.height,
    };
  });
  if (total > ACTION_REFERENCE_MAX_TOTAL_BYTES) throw actionError("ACTION_REFERENCE_TOTAL_TOO_LARGE");
  return normalized;
}

export async function canonicalizeActionReferences(inputs, options = {}) {
  if (!Array.isArray(inputs)) throw actionError("ACTION_REFERENCE_INPUTS_INVALID");
  if (inputs.length > ACTION_REFERENCE_MAX_COUNT) throw actionError("ACTION_REFERENCE_COUNT_EXCEEDED");
  const results = [];
  let total = 0;
  for (const input of inputs) {
    const result = await canonicalizeActionReference(input, options);
    total += result.size_bytes;
    if (total > ACTION_REFERENCE_MAX_TOTAL_BYTES) throw actionError("ACTION_REFERENCE_TOTAL_TOO_LARGE");
    results.push(result);
  }
  return results;
}

export async function persistActionReferences(inputs, { mediaStore, ...canonicalOptions } = {}) {
  if (!mediaStore?.putVerifiedMedia) throw actionError("ACTION_REFERENCE_MEDIA_STORE_REQUIRED");
  const canonical = await canonicalizeActionReferences(inputs, canonicalOptions);
  const manifests = [];
  for (const item of canonical) {
    const saved = await mediaStore.putVerifiedMedia({ bytes: item.bytes, mime_type: item.mime, sha256: item.sha256 });
    if (saved.media_ref !== item.media_ref || saved.sha256 !== item.sha256 || saved.mime !== item.mime || saved.size_bytes !== item.size_bytes) {
      throw actionError("ACTION_REFERENCE_MEDIA_READBACK_MISMATCH");
    }
    manifests.push({
      schema: MEDIA_ASSET_MANIFEST_SCHEMA,
      media_ref: item.media_ref,
      sha256: item.sha256,
      size_bytes: item.size_bytes,
      mime: item.mime,
      name: item.name,
      width: item.width,
      height: item.height,
    });
  }
  return assertActionReferenceManifestBatch(manifests);
}
