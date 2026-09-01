import assert from "node:assert/strict";
import test from "node:test";
import { cleanupGeneratedGridArtifacts } from "../src/mother-sheet-artifact-cleanup.mjs";

function synthetic({ kv = false } = {}) {
  const width = 120; const height = 160; const channels = 4;
  const data = new Uint8Array(width * height * channels).fill(255);
  const set = (x, y, value) => data.set([value, value, value, 255], (y * width + x) * channels);
  if (kv) for (let y = 0; y < height; y += 1) set(25, y, 210);
  for (let x = 0; x < width; x += 1) { set(x, 6, 220); set(x, 153, 220); }
  for (let y = 0; y < height; y += 1) { set(4, y, 220); set(115, y, 220); }
  // Simulate visible pixels leaked from neighbouring mother-sheet cells.
  for (let y = 0; y < 6; y += 1) for (let x = 45; x < 75; x += 1) set(x, y, 80);
  for (let y = 154; y < height; y += 1) for (let x = 30; x < 60; x += 1) set(x, y, 80);
  for (let y = 40; y < 140; y += 1) for (let x = 55; x < 110; x += 1) set(x, y, 60);
  return { data, width, height, channels };
}

test("cleanup removes an internal KV seam and edge grid rules without touching the subject", () => {
  const result = cleanupGeneratedGridArtifacts(synthetic({ kv: true }), { kv: true });
  assert.deepEqual(result.actions.map((action) => action.type), [
    "KV_LEFT_CONTAMINATION_REMOVED",
    "HORIZONTAL_GRID_EDGE_BAND_REMOVED",
    "HORIZONTAL_GRID_EDGE_BAND_REMOVED",
    "VERTICAL_GRID_EDGE_BAND_REMOVED",
  ]);
  assert.equal(result.data[(80 * 120 + 80) * 4], 60);
  assert.equal(result.data[(80 * 120 + 25) * 4], 255);
  assert.equal(result.data[(6 * 120 + 80) * 4], 255);
  assert.equal(result.data[(2 * 120 + 60) * 4], 255);
  assert.equal(result.data[(157 * 120 + 40) * 4], 255);
  assert.equal(result.data[(80 * 120 + 2) * 4], 255);
  assert.equal(result.data[(80 * 120 + 118) * 4], 255);
});

test("cleanup expands a legacy repaired rule through the contaminated outer band", () => {
  const image = synthetic();
  // Emulate v3: only the detected horizontal rule was whitewashed.
  for (let x = 0; x < image.width; x += 1) {
    for (let y = 4; y <= 8; y += 1) image.data.set([255, 255, 255, 255], (y * image.width + x) * image.channels);
  }
  const result = cleanupGeneratedGridArtifacts(image, {
    previousActions: [{ type: "HORIZONTAL_GRID_RULE_REMOVED", coordinate: 6, ratio: 1 }],
  });
  assert.equal(result.actions[0].type, "LEGACY_HORIZONTAL_GRID_EDGE_BAND_REMOVED");
  assert.equal(result.data[(2 * image.width + 60) * image.channels], 255);
  assert.equal(result.data[(80 * image.width + 80) * image.channels], 60);
});

test("cleanup normalizes only edge-connected near-white paper and preserves an enclosed white subject", () => {
  const width = 40; const height = 48; const channels = 4;
  const data = new Uint8Array(width * height * channels);
  for (let offset = 0; offset < width * height; offset += 1) data.set([248, 248, 246, 255], offset * channels);
  const set = (x, y, rgb) => data.set([...rgb, 255], (y * width + x) * channels);
  for (let x = 11; x <= 28; x += 1) { set(x, 11, [45, 45, 45]); set(x, 36, [45, 45, 45]); }
  for (let y = 11; y <= 36; y += 1) { set(11, y, [45, 45, 45]); set(28, y, [45, 45, 45]); }
  for (let y = 12; y < 36; y += 1) for (let x = 12; x < 28; x += 1) set(x, y, [246, 246, 244]);
  const result = cleanupGeneratedGridArtifacts({ data, width, height, channels });
  assert.equal(result.actions.at(-1).type, "EDGE_CONNECTED_PAPER_NORMALIZED");
  assert.equal(result.data[(2 * width + 2) * channels], 255);
  assert.equal(result.data[(20 * width + 20) * channels], 246);
  assert.equal(result.data[(11 * width + 20) * channels], 45);
});

test("cleanup whitens warm ivory illustration paper without crossing the subject outline", () => {
  const width = 48; const height = 64; const channels = 4;
  const data = new Uint8Array(width * height * channels);
  for (let offset = 0; offset < width * height; offset += 1) data.set([240, 234, 222, 255], offset * channels);
  const set = (x, y, rgb) => data.set([...rgb, 255], (y * width + x) * channels);
  for (let x = 12; x <= 35; x += 1) { set(x, 14, [48, 43, 39]); set(x, 49, [48, 43, 39]); }
  for (let y = 14; y <= 49; y += 1) { set(12, y, [48, 43, 39]); set(35, y, [48, 43, 39]); }
  for (let y = 15; y < 49; y += 1) for (let x = 13; x < 35; x += 1) set(x, y, [239, 231, 216]);
  const result = cleanupGeneratedGridArtifacts({ data, width, height, channels });
  assert.equal(result.actions.at(-1).type, "EDGE_CONNECTED_PAPER_NORMALIZED");
  const outside = [...result.data.slice((2 * width + 2) * channels, (2 * width + 2) * channels + 3)];
  assert.ok(outside.every((value) => value >= 252));
  assert.ok(Math.max(...outside) - Math.min(...outside) <= 2);
  assert.deepEqual([...result.data.slice((28 * width + 24) * channels, (28 * width + 24) * channels + 3)], [239, 231, 216]);
  assert.deepEqual([...result.data.slice((14 * width + 24) * channels, (14 * width + 24) * channels + 3)], [48, 43, 39]);
});

test("explicit illustration cleanup makes the full connected warm gradient visually white", () => {
  const width = 64; const height = 48; const channels = 4;
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const shade = 246 - Math.round((x / (width - 1)) * 34);
    data.set([shade, shade - 5, shade - 14, 255], (y * width + x) * channels);
  }
  const result = cleanupGeneratedGridArtifacts({ data, width, height, channels }, { paperOnly: true });
  const row = Math.floor(height / 2);
  const outputLightness = Array.from({ length: width }, (_, x) => {
    const offset = (row * width + x) * channels;
    return (result.data[offset] + result.data[offset + 1] + result.data[offset + 2]) / 3;
  });
  const largestStep = Math.max(...outputLightness.slice(1).map((value, index) => Math.abs(value - outputLightness[index])));
  assert.ok(largestStep <= 2, `gradient introduced a ${largestStep}-level hard edge`);
  assert.ok(outputLightness[0] >= 252);
  assert.ok(outputLightness.at(-1) >= 252);
  assert.deepEqual(result.actions.map((action) => action.type), ["EDGE_CONNECTED_PAPER_NORMALIZED"]);
});

test("automatic 3:4 illustration cleanup enforces white paper while preserving an enclosed warm subject", () => {
  const width = 48; const height = 64; const channels = 4;
  const data = new Uint8Array(width * height * channels);
  for (let offset = 0; offset < width * height; offset += 1) data.set([234, 222, 204, 255], offset * channels);
  const set = (x, y, rgb) => data.set([...rgb, 255], (y * width + x) * channels);
  for (let x = 12; x <= 35; x += 1) { set(x, 14, [54, 46, 40]); set(x, 49, [54, 46, 40]); }
  for (let y = 14; y <= 49; y += 1) { set(12, y, [54, 46, 40]); set(35, y, [54, 46, 40]); }
  for (let y = 15; y < 49; y += 1) for (let x = 13; x < 35; x += 1) set(x, y, [226, 196, 164]);
  const result = cleanupGeneratedGridArtifacts({ data, width, height, channels }, { enforceWhitePaper: true });
  const outside = [...result.data.slice((2 * width + 2) * channels, (2 * width + 2) * channels + 3)];
  assert.ok(outside.every((value) => value >= 252));
  assert.deepEqual([...result.data.slice((28 * width + 24) * channels, (28 * width + 24) * channels + 3)], [226, 196, 164]);
});

test("connected paper core becomes uniform white while only a three-pixel subject boundary feathers", () => {
  const width = 96; const height = 72; const channels = 4;
  const data = new Uint8Array(width * height * channels);
  const set = (x, y, rgb) => data.set([...rgb, 255], (y * width + x) * channels);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const progress = x / (width - 1);
    set(x, y, [244 - Math.round(progress * 25), 237 - Math.round(progress * 22), 224 - Math.round(progress * 18)]);
  }
  for (let x = 34; x <= 61; x += 1) { set(x, 20, [49, 43, 38]); set(x, 55, [49, 43, 38]); }
  for (let y = 20; y <= 55; y += 1) { set(34, y, [49, 43, 38]); set(61, y, [49, 43, 38]); }
  for (let y = 21; y < 55; y += 1) for (let x = 35; x < 61; x += 1) set(x, y, [226, 190, 158]);
  const sourceSubject = [...data.slice((36 * width + 48) * channels, (36 * width + 48) * channels + 3)];

  const result = cleanupGeneratedGridArtifacts({ data, width, height, channels }, { paperOnly: true });
  const core = [];
  for (let y = 4; y <= 12; y += 1) for (let x = 4; x < width - 4; x += 1) {
    const offset = (y * width + x) * channels;
    core.push(result.data[offset], result.data[offset + 1], result.data[offset + 2]);
  }
  assert.ok(core.every((value) => value >= 252), `paper core retained a ${Math.min(...core)} channel`);
  assert.ok(Math.max(...core) - Math.min(...core) <= 3, "broad warm gradient remained visible in the paper core");
  assert.deepEqual([...result.data.slice((36 * width + 48) * channels, (36 * width + 48) * channels + 3)], sourceSubject);
  assert.deepEqual([...result.data.slice((20 * width + 48) * channels, (20 * width + 48) * channels + 3)], [49, 43, 38]);

  const featherLightness = [16, 17, 18, 19].map((y) => {
    const offset = (y * width + 48) * channels;
    return (result.data[offset] + result.data[offset + 1] + result.data[offset + 2]) / 3;
  });
  const featherSteps = featherLightness.slice(1).map((value, index) => Math.abs(value - featherLightness[index]));
  assert.ok(Math.max(...featherSteps) <= 14, `paper feather introduced a ${Math.max(...featherSteps)}-level hard step`);
});
