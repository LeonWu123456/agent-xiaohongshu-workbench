import assert from "node:assert/strict";
import test from "node:test";
import { generateContentPackage } from "../src/content-engine.mjs";
import { buildHistoricalDraftAdoption, derivePublicationAuthority } from "../src/publication-authority.mjs";
import { createDraftRecord } from "../src/workspace-state.mjs";

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

test("an exact current canvas remains publishable while a separate image recovery is pending", () => {
  const pair = confirmedPair();
  const draftId = pair.textDraft.draft_id;
  const activeDraftId = "draft-record-1";
  const result = derivePublicationAuthority({
    ...pair,
    assembledDraftId: "stale-assembled-draft",
    activeDraftId,
    pendingImageOperation: {
      operation_nonce: "a".repeat(64),
      run_id: "images-pending-six-pages",
      protocol_state: "UNKNOWN",
      operation_snapshot: {
        draft_record_id: activeDraftId,
        confirmed_draft: { draft_id: draftId },
      },
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.code, "CONFIRMED_TEXT_AUTHORITY_WITH_PENDING_RECOVERY");
  assert.equal(result.recovery_pending, true);
  assert.equal(result.resolved_assembled_draft_id, draftId);
  assert.equal(derivePublicationAuthority({
    ...pair,
    content: { ...pair.content, visible_pages: 0 },
    assembledDraftId: "stale-assembled-draft",
    activeDraftId,
    pendingImageOperation: {
      operation_nonce: "a".repeat(64),
      run_id: "images-pending-six-pages",
      protocol_state: "PARTIAL",
      operation_snapshot: { draft_record_id: activeDraftId, confirmed_draft: { draft_id: draftId } },
    },
  }).allowed, true, "the real pages array, not a stale display count, proves that a visible canvas exists");
});

test("pending recovery never bypasses exact draft, copy, or visible-canvas gates", () => {
  const pair = confirmedPair();
  const draftId = pair.textDraft.draft_id;
  const activeDraftId = "draft-record-2";
  const pending = {
    operation_nonce: "b".repeat(64),
    run_id: "images-pending",
    protocol_state: "UNKNOWN",
    operation_snapshot: { draft_record_id: activeDraftId, confirmed_draft: { draft_id: draftId } },
  };
  const base = { ...pair, assembledDraftId: null, activeDraftId, pendingImageOperation: pending };
  assert.equal(derivePublicationAuthority({ ...base, activeDraftId: "another-draft" }).code, "TEXT_NOT_ASSEMBLED");
  assert.equal(derivePublicationAuthority({ ...base, pendingImageOperation: { ...pending, operation_snapshot: { ...pending.operation_snapshot, draft_record_id: "another-draft" } } }).code, "TEXT_NOT_ASSEMBLED");
  assert.equal(derivePublicationAuthority({ ...base, pendingImageOperation: { ...pending, operation_snapshot: { ...pending.operation_snapshot, confirmed_draft: { draft_id: "another-text" } } } }).code, "TEXT_NOT_ASSEMBLED");
  assert.equal(derivePublicationAuthority({ ...base, content: { ...pair.content, pages: [] } }).code, "TEXT_NOT_ASSEMBLED");
  assert.equal(derivePublicationAuthority({ ...base, content: { ...pair.content, body: "另一份正文" } }).code, "PUBLICATION_COPY_MISMATCH");
});

test("a content-only boolean never grants publication authority", () => {
  const content = generateContentPackage({ topic: "旧稿" });
  const result = derivePublicationAuthority({ content, activatedAsContentOnly: true });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "HISTORICAL_CONFIRMATION_REQUIRED");
});

test("an unbound missing session cannot silently publish", () => {
  const content = generateContentPackage({ topic: "来源不明" });
  const result = derivePublicationAuthority({ content });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "GENERATION_SESSION_MISSING");
});

test("an exact copy without the third lineage id remains locked", () => {
  const pair = confirmedPair();
  delete pair.content.generation.source_draft_id;
  const result = derivePublicationAuthority(pair);
  assert.equal(result.allowed, false);
  assert.equal(result.code, "CONTENT_LINEAGE_MISSING");
});

test("zero-paid historical adoption preserves pages and images while entering the standard exact gate", () => {
  const content = generateContentPackage({ topic: "旧稿也要明确确认后才能发布", pillar: "culture", goal: "save" });
  content.body = "这是一份已经存在的历史成稿，用户现在明确确认它的标题、正文和标签就是要发布的唯一文案。确认动作只建立来源身份，不重新生成页面，不修改图片，不调用任何付费服务。为了满足发布文案的完整性，这段正文保留足够的信息，也明确说明历史稿需要人工确认后才能进入标准发布流程。".repeat(2);
  const pagesBefore = JSON.stringify(content.pages);
  const imageSourcesBefore = content.pages.map((page) => page.image_style.src);

  const adopted = buildHistoricalDraftAdoption({
    content,
    draftId: "historical-record-1",
    createdAt: "2026-08-31T15:00:00.000Z",
  });

  assert.equal(adopted.paid_image_calls, 0);
  assert.equal(adopted.publication_authority.allowed, true);
  assert.equal(adopted.publication_authority.code, "CONFIRMED_TEXT_AUTHORITY");
  assert.equal(adopted.text_draft.draft_id, "historical-record-1");
  assert.equal(adopted.content_package.generation.source_draft_id, "historical-record-1");
  assert.equal(adopted.generation_session.assembled_draft_id, "historical-record-1");
  assert.equal(adopted.generation_session.text_confirmed, true);
  assert.equal(adopted.generation_session.image_resume, null);
  assert.equal(JSON.stringify(adopted.content_package.pages), pagesBefore);
  assert.deepEqual(adopted.content_package.pages.map((page) => page.image_style.src), imageSourcesBefore);
  assert.equal(adopted.content_package.body, content.body);
  assert.deepEqual(adopted.content_package.tags, content.tags);
  const record = createDraftRecord({
    draftId: "historical-record-1",
    contentPackage: adopted.content_package,
    generationSession: adopted.generation_session,
    createdAt: "2026-08-31T15:00:00.000Z",
  });
  assert.equal(record.generation_session.text_draft.draft_id, "historical-record-1");
});

test("historical adoption rejects invalid copy without mutating the original content", () => {
  const content = generateContentPackage({ topic: "不完整旧稿" });
  content.body = "太短";
  const before = structuredClone(content);
  assert.throws(() => buildHistoricalDraftAdoption({ content, draftId: "historical-invalid" }), /TEXT_DRAFT_BODY_INVALID/);
  assert.deepEqual(content, before);
});
