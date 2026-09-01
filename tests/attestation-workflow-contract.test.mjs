import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/xiaoshimei-ledger-attestation.yml", import.meta.url);

test("D36 attestation workflow is a bounded default-branch schedule plus explicit manual dispatch", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /^on:\n  schedule:\n    - cron: "37 \*\/6 \* \* \*"\n  workflow_dispatch:/m);
  assert.doesNotMatch(source, /^\s{2}(push|pull_request):/m);
  assert.match(source, /permissions:\n  contents: read/);
  assert.match(source, /concurrency:\n  group: xiaoshimei-ledger-attestation\n  cancel-in-progress: false/);
  assert.match(source, /timeout-minutes: 10/);
  assert.match(source, /node-version: 24/);
  assert.match(source, /vercel_environment:[\s\S]*candidate_commit:[\s\S]*app_scope:/);
});

test("D36 scheduled production uses explicit repository variables and never github.sha", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /github\.event_name == 'schedule' && 'production'/);
  assert.match(source, /vars\.XIAOSHIMEI_PRODUCTION_COMMIT \|\| inputs\.candidate_commit/);
  assert.match(source, /vars\.XIAOSHIMEI_PRODUCTION_APP_SCOPE \|\| inputs\.app_scope/);
  assert.match(source, /XIAOSHIMEI_ATTESTATION_ONLY_IF_DUE: \$\{\{ github\.event_name == 'schedule' && 'true' \|\| 'false' \}\}/);
  assert.match(source, /XIAOSHIMEI_ATTESTATION_RENEW_LEAD_MS: "86400000"/);
  assert.doesNotMatch(source, /github\.sha/i);
});

test("D36 attestation workflow references the exact secret set without secret literals or exfiltration steps", async () => {
  const source = await readFile(workflowPath, "utf8");
  const secretNames = [...source.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(secretNames, [
    "UPSTASH_DATABASE_ID",
    "UPSTASH_DEVELOPER_API_KEY",
    "UPSTASH_DEVELOPER_EMAIL",
    "UPSTASH_REDIS_REST_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "XIAOSHIMEI_LEDGER_ATTESTATION_PRIVATE_KEY",
  ]);
  assert.doesNotMatch(source, /upload-artifact|echo\s+\$|printenv|set\s+-x/i);
  assert.equal((source.match(/node scripts\/attest-upstash-image-ledger\.mjs/g) || []).length, 1);
});
