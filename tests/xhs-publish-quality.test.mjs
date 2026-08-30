import assert from "node:assert/strict";
import test from "node:test";
import { inspectXhsPublishQuality } from "../src/xhs-publish-quality.mjs";

function panel(index) {
  return { title: `要点${index}`, body: "一句具体、可执行、不过量的日常说明。", content_role: index === 1 ? "hero" : "support" };
}

test("publish gate accepts a short cover and alternating method-page rhythm", () => {
  const pages = [
    { page_role: "hook", eyebrow: "处暑养生", title: "三步顺着秋天调", info_panels: [] },
    { page_role: "method", eyebrow: "第一步", title: "先把作息慢慢调回来", info_panels: [panel(1), panel(2), panel(3)] },
    { page_role: "method", eyebrow: "第二步", title: "润燥先从温水开始", info_panels: [panel(1), panel(2), panel(3)] },
    { page_role: "method", eyebrow: "第三步", title: "饮食给脾胃减负", info_panels: [panel(1), panel(2), panel(3)] },
    { page_role: "closing", eyebrow: "慢慢来", title: "不舒服就及时停", body: "若持续不适或出现异常，请停下并咨询专业人士。", info_panels: [] },
  ];
  assert.deepEqual(inspectXhsPublishQuality(pages, { pillar: "wellness" }), []);
});

test("publish gate rejects a long cover, missing hero, and missing wellness boundary", () => {
  const issues = inspectXhsPublishQuality([
    { page_role: "hook", eyebrow: "这是一个太长的封面小标题", title: "这是一个远远超过两行预算的封面大标题", info_panels: [] },
    { page_role: "method", eyebrow: "方法", title: "照着做", info_panels: [{ ...panel(2), content_role: "support" }, { ...panel(3), content_role: "support" }] },
  ], { pillar: "wellness" });
  assert.ok(issues.some((issue) => issue.code === "XHS_COVER_TITLE_BUDGET"));
  assert.ok(issues.some((issue) => issue.code === "XHS_SINGLE_HERO_REQUIRED"));
  assert.ok(issues.some((issue) => issue.code === "XHS_WELLNESS_SAFETY_BOUNDARY_MISSING"));
});

test("publish gate rejects repeated section labels, typo repeats and overstuffed panel copy", () => {
  const issues = inspectXhsPublishQuality([
    { page_role: "hook", eyebrow: "处暑养生", title: "三个实用养养法", info_panels: [] },
    { page_role: "method", eyebrow: "第一养：跟着节气", title: "第一养：把入睡时间往前提", info_panels: [
      { ...panel(1), body: "这段文字明显超过三格版式允许的单格正文预算，继续往下堆字只会让排版器缩字或直接把后半截藏起来，因此必须在生成阶段重写。" },
      panel(2), panel(3),
    ] },
  ], { pillar: "wellness", publishBody: "若持续不适或出现异常，请停下并咨询专业人士。" });
  assert.ok(issues.some((issue) => issue.code === "XHS_HEADING_TYPO_REPEAT"));
  assert.ok(issues.some((issue) => issue.code === "XHS_HEADING_PREFIX_DUPLICATED"));
  assert.ok(issues.some((issue) => issue.code === "XHS_PANEL_COPY_BUDGET"));
});
