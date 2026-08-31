import assert from "node:assert/strict";
import test from "node:test";
import { publicationSnapshotDecision, runGuardedPublicationAction } from "../src/publication-action-guard.mjs";

test("blocked publication does not call the copy or export side effect", async () => {
  let calls = 0;
  const result = await runGuardedPublicationAction({
    gate: { allowed: false, code: "CONTENT_LINEAGE_MISMATCH", token: "wrong" },
    action: async () => { calls += 1; },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "CONTENT_LINEAGE_MISMATCH");
  assert.equal(calls, 0);
});

test("current publication authority calls the side effect exactly once", async () => {
  let calls = 0;
  const result = await runGuardedPublicationAction({
    gate: { allowed: true, code: "CONFIRMED_TEXT_AUTHORITY", token: "same" },
    action: async () => { calls += 1; return "copied"; },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.value, "copied");
  assert.equal(calls, 1);
});

test("an export snapshot becomes invalid when lineage changes during rendering", () => {
  const content = { selectedTitle: "稿 A" };
  const decision = publicationSnapshotDecision({
    gate: { allowed: true, token: "draft-b" },
    expectedToken: "draft-a",
    currentContent: content,
    expectedContent: content,
  });
  assert.deepEqual(decision, { allowed: false, code: "PUBLICATION_AUTHORITY_CHANGED" });
});

test("a prepared download becomes invalid when the content object changes", () => {
  const decision = publicationSnapshotDecision({
    gate: { allowed: true, token: "draft-a" },
    expectedToken: "draft-a",
    currentContent: { selectedTitle: "edited" },
    expectedContent: { selectedTitle: "original" },
  });
  assert.deepEqual(decision, { allowed: false, code: "PUBLICATION_CONTENT_CHANGED" });
});
