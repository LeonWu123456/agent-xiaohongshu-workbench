import assert from "node:assert/strict";
import test from "node:test";
import { generateContentPackage } from "../src/content-engine.mjs";
import { derivePublicationAuthority } from "../src/publication-authority.mjs";

function confirmedPair() {
  const content = generateContentPackage({ topic: "同一稿" });
  const textDraft = {
    draft_id: "text-1",
    source_input: content.source_input,
    pillar: content.pillar,
    goal: content.goal,
    selected_title: content.selectedTitle,
    body: content.body,
    tags: [...content.tags],
  };
  content.generation.source_draft_id = textDraft.draft_id;
  return { content, textDraft, textConfirmed: true, assembledDraftId: textDraft.draft_id };
}

test("confirmed text is the only publication authority for a generated draft", () => {
  const result = derivePublicationAuthority(confirmedPair());
  assert.equal(result.allowed, true);
  assert.equal(result.mode, "TEXT_DRAFT_PROJECTION");
});

test("a different text draft cannot publish an older content package", () => {
  const pair = confirmedPair();
  pair.textDraft = { ...pair.textDraft, draft_id: "text-2" };
  pair.assembledDraftId = "text-2";
  const result = derivePublicationAuthority(pair);
  assert.equal(result.allowed, false);
  assert.equal(result.code, "CONTENT_LINEAGE_MISMATCH");
});

test("copy drift blocks publication even when lineage ids match", () => {
  const pair = confirmedPair();
  pair.content.body = "另一份正文";
  const result = derivePublicationAuthority(pair);
  assert.equal(result.allowed, false);
  assert.equal(result.code, "PUBLICATION_COPY_MISMATCH");
});

test("unconfirmed or unassembled text cannot publish", () => {
  const pair = confirmedPair();
  assert.equal(derivePublicationAuthority({ ...pair, textConfirmed: false }).code, "TEXT_NOT_CONFIRMED");
  assert.equal(derivePublicationAuthority({ ...pair, assembledDraftId: null }).code, "TEXT_NOT_ASSEMBLED");
});

test("legacy content without a parallel text session remains editable and publishable", () => {
  const content = generateContentPackage({ topic: "旧稿" });
  const result = derivePublicationAuthority({ content, activatedAsContentOnly: true });
  assert.equal(result.allowed, true);
  assert.equal(result.mode, "CONTENT_ONLY");
});

test("an unbound missing session cannot silently publish", () => {
  const content = generateContentPackage({ topic: "来源不明" });
  const result = derivePublicationAuthority({ content });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "GENERATION_SESSION_MISSING");
});

test("an exact legacy session remains compatible until the next save backfills lineage", () => {
  const pair = confirmedPair();
  delete pair.content.generation.source_draft_id;
  const result = derivePublicationAuthority(pair);
  assert.equal(result.allowed, true);
  assert.equal(result.code, "LEGACY_EXACT_MATCH");
});
