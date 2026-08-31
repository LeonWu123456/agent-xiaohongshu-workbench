import assert from "node:assert/strict";
import test from "node:test";
import {
  admitPublicImageJob,
  appendPublicImageJobs,
  completePublicImageRun,
  createPublicImageRun,
  failPublicImageJob,
  parsePublicImageRun,
  publicImageRunProgress,
  startPublicImageJob,
  unresolvedPublicImageUnitIds,
} from "../src/public-image-run.mjs";

function tile(unitId, seed = "a") {
  return {
    unit_id: unitId,
    page_index: Number(unitId.split("-")[1]) - 1,
    panel_index: null,
    src: `data:image/jpeg;base64,${Buffer.from(`image-${unitId}`).toString("base64")}`,
    sha256: seed.repeat(64),
    size_bytes: 2048,
    width: 720,
    height: 960,
  };
}

function base() {
  const units = [1, 2].map((page) => ({ unit_id: `page-${page}-hero`, page_index: page - 1, panel_index: null }));
  return createPublicImageRun({
    runId: "images-2026-08-31T08-00-00-000Z-abcdef12",
    draftId: "draft-1",
    draftSha256: "d".repeat(64),
    productionMode: "smart",
    finalPages: [{ title: "第一页" }, { title: "第二页" }],
    illustrationUnits: units,
    planAttempts: [{ attempt: 1, status: "PASS" }],
    referenceFingerprint: "f".repeat(64),
    jobs: [{ sheet_id: "mother-sheet-1", sheet_index: 0, template: "grid-3x3", units, job_kind: "mother_sheet" }],
  });
}

test("public image run admits one paid step, preserves good assets, and appends only missing repairs", () => {
  let run = startPublicImageJob(base());
  assert.equal(run.actual_image_calls, 1);
  run = admitPublicImageJob(run, { assets: [tile("page-1-hero")], attempt: { image_sha256: "1".repeat(64) } });
  assert.deepEqual(unresolvedPublicImageUnitIds(run), ["page-2-hero"]);
  assert.deepEqual(publicImageRunProgress(run), {
    resume_run_id: run.run_id,
    completed_pages: 1,
    total_pages: 2,
    completed_image_steps: 1,
    total_image_steps: 1,
    failed_image_step: null,
    actual_image_calls: 1,
    estimated_image_cost_cny: 0.22,
  });
  run = appendPublicImageJobs(run, { phase: "STANDALONE_REPAIR", jobs: [{ sheet_id: "standalone-page-2", sheet_index: 1, units: [run.illustration_units[1]], job_kind: "standalone" }] });
  run = startPublicImageJob(run);
  run = admitPublicImageJob(run, { assets: [tile("page-2-hero", "b")] });
  run = completePublicImageRun(run);
  assert.equal(run.status, "COMPLETE");
  assert.equal(run.actual_image_calls, 2);
  assert.deepEqual(unresolvedPublicImageUnitIds(run), []);
});

test("a failed public image step is resumable at the same job without losing earlier assets", () => {
  let run = startPublicImageJob(base());
  run = failPublicImageJob(run, { code: "MOTHER_SHEET_1_CALL_FAILED:timeout" });
  assert.equal(run.status, "PARTIAL_FAILURE_RESUMABLE");
  assert.equal(run.next_job_index, 0);
  assert.equal(run.actual_image_calls, 1);
  assert.equal(publicImageRunProgress(run).failed_image_step, 1);
  run = startPublicImageJob(run);
  run = admitPublicImageJob(run, { assets: [tile("page-1-hero"), tile("page-2-hero", "b")] });
  assert.equal(run.next_job_index, 1);
  assert.equal(run.actual_image_calls, 2);
  assert.equal(run.assets.length, 2);
});

test("public image checkpoint rejects lineage drift and duplicate assets", () => {
  const run = base();
  assert.equal(parsePublicImageRun(run, { draftId: "draft-1", draftSha256: "d".repeat(64), finalPageCount: 2 }).run_id, run.run_id);
  assert.throws(() => parsePublicImageRun(run, { draftId: "draft-2" }), /DRAFT_ID_MISMATCH/);
  assert.throws(() => parsePublicImageRun({ ...run, assets: [tile("page-1-hero"), tile("page-1-hero")] }), /ASSET_DUPLICATE/);
});
