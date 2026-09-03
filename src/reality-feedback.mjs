export const REALITY_FEEDBACK_SCHEMA = "xiaoshimei.reality-feedback.v1";
export const REALITY_WINDOWS = Object.freeze(["24h", "72h", "7d"]);
export const REALITY_METRICS = Object.freeze([
  "views",
  "likes",
  "comments",
  "saves",
  "shares",
  "followers_gained",
]);

const UNKNOWN = "UNKNOWN";

function metricValue(value, path) {
  if (value == null || value === "" || value === UNKNOWN) return UNKNOWN;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${path} must be UNKNOWN or a non-negative integer`);
  return number;
}

function snapshot(value = {}, path) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(REALITY_METRICS.map((key) => [key, metricValue(source[key], `${path}.${key}`)]));
}
export function createRealityFeedback(now = new Date().toISOString()) {
  return {
    schema: REALITY_FEEDBACK_SCHEMA,
    platform: "xiaohongshu",
    published_at: "",
    published_url: "",
    snapshots: Object.fromEntries(REALITY_WINDOWS.map((window) => [window, snapshot({}, `snapshots.${window}`)])),
    reflection: "",
    updated_at: now,
  };
}

export function normalizeRealityFeedback(value) {
  const base = createRealityFeedback();
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== REALITY_FEEDBACK_SCHEMA) {
    throw new TypeError("reality feedback schema is not supported");
  }
  const publishedAt = typeof value.published_at === "string" ? value.published_at.trim().slice(0, 80) : "";
  const publishedUrl = typeof value.published_url === "string" ? value.published_url.trim().slice(0, 1000) : "";
  const reflection = typeof value.reflection === "string" ? value.reflection.trim().slice(0, 2000) : "";
  if (publishedUrl && !/^https?:\/\//i.test(publishedUrl)) throw new TypeError("published_url must be http(s) or empty");
  return {
    schema: REALITY_FEEDBACK_SCHEMA,
    platform: "xiaohongshu",
    published_at: publishedAt,
    published_url: publishedUrl,
    snapshots: Object.fromEntries(REALITY_WINDOWS.map((window) => [window, snapshot(value.snapshots?.[window], `snapshots.${window}`)])),
    reflection,
    updated_at: typeof value.updated_at === "string" && value.updated_at.trim() ? value.updated_at.trim() : base.updated_at,
  };
}

export function updateRealityFeedback(value, patch, now = new Date().toISOString()) {
  const current = normalizeRealityFeedback(value) || createRealityFeedback(now);
  return normalizeRealityFeedback({ ...current, ...patch, updated_at: now });
}

export function realityFeedbackStatus(value) {
  const feedback = normalizeRealityFeedback(value);
  if (!feedback || (!feedback.published_at && !feedback.published_url)) return "UNPUBLISHED";
  const filledWindows = REALITY_WINDOWS.filter((window) => REALITY_METRICS.some((metric) => feedback.snapshots[window][metric] !== UNKNOWN));
  if (filledWindows.length === REALITY_WINDOWS.length) return "7D_COMPLETE";
  if (filledWindows.length) return "TRACKING";
  return "PUBLISHED";
}


function latestObservedWindow(feedback) {
  for (const window of ["7d", "72h", "24h"]) {
    if (REALITY_METRICS.some((metric) => feedback.snapshots[window][metric] !== UNKNOWN)) return window;
  }
  return null;
}

function compactMetric(label, value) {
  return value === UNKNOWN ? null : `${label} ${value}`;
}

export function buildRealityLearningContext(items, { maxItems = 3, maxChars = 2000 } = {}) {
  if (!Array.isArray(items) || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 5 || !Number.isInteger(maxChars) || maxChars < 200 || maxChars > 4000) return "";
  const rows = [];
  for (const item of items) {
    let feedback;
    try { feedback = normalizeRealityFeedback(item?.reality_feedback); }
    catch { continue; }
    if (!feedback || (!feedback.published_at && !feedback.published_url)) continue;
    const window = latestObservedWindow(feedback);
    const reflection = String(feedback.reflection || "").trim();
    if (!window && !reflection) continue;
    const title = String(item?.selectedTitle || item?.title || "历史稿件").trim().slice(0, 80) || "历史稿件";
    const metrics = window ? feedback.snapshots[window] : null;
    const metricText = metrics ? [
      compactMetric("浏览", metrics.views), compactMetric("赞", metrics.likes), compactMetric("评论", metrics.comments),
      compactMetric("收藏", metrics.saves), compactMetric("分享", metrics.shares), compactMetric("涨粉", metrics.followers_gained),
    ].filter(Boolean).join("、") : "";
    const recipes = [...new Set((Array.isArray(item?.pages) ? item.pages : []).map((page) => String(page?.layout_recipe || "").trim()).filter(Boolean))].slice(0, 6);
    const updatedAt = String(feedback.updated_at || "");
    rows.push({ updatedAt, text: `《${title}》${window ? `｜${window === "7d" ? "7天" : window === "72h" ? "72小时" : "24小时"}：${metricText}` : ""}${recipes.length ? `｜已用版式 ${recipes.join("/")}` : ""}${reflection ? `｜人工复盘：${reflection.slice(0, 500)}` : ""}` });
  }
  rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (!rows.length) return "";
  const header = "历史现实反馈，仅作参考；可用于下一轮内容与视觉策略判断，但不得绕过当前文字确认、版式 QA、发布来源或付费调用边界。";
  let output = header;
  for (const row of rows.slice(0, maxItems)) {
    const next = `${output}\n- ${row.text}`;
    if (next.length > maxChars) break;
    output = next;
  }
  return output === header ? "" : output;
}
