import { recommendHtmlLayout } from "./html-layout.mjs";
import { inferContentPillar } from "./content-routing.mjs";

function compact(value) { return String(value || "").replace(/\s/g, "").length; }
function normalized(value) { return String(value || "").replace(/[\s：:，,。.!！?？、·\-—_]/g, ""); }

function sectionPrefix(value) {
  return normalized(value).match(/^(?:第)?[一二三四五六七八九十\d]+(?:步|养|招|法|点|个|页)/)?.[0] || "";
}

function hasSuspiciousAdjacentRepeat(value) {
  const text = normalized(value);
  const allowed = new Set(["慢慢", "轻轻", "渐渐", "好好", "天天", "常常", "往往", "刚刚", "稳稳", "步步"]);
  for (let index = 1; index < text.length; index += 1) {
    const pair = text.slice(index - 1, index + 1);
    if (text[index] === text[index - 1] && !allowed.has(pair)) return true;
  }
  return false;
}

function declaredStepCounts(page) {
  const numeral = { "二": 2, "两": 2, "三": 3, "四": 4 };
  return [page?.eyebrow, page?.title].flatMap((value) => [...String(value || "").matchAll(/(?<!第)([二两三四2-4])步/gu)]
    .map((match) => numeral[match[1]] || Number(match[1])));
}

/**
 * A deterministic pre-publish scorecard. It checks information architecture,
 * not taste: the browser geometry and pixel gates remain separate authorities.
 */
export function inspectXhsPublishQuality(pages, { pillar = "", publishBody = "", productionMode = "smart" } = {}) {
  if (!Array.isArray(pages) || !pages.length) return [{ code: "XHS_PAGES_MISSING", page: 0 }];
  const issues = [];
  const narrative = String(productionMode) === "narrative";
  const layouts = pages.map((page, index) => recommendHtmlLayout(page, index));
  pages.forEach((page, index) => {
    const role = String(page?.page_role || (index === 0 ? "hook" : "example"));
    const panels = Array.isArray(page?.info_panels) ? page.info_panels : [];
    const eyebrowPrefix = sectionPrefix(page?.eyebrow);
    const titlePrefix = sectionPrefix(page?.title);
    if (eyebrowPrefix && eyebrowPrefix === titlePrefix) issues.push({ code: "XHS_HEADING_PREFIX_DUPLICATED", page: index + 1 });
    if (hasSuspiciousAdjacentRepeat(page?.eyebrow) || hasSuspiciousAdjacentRepeat(page?.title)) issues.push({ code: "XHS_HEADING_TYPO_REPEAT", page: index + 1 });
    if (index === 0) {
      if (role !== "hook") issues.push({ code: "XHS_COVER_ROLE_REQUIRED", page: 1 });
      if (compact(page?.eyebrow) > 10) issues.push({ code: "XHS_COVER_EYEBROW_TOO_LONG", page: 1 });
      if (compact(page?.title) < 6 || compact(page?.title) > 16) issues.push({ code: "XHS_COVER_TITLE_BUDGET", page: 1 });
      if (layouts[index] !== "cover-poster") issues.push({ code: "XHS_COVER_POSTER_REQUIRED", page: 1 });
      if (panels.length) issues.push({ code: "XHS_COVER_SINGLE_VISUAL_REQUIRED", page: 1 });
      return;
    }
    if (compact(page?.eyebrow) > 14 || compact(page?.title) > 18) issues.push({ code: "XHS_INNER_TITLE_BUDGET", page: index + 1 });
    if (panels.length >= 2 && declaredStepCounts(page).some((count) => count !== panels.length)) {
      issues.push({ code: "XHS_STEP_COUNT_MISMATCH", page: index + 1 });
    }
    if (!narrative && ["method", "checklist", "pitfall"].includes(role) && (panels.length < 2 || panels.length > 4)) {
      issues.push({ code: "XHS_METHOD_UNITS_REQUIRED", page: index + 1 });
    }
    if (panels.length >= 2 && panels.filter((panel) => panel?.content_role === "hero").length !== 1) {
      issues.push({ code: "XHS_SINGLE_HERO_REQUIRED", page: index + 1 });
    }
    const panelBodyLimit = panels.length >= 4 ? 36 : panels.length === 3 ? 52 : 72;
    if (panels.some((panel) => compact(panel?.title) < 2 || compact(panel?.title) > 14 || compact(panel?.body) < 12 || compact(panel?.body) > panelBodyLimit || hasSuspiciousAdjacentRepeat(panel?.title))) {
      issues.push({ code: "XHS_PANEL_COPY_BUDGET", page: index + 1 });
    }
  });
  for (let index = 2; index < layouts.length; index += 1) {
    if (layouts[index] === layouts[index - 1] && layouts[index] === layouts[index - 2] && layouts[index] !== "visual-story") {
      issues.push({ code: "XHS_THREE_PAGE_LAYOUT_MONOTONY", page: index + 1 });
    }
  }
  if (String(pillar) === "wellness") {
    const allCopy = `${publishBody}\n${pages.map((page) => [page?.title, page?.body, ...(page?.info_panels || []).flatMap((panel) => [panel?.title, panel?.body])].join("\n")).join("\n")}`;
    if (!/不适|疼痛|异常|停止|停下|就医|医生|专业帮助|专业人士|咨询|不能替代|不代替|仅作日常/.test(allCopy)) {
      issues.push({ code: "XHS_WELLNESS_SAFETY_BOUNDARY_MISSING", page: pages.length });
    }
  }
  return issues;
}

export function assertXhsPublishQuality(pages, context = {}) {
  const issues = inspectXhsPublishQuality(pages, context);
  if (issues.length) throw new TypeError(`XHS_PUBLISH_GATE_FAILED:${issues.map((issue) => `${issue.page}:${issue.code}`).join(",")}`);
  return pages;
}


function finalHeroSource(page) {
  if (page?.visual === "none" || page?.image_style?.hidden === true) return "";
  return String(page?.image_style?.src || "").trim();
}

function finalVisualSignature(page) {
  return {
    title: normalized(page?.title),
    hero: finalHeroSource(page),
    action: normalized(page?.visual_action),
    role: String(page?.page_role || ""),
  };
}

function sameVisualSignature(left, right) {
  return Boolean(left?.title && left?.hero && left?.action
    && left.title === right?.title && left.hero === right?.hero && left.action === right?.action);
}

/** Final-page structural checks. These run after mobile materialization, not on the upstream plan. */
export function inspectFinalVisualQuality(pages) {
  if (!Array.isArray(pages) || !pages.length) return [{ code: "XHS_FINAL_PAGES_MISSING", page: 0 }];
  const issues=[];
  const signatures=pages.map(finalVisualSignature);
  for(let index=1;index<signatures.length;index+=1){
    const current=signatures[index],previous=signatures[index-1];
    const legacyConclusionContinuation=previous.role==='conclusion'&&current.role==='method';
    if(sameVisualSignature(previous,current) && previous.role && current.role && previous.role!==current.role&&!legacyConclusionContinuation){
      issues.push({code:"XHS_FINAL_CROSS_ROLE_VISUAL_REUSE",page:index+1,previous_page:index,previous_role:previous.role,current_role:current.role});
    }
  }
  for(let index=2;index<signatures.length;index+=1){
    if(sameVisualSignature(signatures[index-2],signatures[index-1])&&sameVisualSignature(signatures[index-1],signatures[index])){
      issues.push({code:"XHS_FINAL_VISUAL_STUTTER",page:index+1,start_page:index-1});
    }
  }
  return issues;
}

export function inspectFinalRouteQuality(content) {
  const observed=String(content?.pillar||"").trim();
  if(!observed)return[];
  const topic=[content?.source_input,content?.selectedTitle].filter(Boolean).join("\n");
  const route=inferContentPillar(topic,{fallback:observed});
  if(!route.confident||route.pillar===observed)return[];
  return [{code:"XHS_FINAL_PILLAR_TOPIC_CONFLICT",page:1,expected_pillar:route.pillar,observed_pillar:observed,route_score:route.score,route_margin:route.margin}];
}

export function inspectFinalXhsPublishQuality(content) {
  const pages=(content?.pages||[]).slice(0,Number(content?.visible_pages||0));
  return [...inspectFinalVisualQuality(pages),...inspectFinalRouteQuality(content)];
}

const FINAL_QUALITY_MESSAGES=Object.freeze({
  XHS_FINAL_VISUAL_STUTTER: issue=>`第${issue.page}页：连续页面重复同一标题、配图和动作`,
  XHS_FINAL_CROSS_ROLE_VISUAL_REUSE: issue=>`第${issue.page}页：内容职责已经变化，却仍沿用上一页同一标题、配图和动作`,
  XHS_FINAL_PILLAR_TOPIC_CONFLICT: issue=>`内容方向应为${issue.expected_pillar}，当前稿却按${issue.observed_pillar}生成`,
  XHS_FINAL_PAGES_MISSING: ()=>"没有可发布页面",
});

export function assertFinalXhsPublishQuality(content) {
  const issues=inspectFinalXhsPublishQuality(content);
  if(!issues.length)return content;
  const detail=issues.slice(0,3).map(issue=>(FINAL_QUALITY_MESSAGES[issue.code]||(()=>issue.code))(issue)).join("；");
  const error=new TypeError(`最终成品质量检查未通过：${detail}。请先修正后再导出整篇。`);
  error.code="XHS_FINAL_PUBLISH_GATE_FAILED";
  error.issues=issues;
  throw error;
}
