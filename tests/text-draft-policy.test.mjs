import assert from "node:assert/strict";
import test from "node:test";
import { textDraftConfirmationIssue, textDraftLengthBounds } from "../src/text-draft-policy.mjs";

function draft({ sourceLength = 187, bodyLength = 207 } = {}) {
  return {
    source_input: "原".repeat(sourceLength),
    selected_title: "初秋雨天整理一方小书桌",
    body: "文".repeat(bodyLength),
    tags: ["书桌整理", "雨天周末", "轻量书桌", "东方生活", "小师妹"],
  };
}

test("a valid full-source rewrite is confirmable below the short-topic 240 character target", () => {
  assert.deepEqual(textDraftLengthBounds("原".repeat(187)), {
    minimum: 180,
    maximum: 244,
    sourceLength: 187,
    fullSource: true,
  });
  assert.equal(textDraftConfirmationIssue(draft()), null);
});

test("a short topic still needs enough copy before confirmation", () => {
  const issue = textDraftConfirmationIssue(draft({ sourceLength: 20, bodyLength: 207 }));
  assert.equal(issue.code, "BODY_TOO_SHORT");
  assert.equal(issue.title, "正文信息还不够");
  assert.match(issue.detail, /240/);
  assert.doesNotMatch(issue.title, /被改/);
});
