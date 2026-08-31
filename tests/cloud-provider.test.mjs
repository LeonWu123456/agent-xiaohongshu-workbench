import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/provider.mjs";
import {
  PUBLIC_GENERATION_RESPONSE_MAX_BYTES,
  assertPublicGenerationResponseBudget,
  buildMissingUnitRepairJobs,
  buildStandaloneRepairPrompt,
  publicTileBudgetForResponse,
  sliceStandaloneRepairForUnit,
  splitMotherSheetForUnits,
} from "../api/provider.mjs";
import { groupIllustrationUnits } from "../src/mother-sheet.mjs";
import { parsePageCandidateResponse, PAGE_CANDIDATE_RESPONSE_SCHEMA } from "../src/provider-contract.mjs";
import sharp from "sharp";

function responseProbe() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("cloud provider health is public but never claims a stored key", async () => {
  const response = responseProbe();
  await handler({ method: "GET", query: { route: "health" }, headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.configured, false);
  assert.equal(response.body.key_store, "当前标签页 sessionStorage");
});

test("cloud provider fails closed before an upstream call when BYOK is absent", async () => {
  const response = responseProbe();
  await handler({ method: "POST", query: { route: "text-draft" }, headers: {}, body: {} }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "ARK_API_KEY_REQUIRED");
});

test("page candidate contract accepts browser-local generated assets", () => {
  const src = `data:image/png;base64,${Buffer.from("candidate").toString("base64")}`;
  const candidate = { src, sha256: "a".repeat(64), size_bytes: 2048, width: 768, height: 1024 };
  const result = parsePageCandidateResponse({ schema: PAGE_CANDIDATE_RESPONSE_SCHEMA, run_id: "candidate-web-test", candidates: [candidate, candidate, candidate] });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].src, src);
});

test("cloud provider turns one mother sheet into independent trimmed browser assets", async () => {
  const cellWidth = 300;
  const cellHeight = 400;
  const cells = Array.from({ length: 9 }, (_, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const hue = index * 37;
    return `<g transform="translate(${column * cellWidth} ${row * cellHeight})">
      <rect width="${cellWidth}" height="${cellHeight}" fill="white"/>
      <rect x="12" y="12" width="276" height="376" rx="28" fill="hsl(${hue} 70% 55%)"/>
      <circle cx="150" cy="170" r="92" fill="hsl(${(hue + 170) % 360} 72% 38%)"/>
      <path d="M55 330 L150 240 L245 330" fill="none" stroke="#172b2a" stroke-width="22"/>
    </g>`;
  }).join("");
  const sheet = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">${cells}</svg>`)).jpeg({ quality: 92 }).toBuffer();
  const units = [0, 1, 2, 3].map((index) => ({
    unit_id: `page-${index + 1}-hero`, page_index: index, panel_index: null,
    media_role: "hero_scene", preferred_aspect: "3:4", fit_policy: "cover",
  }));
  const job = groupIllustrationUnits(units)[0];
  const tiles = await splitMotherSheetForUnits(sheet, job);
  assert.equal(tiles.length, units.length);
  assert.equal(new Set(tiles.map((tile) => tile.src)).size, units.length);
  assert.equal(new Set(tiles.map((tile) => tile.sha256)).size, units.length);
  for (const [index, tile] of tiles.entries()) {
    assert.match(tile.src, /^data:image\/jpeg;base64,/);
    assert.ok(tile.size_bytes < sheet.length);
    assert.ok(Math.abs(tile.width / tile.height - (index === 0 ? 1.125 : .75)) < .012);
    assert.equal(tile.presence_gate.hasVisibleSubject, true);
  }
  assert.equal(tiles[0].mother_sheet_region_role, "kv-top-adaptive-9:8");
  assert.equal(tiles[0].preferred_aspect, "9:8");
  assert.ok(tiles[0].adaptive_boundary.coordinate > 560 && tiles[0].adaptive_boundary.coordinate < 900);
  assert.ok(tiles[0].height < tiles[1].height);
});

test("cloud provider follows the rendered KV boundary instead of fixed thirds", async () => {
  const width = 900; const height = 1200; const boundary = 660;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="900" height="660" fill="#efc18d"/><circle cx="300" cy="330" r="180" fill="#8e2f25"/>
    <rect y="660" width="900" height="12" fill="#ffffff"/>
    ${[0, 1, 2].map((index) => `<g transform="translate(${index * 300} 672)"><rect width="300" height="400" fill="#ffffff"/><circle cx="150" cy="130" r="85" fill="hsl(${index * 90} 65% 42%)"/><rect x="95" y="220" width="110" height="145" fill="#d9783c"/></g>`).join("")}
  </svg>`;
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
  const units = [0, 1, 2, 3].map((index) => ({ unit_id: `adaptive-${index}`, page_index: index, panel_index: null, media_role: "hero_scene", preferred_aspect: index ? "3:4" : "9:8", fit_policy: "cover" }));
  const tiles = await splitMotherSheetForUnits(bytes, groupIllustrationUnits(units)[0]);
  assert.ok(Math.abs(tiles[0].adaptive_boundary.coordinate - boundary) < 24);
  assert.deepEqual(tiles.map((tile) => [tile.width, tile.height]), [[720, 640], [720, 960], [720, 960], [720, 960]]);
  assert.ok(tiles.every((tile) => tile.pixel_gate.hasCleanEdges));
});

test("cloud mother-sheet tiles stay inside the public response transport budget", async () => {
  const width = 900;
  const height = 1200;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 73 + Math.floor(index / 97) * 29) % 256;
  const sheet = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const units = Array.from({ length: 9 }, (_, index) => ({
    unit_id: `unit-${index}`, page_index: index, panel_index: null,
    media_role: "hero_scene", preferred_aspect: "3:4", fit_policy: "cover",
  }));
  const budget = 90_000;
  const tiles = await splitMotherSheetForUnits(sheet, { template: "grid-3x3", units }, { maxBytes: budget });
  assert.equal(tiles.length, 9);
  tiles.forEach((tile) => assert.ok(tile.size_bytes <= budget, `${tile.unit_id} is ${tile.size_bytes} bytes`));
});

test("cloud mother-sheet slicing preserves missing-unit evidence for bounded repair", async () => {
  const blank = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "white" } }).jpeg().toBuffer();
  const units = [
    { unit_id: "page-1-hero", page_index: 0, panel_index: null, preferred_aspect: "9:8", media_role: "cover_kv", fit_policy: "cover" },
    { unit_id: "page-4-hero", page_index: 3, panel_index: null, preferred_aspect: "3:4", media_role: "hero_scene", fit_policy: "cover" },
  ];
  const tiles = await splitMotherSheetForUnits(blank, { template: "grid-3x3", units }, { allowMissing: true });
  assert.deepEqual(tiles.map((tile) => tile.missing), [true, true]);
  await assert.rejects(() => splitMotherSheetForUnits(blank, { template: "grid-3x3", units }), /MOTHER_SHEET_UNIT_MISSING/);
  const jobs = buildMissingUnitRepairJobs(units, 2);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].template, "kv-top-3x2");
  assert.equal(jobs[1].template, "grid-3x3");
  assert.equal(jobs[1].units[0].unit_id, "page-4-hero");
});

test("cloud single-unit repair avoids paying for a sparse 3x3 mother sheet", async () => {
  const unit = {
    unit_id: "page-4-panel-1", page_index: 3, panel_index: 0,
    media_role: "inline_sticker", preferred_aspect: "3:4", fit_policy: "contain",
    visual_action: "小师妹把桌面上的书本竖直归拢到木质书立旁",
    image_prompt: "完整人物与书本都在画面中央，手部动作清楚",
  };
  const prompt = buildStandaloneRepairPrompt(unit);
  assert.match(prompt, /不是母图、不是拼图、不是网格/);
  assert.match(prompt, /page-4-panel-1/);
  assert.match(prompt, /竖直归拢/);
  const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="white"/><circle cx="450" cy="360" r="180" fill="#b94035"/><rect x="300" y="520" width="300" height="480" rx="80" fill="#d79b55"/></svg>`)).jpeg({ quality: 92 }).toBuffer();
  const tile = await sliceStandaloneRepairForUnit(image, unit, { maxBytes: 100_000 });
  assert.equal(tile.unit_id, unit.unit_id);
  assert.equal(tile.repair_source, "standalone-image");
  assert.equal(tile.missing, undefined);
  assert.ok(Math.abs(tile.width / tile.height - .75) < .012);
  assert.ok(tile.size_bytes <= 100_000);
  const blank = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "white" } }).jpeg().toBuffer();
  const missing = await sliceStandaloneRepairForUnit(blank, unit, { allowMissing: true });
  assert.equal(missing.missing, true);
  assert.equal(missing.repair_failure_reason, "VISUAL_SUBJECT_MISSING");
});

test("cloud response budget fails closed before a browser receives an oversized JSON body", () => {
  const withinBudget = { payload: "a".repeat(32_000) };
  assert.ok(assertPublicGenerationResponseBudget(withinBudget) > 32_000);
  assert.throws(
    () => assertPublicGenerationResponseBudget({ payload: "a".repeat(PUBLIC_GENERATION_RESPONSE_MAX_BYTES + 1) }),
    /PUBLIC_RESPONSE_BUDGET_EXCEEDED/,
  );
  assert.ok(publicTileBudgetForResponse(24) < publicTileBudgetForResponse(4));
});
