import assert from "node:assert/strict";
import test from "node:test";
import { resolveDownloadTarget } from "../src/download-transport.mjs";

const blob = new Blob(["zip-bytes"], { type: "application/zip" });

test("public download uses a browser attachment without calling the local-only endpoint", async () => {
  let fetchCalls = 0;
  const target = await resolveDownloadTarget({
    name: "小师妹-发布包.zip",
    blob,
    isPublicRuntime: true,
    fetchImpl: async () => { fetchCalls += 1; throw new Error("must not run"); },
    urlApi: { createObjectURL: () => "blob:public-download" },
  });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(target, {
    url: "blob:public-download",
    revoke: true,
    transport: "blob_attachment",
    savedPath: null,
  });
});

test("local download keeps atomic server export and falls back to browser attachment", async () => {
  const serverTarget = await resolveDownloadTarget({
    name: "小师妹-发布包.zip",
    blob,
    isPublicRuntime: false,
    fetchImpl: async () => ({ ok: true, json: async () => ({ download_url: "/downloads/package.zip", saved_path: "/tmp/package.zip" }) }),
    urlApi: { createObjectURL: () => "blob:unused" },
  });
  assert.equal(serverTarget.transport, "http_attachment");
  assert.equal(serverTarget.savedPath, "/tmp/package.zip");

  const fallback = await resolveDownloadTarget({
    name: "小师妹-发布包.zip",
    blob,
    isPublicRuntime: false,
    fetchImpl: async () => { throw new Error("offline"); },
    urlApi: { createObjectURL: () => "blob:local-fallback" },
  });
  assert.equal(fallback.transport, "blob_attachment");
  assert.equal(fallback.url, "blob:local-fallback");
});
