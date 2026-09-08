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

test("publish gate allows a narrative method page without infographic panels but keeps other modes strict", () => {
  const pages = [
    { page_role: "hook", eyebrow: "白露食白", title: "日常白色食物吃法", info_panels: [] },
    { page_role: "method", eyebrow: "温润吃法", title: "蒸煮炖慢慢加入日常", body: "挑两三种顺手的白色食物，改用蒸、煮、炖的温热吃法。", visual: "character", info_panels: [] },
  ];
  assert.ok(!inspectXhsPublishQuality(pages, { productionMode: "narrative" }).some((issue) => issue.code === "XHS_METHOD_UNITS_REQUIRED"));
  assert.ok(inspectXhsPublishQuality(pages, { productionMode: "smart" }).some((issue) => issue.code === "XHS_METHOD_UNITS_REQUIRED"));
  assert.ok(inspectXhsPublishQuality(pages, { productionMode: "infographic" }).some((issue) => issue.code === "XHS_METHOD_UNITS_REQUIRED"));
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

test("publish gate rejects a claimed step count that disagrees with the visible panels", () => {
  const mismatched = inspectXhsPublishQuality([
    { page_role: "hook", eyebrow: "雨天日常", title: "初秋整理小书桌", info_panels: [] },
    { page_role: "method", eyebrow: "桌面第一步清理", title: "两步清空多余杂物", info_panels: [panel(1), panel(2), panel(3)] },
  ]);
  assert.ok(mismatched.some((issue) => issue.code === "XHS_STEP_COUNT_MISMATCH"));
  const corrected = inspectXhsPublishQuality([
    { page_role: "hook", eyebrow: "雨天日常", title: "初秋整理小书桌", info_panels: [] },
    { page_role: "method", eyebrow: "桌面第一步清理", title: "三步理顺书桌物品", info_panels: [panel(1), panel(2), panel(3)] },
  ]);
  assert.ok(!corrected.some((issue) => issue.code === "XHS_STEP_COUNT_MISMATCH"));
});


test('final visual gate rejects three-page shell cloning but allows a two-page same-role continuation', async () => {
  const { inspectFinalVisualQuality } = await import('../src/xhs-publish-quality.mjs');
  const same = { title: '把小习惯融进日常迎深秋', page_role: 'method', visual_action: '小师妹用木勺慢慢搅动砂锅里的小米粥', image_style: { src: 'xiaoshimei-media://sha256/' + 'a'.repeat(64) } };
  const bad = [
    { page_role: 'hook', title: '入秋后提不起精神怎么调', visual_action: '小师妹放下温水', image_style: { src: 'xiaoshimei-media://sha256/' + 'b'.repeat(64) } },
    { ...same, body: '先煮粥。' },
    { ...same, body: '这是医疗边界。' },
    { ...same, body: '不舒服就停下。' },
  ];
  const badIssues = inspectFinalVisualQuality(bad);
  assert.ok(badIssues.some(issue => issue.code === 'XHS_FINAL_VISUAL_STUTTER' && issue.page === 4));

  const good = [
    { page_role: 'hook', title: '区分中日茶艺实用方法', visual_action: '小师妹铺茶席', image_style: { src: 'xiaoshimei-media://sha256/' + 'c'.repeat(64) } },
    { page_role: 'method', title: '观察空间与动线的排布逻辑', visual_action: '小师妹指向茶席留白', image_style: { src: 'xiaoshimei-media://sha256/' + 'd'.repeat(64) } },
    { page_role: 'method', title: '观察空间与动线的排布逻辑', visual_action: '小师妹指向茶席留白', image_style: { src: 'xiaoshimei-media://sha256/' + 'd'.repeat(64) } },
  ];
  assert.deepEqual(inspectFinalVisualQuality(good), []);
});

test('final visual gate rejects cross-role reuse of an unchanged title hero and action', async () => {
  const { inspectFinalVisualQuality } = await import('../src/xhs-publish-quality.mjs');
  const hero = 'xiaoshimei-media://sha256/' + 'e'.repeat(64);
  const issues = inspectFinalVisualQuality([
    { page_role: 'judgment', title: '入秋犯困发燥的核心原因', visual_action: '小师妹调整木窗缝隙', image_style: { src: hero } },
    { page_role: 'method', title: '入秋犯困发燥的核心原因', visual_action: '小师妹调整木窗缝隙', image_style: { src: hero } },
  ]);
  assert.ok(issues.some(issue => issue.code === 'XHS_FINAL_CROSS_ROLE_VISUAL_REUSE' && issue.page === 2));
});

test('final route gate reports the tea-as-wellness contamination independently of visual structure', async () => {
  const { inspectFinalRouteQuality } = await import('../src/xhs-publish-quality.mjs');
  const tea = { source_input: '新手区分中日茶艺实用方法', selectedTitle: '区分中日茶艺实用方法', pillar: 'wellness' };
  const issues = inspectFinalRouteQuality(tea);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'XHS_FINAL_PILLAR_TOPIC_CONFLICT');
  assert.equal(issues[0].expected_pillar, 'culture');
  assert.equal(issues[0].observed_pillar, 'wellness');
});

test('legacy conclusion continuation is tolerated narrowly; closing or judgment role flips are not', async () => {
  const { inspectFinalVisualQuality } = await import('../src/xhs-publish-quality.mjs');
  const hero='xiaoshimei-media://sha256/'+'f'.repeat(64),base={title:'同一结论续页',visual_action:'小师妹低头闻茶香',image_style:{src:hero}};
  assert.deepEqual(inspectFinalVisualQuality([{...base,page_role:'conclusion'},{...base,page_role:'method'}]),[]);
  assert.ok(inspectFinalVisualQuality([{...base,page_role:'closing'},{...base,page_role:'method'}]).some(x=>x.code==='XHS_FINAL_CROSS_ROLE_VISUAL_REUSE'));
  assert.ok(inspectFinalVisualQuality([{...base,page_role:'judgment'},{...base,page_role:'method'}]).some(x=>x.code==='XHS_FINAL_CROSS_ROLE_VISUAL_REUSE'));
});
