export function compactTextLength(value) {
  return String(value || "").replace(/\s/g, "").length;
}

export function textDraftLengthBounds(sourceInput) {
  const sourceLength = compactTextLength(sourceInput);
  if (sourceLength < 80) return { minimum: 240, maximum: 900, sourceLength, fullSource: false };
  return { minimum: 180, maximum: Math.min(600, Math.max(220, Math.ceil(sourceLength * 1.3))), sourceLength, fullSource: true };
}

export function textDraftConfirmationIssue(textDraft) {
  if (!textDraft || compactTextLength(textDraft.selected_title) < 8) {
    return { code: "TITLE_TOO_SHORT", title: "标题还不完整", detail: "请把标题补充到至少8个字。" };
  }
  const minimum = textDraftLengthBounds(textDraft.source_input).minimum;
  if (compactTextLength(textDraft.body) < minimum) {
    return {
      code: "BODY_TOO_SHORT",
      title: "正文信息还不够",
      detail: `按当前素材至少需要 ${minimum} 个有效字符。`,
    };
  }
  if (!Array.isArray(textDraft.tags) || textDraft.tags.length !== 5 || textDraft.tags.some((tag) => !String(tag || "").trim())) {
    return { code: "TAGS_INVALID", title: "标签还没填完", detail: "请保留5个有内容的标签。" };
  }
  return null;
}
