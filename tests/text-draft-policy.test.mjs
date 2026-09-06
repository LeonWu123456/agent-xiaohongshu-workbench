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


test('full-source length remains faithful rather than requiring expansion beyond the supplied source',()=>{
 for(const sourceLength of [80,131,179,180,187,500]){
  const bounds=textDraftLengthBounds('原'.repeat(sourceLength)),minimum=Math.min(180,sourceLength);
  assert.equal(bounds.minimum,minimum);assert.equal(bounds.maximum,Math.min(600,Math.max(220,Math.ceil(sourceLength*1.3))));
  assert.equal(textDraftConfirmationIssue(draft({sourceLength,bodyLength:minimum})),null);
  assert.equal(textDraftConfirmationIssue(draft({sourceLength,bodyLength:minimum-1})).code,'BODY_TOO_SHORT');
 }
 assert.equal(textDraftLengthBounds('原'.repeat(79)).minimum,240);
 assert.equal(textDraftLengthBounds('原'.repeat(79)).fullSource,false);
});

test('typed response and saved authoring session agree with full-source confirmation floor',async()=>{
 const {parseTextDraftResponse}=await import('../src/provider-contract.mjs');
 const {normalizeAuthoringSession}=await import('../src/workspace-state.mjs');
 function response(sourceLength,bodyLength){const d=draft({sourceLength,bodyLength});return {schema:'xiaoshimei.text-draft-response.v1',draft_id:'source-contract-proof',source_input:d.source_input,pillar:'identity',goal:'save',text_requirements:'只润色原文',titles:[d.selected_title,'生活的小事慢慢完成','留下一点自在的空间'],selected_title:d.selected_title,body:d.body,tags:d.tags,recommended_image_count:3};}
 for(const sourceLength of [80,131,179,180,500]){
  const n=Math.min(180,sourceLength),raw=response(sourceLength,n),before=structuredClone(raw);
  assert.equal(parseTextDraftResponse(raw).body,raw.body);assert.equal(textDraftConfirmationIssue(raw),null);
  assert.equal(normalizeAuthoringSession({schema:'xiaoshimei.authoring-session.v2',text_draft:raw,text_confirmed:true}).text_draft.body,raw.body);
  assert.deepEqual(raw,before);assert.throws(()=>parseTextDraftResponse(response(sourceLength,n-1)),/TEXT_DRAFT_BODY_INVALID/);
 }
 assert.throws(()=>parseTextDraftResponse(response(20,179)),/TEXT_DRAFT_BODY_INVALID/);assert.equal(parseTextDraftResponse(response(20,180)).body.length,180,'legacy topic transport minimum is unchanged');
});
