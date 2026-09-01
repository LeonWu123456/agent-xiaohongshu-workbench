export const MEDIA_ASSET_MANIFEST_SCHEMA = "xiaoshimei.media-asset-manifest.v1";
export const MEDIA_ASSET_BACKUP_SCHEMA = "xiaoshimei.media-asset-backup.v1";
export const MEDIA_REF_PREFIX = "xiaoshimei-media://sha256/";
export const MEDIA_DATABASE_NAME = "xiaoshimei-media-v1";
export const MEDIA_DATABASE_STORE = "assets";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MEDIA_REF_PATTERN = /^xiaoshimei-media:\/\/sha256\/([0-9a-f]{64})$/;

function mediaError(code) {
  return new TypeError(code);
}

function bytesView(value, code = "MEDIA_BYTES_INVALID") {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw mediaError(code);
}

function cloneRecord(record) {
  if (record == null) return null;
  return { ...record, bytes: bytesView(record.bytes) };
}

function canonicalSha256(value, code = "MEDIA_SHA256_INVALID") {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw mediaError(code);
  return value;
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function asciiAt(bytes, offset, text) {
  if (offset + text.length > bytes.byteLength) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

export function detectImageMime(input) {
  const bytes = bytesView(input);
  const jpeg = bytes.byteLength >= 4
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9;
  if (jpeg) return "image/jpeg";

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png = bytes.byteLength >= 24
    && pngSignature.every((value, index) => bytes[index] === value)
    && bytes[8] === 0x00 && bytes[9] === 0x00 && bytes[10] === 0x00 && bytes[11] === 0x0d
    && asciiAt(bytes, 12, "IHDR");
  if (png) return "image/png";

  const webpChunk = asciiAt(bytes, 12, "VP8 ") || asciiAt(bytes, 12, "VP8L") || asciiAt(bytes, 12, "VP8X");
  if (bytes.byteLength >= 20 && asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP") && webpChunk) return "image/webp";
  throw mediaError("MEDIA_MAGIC_UNSUPPORTED");
}

export async function sha256MediaBytes(input, { cryptoApi = globalThis.crypto } = {}) {
  const bytes = bytesView(input);
  if (!cryptoApi?.subtle?.digest) throw mediaError("MEDIA_CRYPTO_UNAVAILABLE");
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function mediaRefForSha256(value) {
  return `${MEDIA_REF_PREFIX}${canonicalSha256(value)}`;
}

export function parseMediaRef(value) {
  if (typeof value !== "string") throw mediaError("MEDIA_REF_INVALID");
  const match = MEDIA_REF_PATTERN.exec(value);
  if (!match) throw mediaError("MEDIA_REF_INVALID");
  return match[1];
}

function shaFromRefOrHash(value) {
  if (typeof value === "string" && SHA256_PATTERN.test(value)) return value;
  return parseMediaRef(value);
}

function manifestFromRecord(record, extras = {}) {
  return {
    schema: MEDIA_ASSET_MANIFEST_SCHEMA,
    media_ref: mediaRefForSha256(record.sha256),
    sha256: record.sha256,
    size_bytes: record.size_bytes,
    mime: record.mime,
    ...extras,
  };
}

async function validateStoredRecord(record, expectedSha256, { cryptoApi } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw mediaError("MEDIA_READBACK_MISSING");
  const sha256 = canonicalSha256(record.sha256, "MEDIA_READBACK_HASH_MISMATCH");
  if (expectedSha256 && sha256 !== expectedSha256) throw mediaError("MEDIA_READBACK_HASH_MISMATCH");
  const bytes = bytesView(record.bytes, "MEDIA_READBACK_BYTES_MISMATCH");
  if (!Number.isInteger(record.size_bytes) || record.size_bytes !== bytes.byteLength || bytes.byteLength < 1) {
    throw mediaError("MEDIA_READBACK_BYTES_MISMATCH");
  }
  let detectedMime;
  try { detectedMime = detectImageMime(bytes); }
  catch { throw mediaError("MEDIA_READBACK_MIME_MISMATCH"); }
  if (record.mime !== detectedMime) throw mediaError("MEDIA_READBACK_MIME_MISMATCH");
  const actualSha256 = await sha256MediaBytes(bytes, { cryptoApi });
  if (actualSha256 !== sha256) throw mediaError("MEDIA_READBACK_HASH_MISMATCH");
  return { sha256, mime: detectedMime, size_bytes: bytes.byteLength, bytes };
}

function requireDatabase(database) {
  if (!database || typeof database.get !== "function" || typeof database.put !== "function") {
    throw mediaError("MEDIA_DATABASE_INVALID");
  }
  return database;
}

export function createMemoryMediaDatabase(initialRecords = []) {
  const records = new Map();
  const stats = { gets: 0, puts: 0 };
  for (const record of initialRecords) records.set(record.sha256, cloneRecord(record));
  return {
    stats,
    async get(sha256) {
      stats.gets += 1;
      return cloneRecord(records.get(sha256));
    },
    async put(record) {
      stats.puts += 1;
      records.set(record.sha256, cloneRecord(record));
    },
  };
}

function indexedDbRequest(request, transaction) {
  return new Promise((resolve, reject) => {
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || mediaError("MEDIA_INDEXEDDB_REQUEST_FAILED"));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || mediaError("MEDIA_INDEXEDDB_TRANSACTION_ABORTED"));
    transaction.onerror = () => reject(transaction.error || mediaError("MEDIA_INDEXEDDB_TRANSACTION_FAILED"));
  });
}

export function createIndexedDbMediaDatabase({
  indexedDBApi = globalThis.indexedDB,
  dbName = MEDIA_DATABASE_NAME,
  storeName = MEDIA_DATABASE_STORE,
  version = 1,
} = {}) {
  if (!indexedDBApi?.open) throw mediaError("MEDIA_INDEXEDDB_UNAVAILABLE");
  let openPromise;
  const open = () => {
    if (!openPromise) {
      openPromise = new Promise((resolve, reject) => {
        const request = indexedDBApi.open(dbName, version);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: "sha256" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || mediaError("MEDIA_INDEXEDDB_OPEN_FAILED"));
        request.onblocked = () => reject(mediaError("MEDIA_INDEXEDDB_OPEN_BLOCKED"));
      });
    }
    return openPromise;
  };
  return {
    async get(sha256) {
      const database = await open();
      const transaction = database.transaction(storeName, "readonly");
      const result = await indexedDbRequest(transaction.objectStore(storeName).get(sha256), transaction);
      return cloneRecord(result);
    },
    async put(record) {
      const database = await open();
      const transaction = database.transaction(storeName, "readwrite");
      await indexedDbRequest(transaction.objectStore(storeName).put(cloneRecord(record)), transaction);
    },
  };
}

function bytesToBase64(bytes) {
  if (typeof globalThis.btoa !== "function") throw mediaError("MEDIA_BASE64_UNAVAILABLE");
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 32_768)));
  }
  return globalThis.btoa(binary);
}

function bytesFromBase64(value) {
  if (typeof value !== "string" || value.length < 4 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    || typeof globalThis.atob !== "function") throw mediaError("MEDIA_BACKUP_BYTES_INVALID");
  let binary;
  try { binary = globalThis.atob(value); }
  catch { throw mediaError("MEDIA_BACKUP_BYTES_INVALID"); }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64(bytes) !== value) throw mediaError("MEDIA_BACKUP_BYTES_INVALID");
  return bytes;
}

function exactSameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function createMediaAssetStore({
  database = null,
  indexedDBApi = globalThis.indexedDB,
  dbName = MEDIA_DATABASE_NAME,
  storeName = MEDIA_DATABASE_STORE,
  cryptoApi = globalThis.crypto,
  urlApi = globalThis.URL,
  BlobCtor = globalThis.Blob,
} = {}) {
  const mediaDatabase = requireDatabase(database || createIndexedDbMediaDatabase({ indexedDBApi, dbName, storeName }));
  const releasedHydrations = new WeakSet();

  const readVerifiedMedia = async (refOrSha) => {
    const expectedSha256 = shaFromRefOrHash(refOrSha);
    const record = await validateStoredRecord(await mediaDatabase.get(expectedSha256), expectedSha256, { cryptoApi });
    return {
      ...manifestFromRecord(record),
      ref: mediaRefForSha256(record.sha256),
      mime_type: record.mime,
      bytes: new Uint8Array(record.bytes),
    };
  };

  const putVerifiedMedia = async ({ bytes: inputBytes, mime_type: claimedMimeType, mime: claimedMime, sha256: claimedSha256 } = {}) => {
    const bytes = bytesView(inputBytes);
    if (bytes.byteLength < 1) throw mediaError("MEDIA_BYTES_INVALID");
    const detectedMime = detectImageMime(bytes);
    const suppliedMime = claimedMimeType ?? claimedMime;
    if (suppliedMime != null && suppliedMime !== detectedMime) throw mediaError("MEDIA_MIME_MISMATCH");
    const sha256 = await sha256MediaBytes(bytes, { cryptoApi });
    if (claimedSha256 != null && canonicalSha256(claimedSha256) !== sha256) throw mediaError("MEDIA_HASH_MISMATCH");
    const existing = await mediaDatabase.get(sha256);
    if (existing != null) {
      const record = await validateStoredRecord(existing, sha256, { cryptoApi });
      if (!equalBytes(record.bytes, bytes)) throw mediaError("MEDIA_READBACK_BYTES_MISMATCH");
      return { ...manifestFromRecord(record), ref: mediaRefForSha256(sha256), mime_type: record.mime, deduplicated: true };
    }
    await mediaDatabase.put({ sha256, mime: detectedMime, size_bytes: bytes.byteLength, bytes: new Uint8Array(bytes) });
    const record = await validateStoredRecord(await mediaDatabase.get(sha256), sha256, { cryptoApi });
    if (!equalBytes(record.bytes, bytes)) throw mediaError("MEDIA_READBACK_BYTES_MISMATCH");
    return { ...manifestFromRecord(record), ref: mediaRefForSha256(sha256), mime_type: record.mime, deduplicated: false };
  };

  const hydrateMedia = async (refOrSha) => {
    if (!urlApi?.createObjectURL || !urlApi?.revokeObjectURL || typeof BlobCtor !== "function") throw mediaError("MEDIA_OBJECT_URL_UNAVAILABLE");
    const asset = await readVerifiedMedia(refOrSha);
    const hydrated = {
      schema: asset.schema,
      media_ref: asset.media_ref,
      sha256: asset.sha256,
      size_bytes: asset.size_bytes,
      mime: asset.mime,
      url: urlApi.createObjectURL(new BlobCtor([asset.bytes], { type: asset.mime })),
    };
    return hydrated;
  };

  const releaseHydratedMedia = (hydrated) => {
    if (!hydrated || typeof hydrated !== "object" || typeof hydrated.url !== "string" || !hydrated.url.startsWith("blob:")) {
      throw mediaError("MEDIA_HYDRATION_INVALID");
    }
    if (releasedHydrations.has(hydrated)) return false;
    urlApi.revokeObjectURL(hydrated.url);
    releasedHydrations.add(hydrated);
    return true;
  };

  const exportMediaAssets = async (refs) => {
    if (!Array.isArray(refs)) throw mediaError("MEDIA_BACKUP_REFS_INVALID");
    const hashes = [...new Set(refs.map((ref) => shaFromRefOrHash(ref)))].sort();
    const assets = [];
    for (const sha256 of hashes) {
      const asset = await readVerifiedMedia(sha256);
      assets.push({
        schema: MEDIA_ASSET_BACKUP_SCHEMA,
        media_ref: asset.media_ref,
        sha256: asset.sha256,
        size_bytes: asset.size_bytes,
        mime: asset.mime,
        bytes_base64: bytesToBase64(asset.bytes),
      });
    }
    return assets;
  };

  const importMediaAssets = async (assets, { expectedRefs = [] } = {}) => {
    if (!Array.isArray(assets) || !Array.isArray(expectedRefs)) throw mediaError("MEDIA_BACKUP_INVALID");
    const normalized = [];
    const seen = new Set();
    for (const value of assets) {
      if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== MEDIA_ASSET_BACKUP_SCHEMA) throw mediaError("MEDIA_BACKUP_SCHEMA_INVALID");
      const sha256 = canonicalSha256(value.sha256, "MEDIA_BACKUP_HASH_MISMATCH");
      if (parseMediaRef(value.media_ref) !== sha256) throw mediaError("MEDIA_BACKUP_HASH_MISMATCH");
      if (seen.has(sha256)) throw mediaError("MEDIA_BACKUP_SET_MISMATCH");
      seen.add(sha256);
      const bytes = bytesFromBase64(value.bytes_base64);
      if (!Number.isInteger(value.size_bytes) || value.size_bytes !== bytes.byteLength) throw mediaError("MEDIA_BACKUP_SIZE_MISMATCH");
      let mime;
      try { mime = detectImageMime(bytes); }
      catch { throw mediaError("MEDIA_BACKUP_MIME_MISMATCH"); }
      if (value.mime !== mime) throw mediaError("MEDIA_BACKUP_MIME_MISMATCH");
      const actualSha256 = await sha256MediaBytes(bytes, { cryptoApi });
      if (actualSha256 !== sha256) throw mediaError("MEDIA_BACKUP_HASH_MISMATCH");
      normalized.push({ sha256, media_ref: value.media_ref, mime, size_bytes: bytes.byteLength, bytes });
    }
    normalized.sort((left, right) => left.sha256.localeCompare(right.sha256));
    const actual = normalized.map((item) => item.sha256);
    const expected = [...new Set(expectedRefs.map((ref) => shaFromRefOrHash(ref)))].sort();
    if (!exactSameSet(actual, expected)) throw mediaError("MEDIA_BACKUP_SET_MISMATCH");

    const manifests = [];
    for (const item of normalized) {
      const saved = await putVerifiedMedia({ bytes: item.bytes, mime_type: item.mime, sha256: item.sha256 });
      manifests.push(manifestFromRecord(saved));
    }
    return manifests;
  };

  return {
    putVerifiedMedia,
    readVerifiedMedia,
    hydrateMedia,
    releaseHydratedMedia,
    exportMediaAssets,
    importMediaAssets,
  };
}

export async function putVerifiedMedia(store, input) {
  if (!store?.putVerifiedMedia) throw mediaError("MEDIA_STORE_INVALID");
  return store.putVerifiedMedia(input);
}

export async function readVerifiedMedia(store, refOrSha) {
  if (!store?.readVerifiedMedia) throw mediaError("MEDIA_STORE_INVALID");
  return store.readVerifiedMedia(refOrSha);
}

export async function exportMediaAssets(store, refs) {
  if (!store?.exportMediaAssets) throw mediaError("MEDIA_STORE_INVALID");
  return store.exportMediaAssets(refs);
}

export async function importMediaAssets(store, assets, options) {
  if (!store?.importMediaAssets) throw mediaError("MEDIA_STORE_INVALID");
  return store.importMediaAssets(assets, options);
}

export async function hydrateMedia(store, refOrSha) {
  if (!store?.hydrateMedia) throw mediaError("MEDIA_STORE_INVALID");
  return store.hydrateMedia(refOrSha);
}

export function releaseHydratedMedia(store, hydrated) {
  if (!store?.releaseHydratedMedia) throw mediaError("MEDIA_STORE_INVALID");
  return store.releaseHydratedMedia(hydrated);
}

function cloneAndAssertRefOnly(value, seen) {
  if (typeof value === "string") {
    if (/^(?:data|blob):/i.test(value)) throw mediaError("PERSISTENT_MEDIA_EMBEDDED_URL_FORBIDDEN");
    return value;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") throw mediaError("PERSISTENT_MEDIA_VALUE_INVALID");
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Blob !== "undefined" && value instanceof Blob)) {
    throw mediaError("PERSISTENT_MEDIA_BYTES_FORBIDDEN");
  }
  if (seen.has(value)) throw mediaError("PERSISTENT_MEDIA_VALUE_CYCLIC");
  seen.add(value);
  let cloned;
  if (Array.isArray(value)) cloned = value.map((item) => cloneAndAssertRefOnly(item, seen));
  else cloned = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndAssertRefOnly(item, seen)]));
  seen.delete(value);
  return cloned;
}

export function assertRefOnlyPersistentValue(value) {
  return cloneAndAssertRefOnly(value, new Set());
}

function requireStorageManager(storageManager) {
  if (!storageManager || typeof storageManager.persisted !== "function" || typeof storageManager.estimate !== "function") {
    throw mediaError("MEDIA_STORAGE_MANAGER_UNAVAILABLE");
  }
  return storageManager;
}

export async function readMediaStorageStatus({ storageManager = globalThis.navigator?.storage } = {}) {
  const manager = requireStorageManager(storageManager);
  const [persisted, estimate] = await Promise.all([manager.persisted(), manager.estimate()]);
  return {
    persisted: Boolean(persisted),
    usage: Number.isFinite(estimate?.usage) ? estimate.usage : null,
    quota: Number.isFinite(estimate?.quota) ? estimate.quota : null,
  };
}

export async function requestPersistentMediaStorage({ storageManager = globalThis.navigator?.storage, userGesture = false } = {}) {
  if (userGesture !== true) throw mediaError("MEDIA_PERSIST_REQUIRES_USER_GESTURE");
  const manager = requireStorageManager(storageManager);
  if (typeof manager.persist !== "function") throw mediaError("MEDIA_PERSIST_UNAVAILABLE");
  const granted = Boolean(await manager.persist());
  const status = await readMediaStorageStatus({ storageManager: manager });
  return { requested: true, granted, ...status };
}
