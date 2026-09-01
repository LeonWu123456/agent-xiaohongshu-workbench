import { parseContentPackage } from "./content-engine.mjs";
import { parseTextDraftResponse, TEXT_DRAFT_RESPONSE_SCHEMA } from "./provider-contract.mjs";

function sameTags(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function authorityToken(content, textDraft, textConfirmed, assembledDraftId, activeDraftId, pendingImageOperation) {
  return JSON.stringify([
    content?.id || null,
    content?.selectedTitle || "",
    content?.body || "",
    content?.tags || [],
    content?.source_input || "",
    content?.pillar || "",
    content?.goal || "",
    content?.generation?.source_draft_id || null,
    textDraft?.draft_id || null,
    textDraft?.selected_title || "",
    textDraft?.body || "",
    textDraft?.tags || [],
    textDraft?.source_input || "",
    textDraft?.pillar || "",
    textDraft?.goal || "",
    Boolean(textConfirmed),
    assembledDraftId || null,
    activeDraftId || null,
    pendingImageOperation?.operation_nonce || null,
    pendingImageOperation?.run_id || null,
    pendingImageOperation?.protocol_state || null,
    content?.visible_pages || 0,
  ]);
}

export function derivePublicationAuthority({
  content,
  textDraft = null,
  textConfirmed = false,
  assembledDraftId = null,
  activatedAsContentOnly = false,
  activeDraftId = null,
  pendingImageOperation = null,
}) {
  const token = authorityToken(content, textDraft, textConfirmed, assembledDraftId, activeDraftId, pendingImageOperation);
  if (!content || typeof content !== "object") return { allowed: false, code: "CONTENT_MISSING", token };

  if (!textDraft) {
    return {
      allowed: false,
      code: activatedAsContentOnly ? "HISTORICAL_CONFIRMATION_REQUIRED" : "GENERATION_SESSION_MISSING",
      token,
    };
  }

  const draftId = String(textDraft.draft_id || "");
  if (!textConfirmed) return { allowed: false, code: "TEXT_NOT_CONFIRMED", token };
  const sourceDraftId = content.generation?.source_draft_id;
  if (!sourceDraftId) return { allowed: false, code: "CONTENT_LINEAGE_MISSING", token };
  if (sourceDraftId !== draftId) return { allowed: false, code: "CONTENT_LINEAGE_MISMATCH", token };
  if (
    content.selectedTitle !== textDraft.selected_title
    || content.body !== textDraft.body
    || !sameTags(content.tags, textDraft.tags)
    || content.source_input !== textDraft.source_input
    || content.pillar !== textDraft.pillar
    || content.goal !== textDraft.goal
  ) return { allowed: false, code: "PUBLICATION_COPY_MISMATCH", token };

  if (!draftId) return { allowed: false, code: "TEXT_NOT_ASSEMBLED", token };
  const pendingSnapshot = pendingImageOperation?.operation_snapshot;
  const currentCanvasSurvivesPendingRecovery = typeof activeDraftId === "string"
    && Boolean(activeDraftId)
    && pendingSnapshot?.draft_record_id === activeDraftId
    && pendingSnapshot?.confirmed_draft?.draft_id === draftId
    && /^[0-9a-f]{64}$/.test(pendingImageOperation?.operation_nonce || "")
    && Number.isInteger(content.visible_pages)
    && content.visible_pages > 0
    && Array.isArray(content.pages)
    && content.pages.length >= content.visible_pages;
  if (assembledDraftId !== draftId && !currentCanvasSurvivesPendingRecovery) {
    return { allowed: false, code: "TEXT_NOT_ASSEMBLED", token };
  }

  return {
    allowed: true,
    code: currentCanvasSurvivesPendingRecovery ? "CONFIRMED_TEXT_AUTHORITY_WITH_PENDING_RECOVERY" : "CONFIRMED_TEXT_AUTHORITY",
    mode: "TEXT_DRAFT_PROJECTION",
    recovery_pending: currentCanvasSurvivesPendingRecovery,
    resolved_assembled_draft_id: draftId,
    token,
  };
}

function nonEmptyString(value, code) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(code);
  return value.trim();
}

// Explicit, zero-paid adoption converts a content-only historical record into
// the same exact lineage used by newly confirmed text. It does not regenerate
// copy, pages or images.
export function buildHistoricalDraftAdoption({
  content,
  draftId,
  createdAt = new Date().toISOString(),
  textRequirements = "",
} = {}) {
  const lineageId = nonEmptyString(draftId, "HISTORICAL_ADOPTION_DRAFT_ID_INVALID");
  const timestamp = nonEmptyString(createdAt, "HISTORICAL_ADOPTION_CREATED_AT_INVALID");
  const parsedContent = parseContentPackage(JSON.stringify(content));
  const beforePages = JSON.stringify(parsedContent.pages);
  const beforeFacts = JSON.stringify(parsedContent.facts);
  const beforeRisks = JSON.stringify(parsedContent.risks);
  const textDraft = parseTextDraftResponse({
    schema: TEXT_DRAFT_RESPONSE_SCHEMA,
    draft_id: lineageId,
    created_at: timestamp,
    source_input: parsedContent.source_input,
    text_requirements: typeof textRequirements === "string" ? textRequirements : "",
    prompt_context: {},
    pillar: parsedContent.pillar,
    goal: parsedContent.goal,
    titles: [...parsedContent.titles],
    selected_title: parsedContent.selectedTitle,
    body: parsedContent.body,
    tags: [...parsedContent.tags],
    recommended_image_count: parsedContent.visible_pages,
    facts: structuredClone(parsedContent.facts),
    risks: structuredClone(parsedContent.risks),
    generation: { adoption: "historical_content_only_v1", paid_image_calls: 0 },
  });
  const adoptedContent = parseContentPackage(JSON.stringify({
    ...parsedContent,
    generation: { ...parsedContent.generation, source_draft_id: lineageId },
  }));
  if (
    JSON.stringify(adoptedContent.pages) !== beforePages
    || JSON.stringify(adoptedContent.facts) !== beforeFacts
    || JSON.stringify(adoptedContent.risks) !== beforeRisks
  ) throw new TypeError("HISTORICAL_ADOPTION_ASSET_DRIFT");
  const generationSession = {
    schema: "xiaoshimei.authoring-session.v2",
    topic: textDraft.source_input,
    pillar: textDraft.pillar,
    goal: textDraft.goal,
    text_requirements: textDraft.text_requirements,
    text_draft: textDraft,
    text_confirmed: true,
    assembled_draft_id: lineageId,
    image_count_mode: "AUTO",
    custom_image_count: textDraft.recommended_image_count,
    production_mode: adoptedContent.generation?.production_mode || "smart",
    image_resume: null,
  };
  const authority = derivePublicationAuthority({
    content: adoptedContent,
    textDraft,
    textConfirmed: true,
    assembledDraftId: lineageId,
  });
  if (!authority.allowed || authority.code !== "CONFIRMED_TEXT_AUTHORITY") {
    throw new TypeError(`HISTORICAL_ADOPTION_AUTHORITY_FAILED:${authority.code}`);
  }
  return {
    content_package: adoptedContent,
    generation_session: generationSession,
    text_draft: textDraft,
    publication_authority: authority,
    paid_image_calls: 0,
  };
}

export function publicationBlockMessage(code) {
  if (code === "TEXT_NOT_CONFIRMED") return "这份文字还没有确认，发布文案和下载已暂停。";
  if (code === "TEXT_NOT_ASSEMBLED") return "当前文字还没有生成对应画布，发布文案和下载已暂停。";
  if (code === "CONTENT_LINEAGE_MISMATCH" || code === "PUBLICATION_COPY_MISMATCH") return "当前文字与画布不是同一稿，已阻止串稿发布。";
  if (code === "CONTENT_LINEAGE_MISSING") return "当前画布缺少确认文字的来源身份，已阻止无来源发布。";
  if (code === "HISTORICAL_CONFIRMATION_REQUIRED") return "这是一份历史成稿，请先确认现有文案，再复制或下载发布包。";
  if (code === "GENERATION_SESSION_MISSING") return "这份生成稿缺少文字来源记录，已阻止无来源发布。";
  return "当前稿件的发布来源无法确认，发布文案和下载已暂停。";
}
