import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  ARK_BASE_URL,
  assembleArkContentFromDraft,
  buildArkDraftTextRequest,
  buildArkImageRequest,
  buildArkPageCandidatePrompt,
  buildArkPagePlanRequest,
  decodeArkImage,
  extractArkPagePlan,
  extractArkTextDraft,
  inspectImageBytes,
  isThreeByFourImage,
  pagePlanRetryGuidance,
  sha256Bytes,
  textQualityRetryGuidance,
} from "../src/ark-provider-core.mjs";
import { parseContentPackage } from "../src/content-engine.mjs";
import {
  buildIllustrationUnits,
  buildMotherSheetPrompt,
  groupIllustrationUnits,
  motherSheetRegionForUnit,
} from "../src/mother-sheet.mjs";
import { inspectMotherSheetTileStats } from "../src/mother-sheet-tile-quality.mjs";
import { inspectMotherSheetTilePixels } from "../src/mother-sheet-tile-quality.mjs";
import { detectKvTemplateRegions } from "../src/mother-sheet-adaptive-regions.mjs";
import { cleanupGeneratedGridArtifacts } from "../src/mother-sheet-artifact-cleanup.mjs";
import { detectUniformEdgeInsets, exactThreeByFourCrop } from "../src/mother-sheet-trim.mjs";
import { assertXhsPublishQuality } from "../src/xhs-publish-quality.mjs";
import {
  PAGE_CANDIDATE_RESPONSE_SCHEMA,
  TEXT_DRAFT_RESPONSE_SCHEMA,
  parseImageGenerationRequest,
  parsePageCandidateRequest,
  parseTextDraftRequest,
} from "../src/provider-contract.mjs";
import { XIAOSHIMEI_AVATAR_DATA_URL } from "./xiaoshimei-avatar-data.mjs";

export const config = { maxDuration: 300 };

const IMAGE_PRICE_CNY = 0.22;
const DEFAULT_TEXT_MODEL = "doubao-seed-2-0-lite-260428";
const DEFAULT_IMAGE_MODEL = "doubao-seedream-5-0-lite-260128";
export const PUBLIC_GENERATION_RESPONSE_MAX_BYTES = 4_000_000;
const PUBLIC_TILE_PAYLOAD_BUDGET_BYTES = 2_600_000;

export function publicTileBudgetForResponse(unitCount) {
  const count = Math.max(1, Number(unitCount) || 1);
  return Math.max(56_000, Math.min(160_000, Math.floor(PUBLIC_TILE_PAYLOAD_BUDGET_BYTES / count)));
}

async function encodeTileForPublicTransport(baseTile, preferredAspect, maxBytes) {
  const ratio = preferredAspect === "9:8" ? 9 / 8 : 3 / 4;
  const profiles = [
    { width: 720, quality: 82 },
    { width: 640, quality: 76 },
    { width: 560, quality: 70 },
    { width: 480, quality: 64 },
    { width: 420, quality: 56 },
  ];
  let last = null;
  for (const profile of profiles) {
    const height = Math.round(profile.width / ratio);
    const bytes = await sharp(baseTile)
      .resize({ width: profile.width, height, fit: "cover", position: "centre" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: profile.quality, chromaSubsampling: "4:2:0", mozjpeg: true })
      .toBuffer();
    last = { bytes, width: profile.width, height };
    if (bytes.length <= maxBytes) return last;
  }
  if (last?.bytes.length <= maxBytes) return last;
  throw new Error(`PUBLIC_TILE_BUDGET_EXCEEDED:${last?.bytes.length || 0}:${maxBytes}`);
}

export function assertPublicGenerationResponseBudget(content) {
  const sizeBytes = Buffer.byteLength(JSON.stringify(content));
  if (sizeBytes > PUBLIC_GENERATION_RESPONSE_MAX_BYTES) {
    throw new Error(`PUBLIC_RESPONSE_BUDGET_EXCEEDED:${sizeBytes}:${PUBLIC_GENERATION_RESPONSE_MAX_BYTES}`);
  }
  return sizeBytes;
}

function cleanModel(value, fallback) {
  const model = String(value || fallback).trim();
  if (!/^[A-Za-z0-9_.:-]{3,120}$/.test(model)) throw new TypeError("MODEL_ID_INVALID");
  return model;
}

function requestConfig(request) {
  const authorization = String(request.headers.authorization || "");
  const apiKey = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (apiKey.length < 8) throw new TypeError("ARK_API_KEY_REQUIRED");
  return {
    apiKey,
    textModel: cleanModel(request.headers["x-xiaoshimei-text-model"], DEFAULT_TEXT_MODEL),
    imageModel: cleanModel(request.headers["x-xiaoshimei-image-model"], DEFAULT_IMAGE_MODEL),
  };
}

function routeName(request) {
  const value = Array.isArray(request.query?.route) ? request.query.route[0] : request.query?.route;
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function send(response, status, body) {
  response.status(status).setHeader("cache-control", "no-store").json(body);
}

async function arkPost(path, apiKey, body, stage) {
  let upstream;
  try {
    upstream = await fetch(`${ARK_BASE_URL}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
  } catch (error) {
    throw new Error(`${stage}:NETWORK_FETCH_FAILED:${String(error?.name || "UNKNOWN")}`);
  }
  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const providerError = payload?.error || payload || {};
    const code = String(providerError.code || `HTTP_${upstream.status}`).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
    const message = String(providerError.message || "").replace(/[\r\n\t]+/g, " ").slice(0, 220);
    throw new Error(`${stage}:${code}${message ? `:${message}` : ""}`);
  }
  return payload;
}

async function imagePayload(payload) {
  const decoded = decodeArkImage(payload);
  let bytes;
  if (decoded.kind === "base64") bytes = Buffer.from(decoded.value, "base64");
  else {
    const response = await fetch(decoded.value, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`IMAGE_ASSET_DOWNLOAD_${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length < 1024) throw new Error("ARK_IMAGE_TOO_SMALL");
  const info = inspectImageBytes(bytes);
  if (!isThreeByFourImage(info)) throw new Error(`ARK_IMAGE_ASPECT_RATIO_INVALID:${info.width}x${info.height}`);
  return {
    bytes,
    info,
    dataUrl: `data:${info.mime};base64,${bytes.toString("base64")}`,
    sha256: sha256Bytes(bytes),
  };
}

async function generateTextDraft(input, settings) {
  let draft;
  let finalError;
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const qualityFeedback = finalError ? textQualityRetryGuidance(finalError) : "";
    const result = await arkPost("/responses", settings.apiKey, buildArkDraftTextRequest({ ...input, quality_feedback: qualityFeedback }, settings.textModel), "TEXT_DRAFT_MODEL_CALL_FAILED");
    try {
      draft = extractArkTextDraft(result, { topic: input.topic, pillar: input.pillar, goal: input.goal });
      attempts.push({ attempt, status: "PASS" });
      break;
    } catch (error) {
      finalError = error;
      attempts.push({ attempt, status: "REJECTED", rejection_code: String(error?.message || error).slice(0, 180) });
    }
  }
  if (!draft) throw finalError || new Error("TEXT_DRAFT_REJECTED");
  const runId = `text-web-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return {
    schema: TEXT_DRAFT_RESPONSE_SCHEMA,
    draft_id: runId,
    created_at: new Date().toISOString(),
    source_input: input.topic,
    content_type: draft.contentType,
    ...(input.profile_contract.style_lock ? { style_lock: input.profile_contract.style_lock } : {}),
    text_requirements: input.text_requirements || "",
    prompt_context: input.prompt_context,
    pillar: input.pillar,
    goal: input.goal,
    titles: draft.titles,
    selected_title: draft.selectedTitle,
    body: draft.body,
    tags: draft.tags,
    recommended_image_count: draft.recommendedImageCount,
    facts: draft.facts,
    risks: draft.risks,
    quality_repairs: draft.qualityRepairs || [],
    generation: { provider: "volcengine-ark", text_model: settings.textModel, status: "TEXT_READY_FOR_USER_CONFIRMATION", attempts },
  };
}

export async function splitMotherSheetForUnits(bytes, jobOrUnits, options = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1024) throw new TypeError("MOTHER_SHEET_BYTES_INVALID");
  const job = Array.isArray(jobOrUnits) ? { template: "grid-3x3", units: jobOrUnits } : jobOrUnits;
  const units = job?.units;
  if (!Array.isArray(units) || units.length < 1 || units.length > 9) throw new TypeError("MOTHER_SHEET_UNITS_INVALID");
  const maxBytes = Math.max(32_000, Number(options.maxBytes) || 160_000);
  const allowMissing = options.allowMissing === true;
  const metadata = await sharp(bytes).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height || Math.abs(width / height - .75) > .01) {
    throw new Error(`MOTHER_SHEET_ASPECT_RATIO_INVALID:${width}x${height}`);
  }
  let adaptiveKv = null;
  if (job?.template === "kv-top-3x2") {
    const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    adaptiveKv = detectKvTemplateRegions({ data: new Uint8Array(raw.data), width: raw.info.width, height: raw.info.height, channels: raw.info.channels });
    if (!adaptiveKv) {
      if (!allowMissing) throw new Error("MOTHER_SHEET_KV_BOUNDARY_NOT_FOUND");
      return units.map((unit, index) => ({
        unit_id: unit.unit_id,
        page_index: unit.page_index,
        panel_index: unit.panel_index,
        missing: true,
        mother_sheet_slot: index === 0 ? 1 : index + 6,
        mother_sheet_region_role: index === 0 ? "kv-top-adaptive-9:8" : "illustration-adaptive-3:4",
        presence_gate: { hasVisibleSubject: false, reason: "KV_BOUNDARY_NOT_FOUND" },
      }));
    }
  }
  return Promise.all(units.map(async (unit, index) => {
    const adaptiveRegion = adaptiveKv?.regions[index];
    const region = adaptiveRegion
      ? { ...adaptiveRegion, slotIndex: index === 0 ? 0 : index + 5, regionRole: index === 0 ? "kv-top-adaptive-9:8" : "illustration-adaptive-3:4" }
      : motherSheetRegionForUnit(width, height, job, index);
    const { slotIndex, regionRole, ...cropRegion } = region;
    const preferredAspect = regionRole.includes("kv-top") ? "9:8" : "3:4";
    let baseTile = await sharp(bytes).extract(cropRegion).png().toBuffer();
    const rawTile = await sharp(baseTile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const cleaned = cleanupGeneratedGridArtifacts({ data: new Uint8Array(rawTile.data), width: rawTile.info.width, height: rawTile.info.height, channels: rawTile.info.channels }, { kv: regionRole === "kv-2x2-3:4" });
    let cleanedPipeline = sharp(Buffer.from(cleaned.data), { raw: { width: cleaned.width, height: cleaned.height, channels: cleaned.channels } });
    if (preferredAspect === "3:4") {
      const insets = detectUniformEdgeInsets(cleaned);
      const exact = exactThreeByFourCrop(cleaned.width, cleaned.height, insets);
      cleanedPipeline = cleanedPipeline.extract(exact);
    }
    baseTile = await cleanedPipeline.png().toBuffer();
    const quality = inspectMotherSheetTileStats(await sharp(baseTile).stats());
    if (!quality.hasVisibleSubject) {
      if (!allowMissing) throw new Error(`MOTHER_SHEET_UNIT_MISSING:${unit.unit_id}`);
      return {
        unit_id: unit.unit_id,
        page_index: unit.page_index,
        panel_index: unit.panel_index,
        missing: true,
        mother_sheet_slot: slotIndex + 1,
        mother_sheet_region_role: regionRole,
        presence_gate: quality,
      };
    }
    const tile = await encodeTileForPublicTransport(baseTile, preferredAspect, maxBytes);
    const tileBytes = tile.bytes;
    const finalRaw = await sharp(tileBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixelGate = inspectMotherSheetTilePixels({ data: new Uint8Array(finalRaw.data), width: finalRaw.info.width, height: finalRaw.info.height, channels: finalRaw.info.channels }, { expectedAspect: preferredAspect });
    if (!pixelGate.hasCleanEdges) {
      if (!allowMissing) throw new Error(`MOTHER_SHEET_TILE_CONTAMINATED:${unit.unit_id}:${pixelGate.contaminatedSides.join("+") || "ASPECT"}`);
      return {
        unit_id: unit.unit_id, page_index: unit.page_index, panel_index: unit.panel_index, missing: true,
        mother_sheet_slot: slotIndex + 1, mother_sheet_region_role: regionRole,
        presence_gate: quality, pixel_gate: pixelGate,
      };
    }
    return {
      unit_id: unit.unit_id,
      page_index: unit.page_index,
      panel_index: unit.panel_index,
      src: `data:image/jpeg;base64,${tileBytes.toString("base64")}`,
      sha256: sha256Bytes(tileBytes),
      size_bytes: tileBytes.length,
      width: tile.width,
      height: tile.height,
      media_role: unit.media_role,
      preferred_aspect: preferredAspect,
      fit_policy: unit.fit_policy,
      edge_trim: { left: 0, right: 0, top: 0, bottom: 0 },
      aspect_crop: { left: 0, top: 0, width: tile.width, height: tile.height },
      mother_sheet_slot: slotIndex + 1,
      mother_sheet_region_role: regionRole,
      presence_gate: quality,
      pixel_gate: pixelGate,
      ...(adaptiveKv ? { adaptive_boundary: adaptiveKv.boundary } : {}),
    };
  }));
}

export function buildMissingUnitRepairJobs(units, startIndex = 0) {
  if (!Array.isArray(units) || units.length < 1) return [];
  const jobs = [];
  const kvUnits = units.filter((unit) => unit?.page_index === 0 && unit?.panel_index == null && unit?.preferred_aspect === "9:8");
  const regularUnits = units.filter((unit) => !kvUnits.includes(unit));
  kvUnits.forEach((unit) => jobs.push({
    sheet_index: startIndex + jobs.length,
    sheet_id: `mother-sheet-repair-${startIndex + jobs.length + 1}`,
    template: "kv-top-3x2",
    kv_unit_index: 0,
    unit_labels: ["KV"],
    units: [structuredClone(unit)],
    repair: true,
  }));
  for (let index = 0; index < regularUnits.length; index += 3) {
    const batch = regularUnits.slice(index, index + 3);
    jobs.push({
      sheet_index: startIndex + jobs.length,
      sheet_id: `mother-sheet-repair-${startIndex + jobs.length + 1}`,
      template: "grid-3x3",
      kv_unit_index: null,
      unit_labels: batch.map((_unit, offset) => `补${offset + 1}`),
      units: structuredClone(batch),
      repair: true,
    });
  }
  return jobs;
}

export function buildStandaloneRepairPrompt(unit, { styleLock = null, imageContext = null } = {}) {
  if (!unit || typeof unit !== "object" || Array.isArray(unit) || !String(unit.unit_id || "").trim()) throw new TypeError("STANDALONE_REPAIR_UNIT_INVALID");
  const action = String(unit.visual_action || "").trim() || "小师妹完成与本页主题一致的清楚动作";
  const detail = String(unit.image_prompt || "").trim() || "东方生活场景，人物动作清楚，构图简洁";
  const preferredAspect = unit.preferred_aspect === "9:8" ? "9:8" : "3:4";
  const composition = preferredAspect === "9:8"
    ? "把完整主视觉放在整张3:4画布中央的9:8安全区内，上下只留纯白背景；人物、双手、脚和关键器物必须完整，后续会直接裁出中央9:8区域"
    : "让人物与关键器物完整占据3:4画布中央约58%–72%，头顶、发髻、双手、脚和动作器物都不得出框";
  return [
    "生成一张严格3:4竖幅的单张补图。这不是母图、不是拼图、不是网格，也没有其他待填区域；整张画布只表现下面这一个动作。",
    `${composition}。背景必须为视觉上接近#FFFFFF的连续纯白，不出现相框式白边、彩色底、阴影卡片、分隔线或空白占位格。`,
    "画面只出现同一位小师妹：黑色高发髻、红色长发带、米白盘扣上衣、红色灯笼裤、米白布鞋；不得出现标题、正文、数字、字母、标志、水印、UI或对话框。",
    `唯一动作合同｜${unit.unit_id}｜${action}｜${detail}`,
    styleLock ? `人物与线条风格锁：${JSON.stringify(styleLock)}` : "保持干净线条、东方生活质感和少量朱红暖色点缀。",
    imageContext ? `用户画面要求：${JSON.stringify(imageContext)}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function sliceStandaloneRepairForUnit(bytes, unit, options = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1024) throw new TypeError("STANDALONE_REPAIR_BYTES_INVALID");
  if (!unit || typeof unit !== "object" || Array.isArray(unit) || !String(unit.unit_id || "").trim()) throw new TypeError("STANDALONE_REPAIR_UNIT_INVALID");
  const maxBytes = Math.max(32_000, Number(options.maxBytes) || 160_000);
  const allowMissing = options.allowMissing === true;
  const metadata = await sharp(bytes).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height || Math.abs(width / height - .75) > .01) throw new Error(`STANDALONE_REPAIR_ASPECT_RATIO_INVALID:${width}x${height}`);
  const preferredAspect = unit.preferred_aspect === "9:8" ? "9:8" : "3:4";
  const crop = preferredAspect === "9:8"
    ? { left: 0, top: Math.max(0, Math.floor((height - Math.round(width / (9 / 8))) / 2)), width, height: Math.min(height, Math.round(width / (9 / 8))) }
    : { left: 0, top: 0, width, height };
  const baseTile = await sharp(bytes).flatten({ background: "#ffffff" }).extract(crop).png().toBuffer();
  const quality = inspectMotherSheetTileStats(await sharp(baseTile).stats());
  const missing = (reason, pixelGate = null) => ({
    unit_id: unit.unit_id, page_index: unit.page_index, panel_index: unit.panel_index, missing: true,
    mother_sheet_slot: 1, mother_sheet_region_role: `standalone-repair-${preferredAspect}`, presence_gate: quality,
    ...(pixelGate ? { pixel_gate: pixelGate } : {}), repair_failure_reason: reason,
  });
  if (!quality.hasVisibleSubject) {
    if (allowMissing) return missing("VISUAL_SUBJECT_MISSING");
    throw new Error(`STANDALONE_REPAIR_UNIT_MISSING:${unit.unit_id}`);
  }
  const tile = await encodeTileForPublicTransport(baseTile, preferredAspect, maxBytes);
  const finalRaw = await sharp(tile.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelGate = inspectMotherSheetTilePixels({ data: new Uint8Array(finalRaw.data), width: finalRaw.info.width, height: finalRaw.info.height, channels: finalRaw.info.channels }, { expectedAspect: preferredAspect });
  if (!pixelGate.hasCleanEdges) {
    if (allowMissing) return missing(`CONTAMINATED:${pixelGate.contaminatedSides.join("+") || "ASPECT"}`, pixelGate);
    throw new Error(`STANDALONE_REPAIR_TILE_CONTAMINATED:${unit.unit_id}:${pixelGate.contaminatedSides.join("+") || "ASPECT"}`);
  }
  return {
    unit_id: unit.unit_id, page_index: unit.page_index, panel_index: unit.panel_index,
    src: `data:image/jpeg;base64,${tile.bytes.toString("base64")}`,
    sha256: sha256Bytes(tile.bytes), size_bytes: tile.bytes.length, width: tile.width, height: tile.height,
    media_role: unit.media_role, preferred_aspect: preferredAspect, fit_policy: unit.fit_policy,
    edge_trim: { left: 0, right: 0, top: 0, bottom: 0 },
    aspect_crop: { left: crop.left, top: crop.top, width: crop.width, height: crop.height },
    mother_sheet_slot: 1, mother_sheet_region_role: `standalone-repair-${preferredAspect}`,
    presence_gate: quality, pixel_gate: pixelGate, repair_source: "standalone-image",
  };
}

async function generateImages(input, settings, request) {
  if (input.resume_run_id) throw new TypeError("PUBLIC_RESUME_NOT_SUPPORTED_RETRY_CURRENT_NODE");
  const pageCount = input.image_count === "AUTO" ? input.draft.recommended_image_count : input.image_count;
  let pages;
  let planError;
  const planAttempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const qualityFeedback = planError ? pagePlanRetryGuidance(planError) : "";
    const result = await arkPost("/responses", settings.apiKey, buildArkPagePlanRequest(input.draft, pageCount, settings.textModel, qualityFeedback, input.production_mode, input.reference_note), "PAGE_PLAN_MODEL_CALL_FAILED");
    try {
      pages = extractArkPagePlan(result, pageCount, { topic: input.draft.source_input, pillar: input.draft.pillar, goal: input.draft.goal, productionMode: input.production_mode, repairEyeCareEvidence: attempt === 3 });
      assertXhsPublishQuality(pages.map((page) => ({
        page_role: page.pageRole,
        eyebrow: page.eyebrow,
        title: page.title,
        body: page.body,
        info_panels: page.panels.map((panel) => ({ title: panel.title, body: panel.body, content_role: panel.contentRole })),
      })), { pillar: input.draft.pillar, publishBody: input.draft.body });
      planAttempts.push({ attempt, status: "PASS" });
      break;
    } catch (error) {
      planError = error;
      planAttempts.push({ attempt, status: "REJECTED", rejection_code: String(error?.message || error).slice(0, 180) });
    }
  }
  if (!pages) throw planError || new Error("PAGE_PLAN_REJECTED");

  const units = buildIllustrationUnits(pages);
  const jobs = groupIllustrationUnits(units);
  const tileBudget = publicTileBudgetForResponse(units.length);
  const extraReferences = input.reference_images.map((item) => item.data_url);
  const sheets = [];
  const standaloneRepairTiles = [];
  let actualImageCalls = 0;
  for (const job of jobs) {
    const prompt = buildMotherSheetPrompt(job, { styleLock: input.draft.style_lock, imageContext: input.draft.prompt_context });
    const payload = await arkPost("/images/generations", settings.apiKey, buildArkImageRequest({ model: settings.imageModel, prompt, referenceImageDataUrl: XIAOSHIMEI_AVATAR_DATA_URL, actionReferenceImageDataUrls: extraReferences, actionReferenceNote: input.reference_note }), `MOTHER_SHEET_${job.sheet_index + 1}_CALL_FAILED`);
    actualImageCalls += 1;
    const sheet = { job, ...(await imagePayload(payload)) };
    sheet.tiles = await splitMotherSheetForUnits(sheet.bytes, job, { maxBytes: tileBudget, allowMissing: true });
    sheets.push(sheet);
  }

  const missingUnitIds = new Set(sheets.flatMap((sheet) => sheet.tiles.filter((tile) => tile.missing).map((tile) => tile.unit_id)));
  const repairJobs = buildMissingUnitRepairJobs(units.filter((unit) => missingUnitIds.has(unit.unit_id)), sheets.length);
  const groupedRepairJobs = repairJobs.filter((job) => job.units.length > 1);
  for (const job of groupedRepairJobs) {
    const prompt = buildMotherSheetPrompt(job, { styleLock: input.draft.style_lock, imageContext: input.draft.prompt_context });
    const payload = await arkPost("/images/generations", settings.apiKey, buildArkImageRequest({ model: settings.imageModel, prompt, referenceImageDataUrl: XIAOSHIMEI_AVATAR_DATA_URL, actionReferenceImageDataUrls: extraReferences, actionReferenceNote: input.reference_note }), `MOTHER_SHEET_REPAIR_${job.sheet_index + 1}_CALL_FAILED`);
    actualImageCalls += 1;
    const sheet = { job, ...(await imagePayload(payload)) };
    sheet.tiles = await splitMotherSheetForUnits(sheet.bytes, job, { maxBytes: tileBudget, allowMissing: true });
    sheets.push(sheet);
  }

  const repairedUnitIds = new Set(sheets.flatMap((sheet) => sheet.tiles.filter((tile) => !tile.missing).map((tile) => tile.unit_id)));
  const standaloneRepairUnits = units.filter((unit) => missingUnitIds.has(unit.unit_id) && !repairedUnitIds.has(unit.unit_id));
  for (const unit of standaloneRepairUnits) {
    const prompt = buildStandaloneRepairPrompt(unit, { styleLock: input.draft.style_lock, imageContext: input.draft.prompt_context });
    const payload = await arkPost("/images/generations", settings.apiKey, buildArkImageRequest({ model: settings.imageModel, prompt, referenceImageDataUrl: XIAOSHIMEI_AVATAR_DATA_URL, actionReferenceImageDataUrls: extraReferences, actionReferenceNote: input.reference_note }), `STANDALONE_REPAIR_${unit.unit_id}_CALL_FAILED`);
    actualImageCalls += 1;
    const image = await imagePayload(payload);
    standaloneRepairTiles.push(await sliceStandaloneRepairForUnit(image.bytes, unit, { maxBytes: tileBudget, allowMissing: true }));
  }

  const unresolvedUnitIds = standaloneRepairTiles.filter((tile) => tile.missing).map((tile) => tile.unit_id);
  if (unresolvedUnitIds.length) {
    const error = new Error(`MOTHER_SHEET_REPAIR_EXHAUSTED:${unresolvedUnitIds.join(",")}`);
    error.details = {
      completed_units: units.length - unresolvedUnitIds.length,
      total_units: units.length,
      missing_unit_ids: unresolvedUnitIds,
      actual_image_calls: actualImageCalls,
      estimated_image_cost_cny: Number((actualImageCalls * IMAGE_PRICE_CNY).toFixed(2)),
      retry_scope: "MISSING_UNITS_ONLY_NOT_YET_IMPLEMENTED_ON_PUBLIC_RUNTIME",
    };
    throw error;
  }

  const assetByUnit = new Map();
  for (const sheet of sheets) {
    sheet.tiles.filter((tile) => !tile.missing).forEach((tile) => assetByUnit.set(tile.unit_id, {
      src: tile.src,
      sha256: tile.sha256,
      size_bytes: tile.size_bytes,
      sheet_index: sheet.job.sheet_index,
      slot_index: tile.mother_sheet_slot - 1,
    }));
  }
  standaloneRepairTiles.filter((tile) => !tile.missing).forEach((tile) => assetByUnit.set(tile.unit_id, {
    src: tile.src,
    sha256: tile.sha256,
    size_bytes: tile.size_bytes,
    sheet_index: null,
    slot_index: 0,
  }));
  const pageAssets = pages.map((page, pageIndex) => (page.panels || []).length
    ? undefined
    : assetByUnit.get(units.find((unit) => unit.page_index === pageIndex && unit.panel_index == null)?.unit_id)?.src);
  const panelAssetsByPage = pages.map((page, pageIndex) => (page.panels || []).map((_panel, panelIndex) => assetByUnit.get(units.find((unit) => unit.page_index === pageIndex && unit.panel_index === panelIndex)?.unit_id)?.src));
  let content = assembleArkContentFromDraft(input.draft, pages, { pageAssets, panelAssetsByPage }, { textModel: settings.textModel, imageModel: settings.imageModel, motherSheetCount: sheets.length, illustrationUnitCount: units.length, enforcePublishQuality: true }, input.production_mode);
  content = {
    ...content,
    pages: content.pages.map((page, pageIndex) => {
      const pageUnit = units.find((unit) => unit.page_index === pageIndex && unit.panel_index == null);
      const pageAsset = assetByUnit.get(pageUnit?.unit_id);
      return {
        ...page,
        image_style: pageAsset ? { ...page.image_style, src: pageAsset.src, crop: { x: 0, y: 0, width: 1, height: 1 } } : page.image_style,
        info_panels: (page.info_panels || []).map((panel, panelIndex) => {
          const unit = units.find((candidate) => candidate.page_index === pageIndex && candidate.panel_index === panelIndex);
          const asset = assetByUnit.get(unit?.unit_id);
          return asset ? { ...panel, image_style: { ...panel.image_style, src: asset.src, crop: { x: 0, y: 0, width: 1, height: 1 } } } : panel;
        }),
      };
    }),
    generation: {
      ...content.generation,
      run_id: `images-web-${Date.now()}-${randomUUID().slice(0, 8)}`,
      strategy: "3x3_mother_sheet_server_tiles",
      mother_sheet_count: sheets.length,
      illustration_unit_count: units.length,
      actual_image_calls: actualImageCalls,
      estimated_image_cost_cny: Number((actualImageCalls * IMAGE_PRICE_CNY).toFixed(2)),
      page_plan_attempts: planAttempts,
      mother_sheet_sha256: sheets.map((sheet) => sheet.sha256),
      tile_sha256: [...sheets.flatMap((sheet) => sheet.tiles.filter((tile) => !tile.missing).map((tile) => tile.sha256)), ...standaloneRepairTiles.filter((tile) => !tile.missing).map((tile) => tile.sha256)],
      tile_transport_budget_bytes: tileBudget,
      repaired_missing_unit_count: missingUnitIds.size,
      repair_mother_sheet_count: groupedRepairJobs.length,
      standalone_repair_count: standaloneRepairTiles.length,
      standalone_repair_sha256: standaloneRepairTiles.filter((tile) => !tile.missing).map((tile) => tile.sha256),
    },
  };
  const responseSizeBytes = assertPublicGenerationResponseBudget(content);
  content.generation.response_size_bytes = responseSizeBytes;
  assertPublicGenerationResponseBudget(content);
  return parseContentPackage(JSON.stringify(content));
}

async function generatePageCandidates(input, settings) {
  const candidates = await Promise.all([0, 1, 2].map(async (index) => {
    const prompt = buildArkPageCandidatePrompt(input, index);
    const payload = await arkPost("/images/generations", settings.apiKey, buildArkImageRequest({ model: settings.imageModel, prompt, referenceImageDataUrl: XIAOSHIMEI_AVATAR_DATA_URL }), "PAGE_CANDIDATE_IMAGE_CALL_FAILED");
    const image = await imagePayload(payload);
    return { src: image.dataUrl, sha256: image.sha256, size_bytes: image.bytes.length, width: image.info.width, height: image.info.height };
  }));
  return { schema: PAGE_CANDIDATE_RESPONSE_SCHEMA, run_id: `candidate-web-${Date.now()}-${randomUUID().slice(0, 8)}`, candidates };
}

export default async function handler(request, response) {
  const route = routeName(request);
  if (request.method === "GET" && route === "health") return send(response, 200, { status: "AWAITING_BYOK", configured: false, provider: "volcengine-ark", provider_label: "火山方舟", key_store: "当前标签页 sessionStorage" });
  if (request.method === "GET" && route === "config") return send(response, 200, { configured: false, provider: "volcengine-ark", provider_label: "火山方舟", base_url: ARK_BASE_URL, text_model: DEFAULT_TEXT_MODEL, image_model: DEFAULT_IMAGE_MODEL, key_store: "当前标签页 sessionStorage" });
  if (request.method !== "POST") return send(response, 405, { error: "METHOD_NOT_ALLOWED" });
  try {
    const settings = requestConfig(request);
    if (route === "text-draft") return send(response, 200, await generateTextDraft(parseTextDraftRequest(request.body), settings));
    if (route === "generate-images") return send(response, 200, await generateImages(parseImageGenerationRequest(request.body), settings, request));
    if (route === "page-candidates") return send(response, 200, await generatePageCandidates(parsePageCandidateRequest(request.body), settings, request));
    return send(response, 404, { error: "ROUTE_NOT_FOUND" });
  } catch (error) {
    const code = String(error?.message || error || "PROVIDER_FAILED").slice(0, 360);
    const status = code.includes("API_KEY_REQUIRED") ? 401 : code.includes("INVALID") || error instanceof TypeError ? 400 : 422;
    return send(response, status, { error: "ARK_PROBE_FAILED", code, stage: route === "text-draft" ? "text" : "image", ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}) });
  }
}
