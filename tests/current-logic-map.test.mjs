import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT_PREFIX = "Products/Xiaoshimei-Studio-v2/";

test("Current logic map is runtime-bound, has one real App entry, and no planned implementation refs", async () => {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "logic/logic-model.json"), "utf8"));
  assert.equal(model.version, "2.0.0");
  assert.equal(model.model_kind, "CURRENT_RUNTIME_BOUND");
  assert.equal(model.entrypoint, "src/main.jsx");
  await fs.access(path.join(ROOT, model.entrypoint));
  await assert.rejects(fs.access(path.join(ROOT, "src/App.jsx")));
  for (const node of model.nodes) {
    for (const ref of node.source_refs || []) {
      assert.equal(ref.planned, undefined, `${node.id} must not carry planned refs in Current Map`);
      const relative = ref.path.startsWith(PRODUCT_PREFIX) ? ref.path.slice(PRODUCT_PREFIX.length) : ref.path;
      await fs.access(path.join(ROOT, relative));
    }
  }
});

test("Current logic map has no open historical defect and binds the Reality advisory boundary", async () => {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "logic/logic-model.json"), "utf8"));
  assert.equal(model.problems.some((problem) => problem.state !== "RESOLVED"), false);
  const reality = model.nodes.find((node) => node.id === "FLOW-REALITY");
  assert.match(reality.spec.rule, /advisory context/);
  assert.match(reality.spec.rule, /不能绕过/);
  const rule = model.nodes.find((node) => node.id === "RULE-REALITY");
  assert.match(rule.spec.rule, /advisory evidence/);
  assert.match(rule.spec.rule, /layout QA/);
});
