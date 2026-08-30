export async function resolveDownloadTarget({
  name,
  blob,
  isPublicRuntime,
  fetchImpl = globalThis.fetch,
  urlApi = globalThis.URL,
}) {
  if (!name || !blob) throw new TypeError("DOWNLOAD_INPUT_INVALID");

  if (!isPublicRuntime) {
    try {
      const response = await fetchImpl("/api/local-export", {
        method: "POST",
        headers: { "content-type": blob.type || "application/octet-stream", "x-export-filename": encodeURIComponent(name) },
        body: blob,
      });
      const result = await response.json();
      if (!response.ok || !result.download_url) throw new Error(result.error || `HTTP ${response.status}`);
      return {
        url: result.download_url,
        revoke: false,
        transport: "http_attachment",
        savedPath: result.saved_path || null,
      };
    } catch {
      // The local helper is optional. Browser attachment remains the recovery
      // path when the desktop/local server is not available.
    }
  }

  return {
    url: urlApi.createObjectURL(blob),
    revoke: true,
    transport: "blob_attachment",
    savedPath: null,
  };
}
