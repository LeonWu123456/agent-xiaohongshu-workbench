import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const packageUrl = new URL("../package.json", import.meta.url);
const stackUrl = new URL("../server/run-stack.mjs", import.meta.url);
const providerUrl = new URL("../scripts/ark-provider-server.mjs", import.meta.url);

test("the default production command starts both web and generation services", async () => {
  const pkg = JSON.parse(await readFile(packageUrl, "utf8"));
  const stack = await readFile(stackUrl, "utf8");

  assert.equal(pkg.scripts.start, "node server/run-stack.mjs");
  assert.match(pkg.scripts["start:web"], /PORT=4184/);
  assert.match(stack, /PORT: process\.env\.PORT \|\| "4184"/);
  assert.match(stack, /ARK_PROVIDER_PORT: process\.env\.ARK_PROVIDER_PORT \|\| "4175"/);
  assert.match(stack, /scripts", "ark-provider-server\.mjs"/);
  assert.match(stack, /server", "index\.mjs"/);
});

test("loopback image assets expose their integrity headers to the browser", async () => {
  const provider = await readFile(providerUrl, "utf8");
  assert.match(provider, /"x-content-sha256": asset\.manifest\.sha256/);
  assert.match(provider, /"access-control-expose-headers": "content-type, content-length, x-content-sha256, x-content-type-options, cache-control"/);
});
