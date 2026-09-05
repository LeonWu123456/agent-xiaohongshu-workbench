import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT_PREFIX = "Products/Xiaoshimei-Studio-v2/";
const REQUIRED_TYPES = new Set(["CAP", "PAGE", "UI", "ACT", "FLOW", "API", "STORE", "RULE", "TEST"]);
const RELATION_TYPES = new Set(["contains", "exposes", "triggers", "routes_to", "reads", "writes", "depends_on", "constrained_by", "constrains", "verified_by", "covers", "feedback_to_node", "consumer_readback"]);

async function readHumanMap() {
  return fs.readFile(path.join(ROOT, "XIAOSHIMEI_WORKBENCH_FULL_LOGIC_MAP.md"), "utf8");
}

test("Current logic map is runtime-bound, has one real App entry, and no planned implementation refs", async () => {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "logic/logic-model.json"), "utf8"));
  assert.equal(model.version, "3.1.0");
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

test("Current logic map is a Guo-style nine-question graph, not an architecture picture", async () => {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "logic/logic-model.json"), "utf8"));
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  assert.deepEqual(new Set(model.nodes.map((node) => node.type)), REQUIRED_TYPES);
  assert.ok(Array.isArray(model.relations) && model.relations.length > 0);
  const degree = new Map(model.nodes.map((node) => [node.id, 0]));
  for (const relation of model.relations) {
    assert.equal(nodes.has(relation.from), true, `unknown relation source ${relation.from}`);
    assert.equal(nodes.has(relation.to), true, `unknown relation target ${relation.to}`);
    assert.equal(RELATION_TYPES.has(relation.type), true, `unsupported relation type ${relation.type}`);
    degree.set(relation.from, degree.get(relation.from) + 1);
    degree.set(relation.to, degree.get(relation.to) + 1);
  }
  assert.deepEqual([...degree].filter(([, count]) => count === 0), [], "logic-map nodes cannot be orphan labels");

  assert.ok(Array.isArray(model.critical_journeys) && model.critical_journeys.length > 0);
  for (const journey of model.critical_journeys) {
    for (const type of REQUIRED_TYPES) {
      const field = type.toLowerCase();
      assert.equal(nodes.get(journey[field])?.type, type, `${journey.id} must answer ${type}`);
    }
  }
  assert.ok(model.feedback_loop?.ingress_node);
  assert.ok(model.feedback_loop?.fix_flow_node);
  assert.ok(Array.isArray(model.feedback_loop?.regression_test_nodes));

  for (const node of model.nodes) {
    const specRef = (node.source_refs || []).find((ref) => ref.kind === "spec");
    assert.ok(specRef, `${node.id} needs its own spec document`);
    const relative = specRef.path.startsWith(PRODUCT_PREFIX) ? specRef.path.slice(PRODUCT_PREFIX.length) : specRef.path;
    const document = await fs.readFile(path.join(ROOT, relative), "utf8");
    assert.match(document, new RegExp(`^# ${node.id}\\b`, "m"));
    assert.match(document, /回答[：:]/, `${node.id} must state which product question it answers`);
    assert.match(document, /实现[：:]/, `${node.id} must bind implementation`);
    assert.match(document, /验证[：:]/, `${node.id} must bind regression or Reality proof`);
  }
});

test("Current logic map binds the Reality advisory boundary without treating problem labels as runtime proof", async () => {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "logic/logic-model.json"), "utf8"));
  assert.ok(Array.isArray(model.problems) && model.problems.length > 0);
  assert.ok(model.problems.every((problem) => typeof problem.state === "string" && problem.state.length > 0));
  const reality = model.nodes.find((node) => node.id === "FLOW-005");
  assert.match(reality.spec.purpose, /advisory context/);
  assert.match(reality.spec.purpose, /不能绕过/);
  const rule = model.nodes.find((node) => node.id === "RULE-003");
  assert.match(rule.spec.purpose, /advisory evidence/);
  assert.match(rule.spec.purpose, /layout QA/);
});

test("the human Mermaid and machine map expose the same stable node IDs", async () => {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "logic/logic-model.json"), "utf8"));
  const markdown = await readHumanMap();
  const humanIds = [...markdown.matchAll(/\["((?:CAP|PAGE|UI|ACT|FLOW|API|STORE|RULE|TEST)-\d+)\b/g)].map((match) => match[1]);
  assert.deepEqual(new Set(humanIds), new Set(model.nodes.map((node) => node.id)));
  assert.equal(humanIds.length, new Set(humanIds).size, "a stable node ID may appear only once in the canonical Mermaid");
});

test("stable node IDs keep the same meaning in the human and machine projections", async () => {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "logic/logic-model.json"), "utf8"));
  const markdown = await readHumanMap();
  const humanLabels = new Map([...markdown.matchAll(/\["((?:CAP|PAGE|UI|ACT|FLOW|API|STORE|RULE|TEST)-\d+)<br\/>((?:.(?!"\]))+.)"\]/g)]
    .map((match) => [match[1], match[2].split("<br/>")[0]]));
  for (const node of model.nodes) {
    assert.equal(humanLabels.get(node.id), node.label, `${node.id} changed meaning between projections`);
  }
});

test("legacy views redirect to the canonical map instead of publishing conflicting states", async () => {
  for (const relative of ["logic/task.md", "logic/impact.md", "logic/reality.md"]) {
    const document = await fs.readFile(path.join(ROOT, relative), "utf8");
    assert.match(document, /XIAOSHIMEI_WORKBENCH_FULL_LOGIC_MAP\.md/);
    assert.doesNotMatch(document, /```mermaid|RESOLVED_CONFIRMED|OPEN_CONFIRMED|PASS_LOCAL/);
  }
  const realityRedirect = JSON.parse(await fs.readFile(path.join(ROOT, "logic/reality-status.json"), "utf8"));
  assert.equal(realityRedirect.status, "SEE_CANONICAL_MAP");
  assert.equal(realityRedirect.canonical, "../XIAOSHIMEI_WORKBENCH_FULL_LOGIC_MAP.md");
});

test("the screenshot-reopened problem stays open until target Reality proves the fixed UI", async () => {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "logic/logic-model.json"), "utf8"));
  const problem = model.problems.find((item) => item.id === "D38");
  assert.ok(problem);
  assert.notEqual(problem.state, "RESOLVED");
  assert.deepEqual(new Set(problem.target_nodes), new Set(["UI-010", "UI-011", "ACT-010", "ACT-011", "FLOW-006", "RULE-001", "TEST-001"]));
});

test("paid-image rules constrain image actions, never the raw source input", async () => {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "logic/logic-model.json"), "utf8"));
  const constrained = model.relations
    .filter((relation) => relation.from === "RULE-001" && relation.type === "constrains")
    .map((relation) => relation.to);
  assert.deepEqual(new Set(constrained), new Set(["UI-003", "UI-010", "UI-011"]));
});
