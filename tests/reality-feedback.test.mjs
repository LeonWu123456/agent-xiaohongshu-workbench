import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { generateContentPackage, parseContentPackage, visualContentSha256 } from "../src/content-engine.mjs";
import { buildPublishZip } from "../src/publish-package.mjs";
import { createProfileV2 } from "../src/profile-v2.mjs";
import { buildWorkspaceBackup, parseWorkspaceBackup } from "../src/workspace-state.mjs";
import { buildRealityLearningContext, createRealityFeedback, normalizeRealityFeedback, realityFeedbackStatus, updateRealityFeedback } from "../src/reality-feedback.mjs";

function pngHeader(width = 1080, height = 1440) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("reality feedback defaults to UNKNOWN and validates manual observations", () => {
  const empty = createRealityFeedback("2026-08-19T10:00:00Z");
  assert.equal(empty.snapshots["24h"].views, "UNKNOWN");
  assert.equal(realityFeedbackStatus(empty), "UNPUBLISHED");
  const published = updateRealityFeedback(empty, { published_at: "2026-08-19T18:00", published_url: "https://www.xiaohongshu.com/explore/demo" }, "2026-08-19T10:01:00Z");
  assert.equal(realityFeedbackStatus(published), "PUBLISHED");
  assert.throws(() => normalizeRealityFeedback({ ...published, published_url: "xiaohongshu://demo" }), /http\(s\)/);
  assert.throws(() => normalizeRealityFeedback({ ...published, snapshots: { ...published.snapshots, "24h": { ...published.snapshots["24h"], views: -1 } } }), /non-negative integer/);
});

test("reality feedback survives local reload without changing visual evidence hash", async () => {
  const content = generateContentPackage({ topic: "现实反馈回载" });
  const before = await visualContentSha256(content, 2);
  content.reality_feedback = updateRealityFeedback(createRealityFeedback(), {
    published_at: "2026-08-19T18:00",
    snapshots: { ...createRealityFeedback().snapshots, "24h": { ...createRealityFeedback().snapshots["24h"], views: 321, saves: 17 } },
    reflection: "收藏比点赞更值得继续观察",
  });
  const restored = parseContentPackage(JSON.stringify(content));
  assert.equal(restored.reality_feedback.snapshots["24h"].views, 321);
  assert.equal(restored.reality_feedback.snapshots["24h"].likes, "UNKNOWN");
  assert.equal(await visualContentSha256(restored, 2), before);
});

test("workspace backup preserves reality feedback but publish ZIP excludes it", async () => {
  const content = { ...generateContentPackage({ topic: "发布后数据边界" }), id: "draft-reality", saved_at: "2026-08-19T18:00:00Z" };
  content.reality_feedback = updateRealityFeedback(createRealityFeedback(), {
    published_at: "2026-08-19T18:00",
    published_url: "https://www.xiaohongshu.com/explore/demo",
    snapshots: { ...createRealityFeedback().snapshots, "24h": { ...createRealityFeedback().snapshots["24h"], views: 100 } },
  });
  const backup = buildWorkspaceBackup({ profile: createProfileV2(), currentContent: content, library: [content] });
  const restored = parseWorkspaceBackup(JSON.stringify(backup));
  assert.equal(restored.library[0].reality_feedback.snapshots["24h"].views, 100);

  const zip = await JSZip.loadAsync(await (await buildPublishZip(content, [pngHeader(), pngHeader()], { createdAt: content.created_at })).arrayBuffer());
  const portable = JSON.parse(await zip.file("content.json").async("string"));
  assert.equal(portable.reality_feedback, undefined);
});

test("saved Reality feedback becomes bounded advisory context for the next generation", () => {
  const feedback = updateRealityFeedback(createRealityFeedback("2026-09-01T00:00:00.000Z"), {
    published_at: "2026-09-01T08:00:00.000Z",
    snapshots: {
      "24h": { views: 1000, likes: 80, comments: 12, saves: 65, shares: 9, followers_gained: 3 },
      "72h": { views: 2200, likes: 160, comments: 26, saves: 130, shares: 20, followers_gained: 8 },
      "7d": { views: 4000, likes: 280, comments: 45, saves: 240, shares: 36, followers_gained: 16 },
    },
    reflection: "收藏高，读者更喜欢清晰步骤；下次减少大图占比。",
  }, "2026-09-03T00:00:00.000Z");
  const context = buildRealityLearningContext([{
    id: "draft-1", selectedTitle: "三步恢复专注", reality_feedback: feedback,
    pages: [{ layout_recipe: "editorial-cover" }, { layout_recipe: "editorial-steps" }],
  }]);
  assert.match(context, /三步恢复专注/);
  assert.match(context, /7天/);
  assert.match(context, /收藏 240/);
  assert.match(context, /editorial-steps/);
  assert.match(context, /仅作参考/);
});

test("Reality learning context ignores empty feedback and stays bounded", () => {
  const empty = createRealityFeedback("2026-09-01T00:00:00.000Z");
  assert.equal(buildRealityLearningContext([{ selectedTitle: "空", reality_feedback: empty }]), "");
  const items = Array.from({ length: 8 }, (_, index) => ({
    selectedTitle: `稿件${index}`,
    reality_feedback: updateRealityFeedback(createRealityFeedback(), { published_url: `https://www.xiaohongshu.com/explore/${index}`, snapshots: { "24h": { views: 100 + index, likes: 1, comments: 0, saves: 1, shares: 0, followers_gained: 0 } } }),
    pages: [{ layout_recipe: "editorial-scene" }],
  }));
  const context = buildRealityLearningContext(items);
  assert.ok(context.length <= 2000);
  assert.equal((context.match(/稿件/g) || []).length, 3);
});


test("unpublished manual metrics remain storable but never become Reality learning evidence", () => {
  const feedback = updateRealityFeedback(createRealityFeedback(), {
    snapshots: { "24h": { views: 9999, likes: 999, comments: 99, saves: 999, shares: 99, followers_gained: 99 } },
    reflection: "这是发布前假设，不是真实结果",
  });
  assert.equal(realityFeedbackStatus(feedback), "UNPUBLISHED");
  assert.equal(buildRealityLearningContext([{ selectedTitle: "未发布稿", reality_feedback: feedback }]), "");
});
