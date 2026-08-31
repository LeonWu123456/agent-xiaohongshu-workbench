function sameTags(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function authorityToken(content, textDraft, textConfirmed, assembledDraftId) {
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
  ]);
}

export function derivePublicationAuthority({ content, textDraft = null, textConfirmed = false, assembledDraftId = null, activatedAsContentOnly = false }) {
  const token = authorityToken(content, textDraft, textConfirmed, assembledDraftId);
  if (!content || typeof content !== "object") return { allowed: false, code: "CONTENT_MISSING", token };

  if (!textDraft) {
    if (!activatedAsContentOnly) return { allowed: false, code: "GENERATION_SESSION_MISSING", token };
    return { allowed: true, code: "LEGACY_CONTENT_AUTHORITY", mode: "CONTENT_ONLY", token };
  }

  const draftId = String(textDraft.draft_id || "");
  if (!textConfirmed) return { allowed: false, code: "TEXT_NOT_CONFIRMED", token };
  if (!draftId || assembledDraftId !== draftId) return { allowed: false, code: "TEXT_NOT_ASSEMBLED", token };
  const sourceDraftId = content.generation?.source_draft_id;
  if (sourceDraftId && sourceDraftId !== draftId) return { allowed: false, code: "CONTENT_LINEAGE_MISMATCH", token };
  if (
    content.selectedTitle !== textDraft.selected_title
    || content.body !== textDraft.body
    || !sameTags(content.tags, textDraft.tags)
    || content.source_input !== textDraft.source_input
    || content.pillar !== textDraft.pillar
    || content.goal !== textDraft.goal
  ) return { allowed: false, code: "PUBLICATION_COPY_MISMATCH", token };

  return {
    allowed: true,
    code: sourceDraftId ? "CONFIRMED_TEXT_AUTHORITY" : "LEGACY_EXACT_MATCH",
    mode: "TEXT_DRAFT_PROJECTION",
    token,
  };
}

export function publicationBlockMessage(code) {
  if (code === "TEXT_NOT_CONFIRMED") return "这份文字还没有确认，发布文案和下载已暂停。";
  if (code === "TEXT_NOT_ASSEMBLED") return "当前文字还没有生成对应画布，发布文案和下载已暂停。";
  if (code === "CONTENT_LINEAGE_MISMATCH" || code === "PUBLICATION_COPY_MISMATCH") return "当前文字与画布不是同一稿，已阻止串稿发布。";
  if (code === "GENERATION_SESSION_MISSING") return "这份生成稿缺少文字来源记录，已阻止无来源发布。";
  return "当前稿件的发布来源无法确认，发布文案和下载已暂停。";
}
