import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const serverUrl = new URL("../server/index.mjs", import.meta.url);

test("4184 serves canonical Studio generated assets before v2 fallback assets", async () => {
  const source = await readFile(serverUrl, "utf8");
  assert.match(source, /canonicalGeneratedDir/);
  const canonicalMount = source.indexOf('app.use("/generated", express.static(canonicalGeneratedDir');
  const fallbackMount = source.indexOf('app.use("/generated", express.static(generatedDir');
  assert.ok(canonicalMount >= 0);
  assert.ok(fallbackMount > canonicalMount);
  assert.match(source, /fallthrough: true/);
});
