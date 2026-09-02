import assert from "node:assert/strict";
import test from "node:test";
import { generationFailureFeedback, providerHealthState } from "../src/generation-feedback.mjs";

test("generation failures become persistent human-readable recovery states", () => {
  assert.equal(generationFailureFeedback(new Error("Ark function arguments are not valid JSON")).code, "MODEL_FORMAT_REJECTED");
  const imageJson = generationFailureFeedback(Object.assign(new Error("provider request failed: Ark function arguments are not valid JSON"), { providerStage: "image" }));
  assert.equal(imageJson.title, "分镜结构没有通过校验");
  assert.match(imageJson.detail, /¥0\.00/);
  assert.match(imageJson.detail, /图片模型尚未调用/);
  assert.equal(generationFailureFeedback(new Error("TEXT_QUALITY_GATE_FAILED:pages[1].body:too_short")).code, "COPY_TOO_SHORT");
  const lengthFailure = generationFailureFeedback(Object.assign(new Error("provider request failed: TEXT_QUALITY_GATE_FAILED:body:length"), { providerCode: "TEXT_QUALITY_GATE_FAILED:body:length", providerStage: "text" }));
  assert.equal(lengthFailure.code, "COPY_LENGTH_REJECTED");
  assert.equal(lengthFailure.technical_code, "TEXT_QUALITY_GATE_FAILED:body:length");
  assert.equal(lengthFailure.stage, "text");
  const networkFailure = generationFailureFeedback(Object.assign(new Error("provider request failed: PAGE_PLAN_MODEL_CALL_FAILED:NETWORK_FETCH_FAILED:UND_ERR_CONNECT_TIMEOUT"), { providerCode: "PAGE_PLAN_MODEL_CALL_FAILED:NETWORK_FETCH_FAILED:UND_ERR_CONNECT_TIMEOUT", providerStage: "image" }));
  assert.equal(networkFailure.code, "ARK_NETWORK_UNAVAILABLE");
  assert.equal(networkFailure.stage, "image");
  assert.match(networkFailure.detail, /本机工作台正常/);
  const pagePlan = generationFailureFeedback(new Error("TEXT_QUALITY_GATE_FAILED:pages[0].image_prompt:action_not_visually_demonstrated"));
  assert.equal(pagePlan.code, "IMAGE_PLAN_REJECTED");
  assert.match(pagePlan.detail, /发布文案仍然有效/);
  assert.equal(generationFailureFeedback(new DOMException("aborted", "AbortError")).code, "GENERATION_TIMEOUT");
});

test("planner-only terminal failure says image calls are zero and requires an explicit adjusted restart", () => {
  const feedback = generationFailureFeedback(Object.assign(new Error("IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS"), {
    providerCode: "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS",
    providerStage: "image",
  }));
  assert.equal(feedback.code, "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS");
  assert.equal(feedback.recovery_action, "EDIT_VISUAL_INPUTS_THEN_RESTART");
  assert.equal(feedback.expected_image_upstream_calls_so_far, 0);
  assert.equal(feedback.direct_paid_retry_allowed, true);
  assert.match(feedback.title, /图片还没开始/);
  assert.match(feedback.detail, /页数与画面设置已经重新开放/);
  assert.match(feedback.detail, /付费图片步骤/);
  assert.equal(feedback.retry_label, "调整后重新规划并生成");
});

test("quality gate failures report the actual content problem instead of blaming Ark connectivity", () => {
  const hook = generationFailureFeedback(Object.assign(new Error("provider request failed: TEXT_QUALITY_GATE_FAILED:titles:cheap_or_unverifiable_hook:不用复杂工具"), { providerCode: "TEXT_QUALITY_GATE_FAILED:titles:cheap_or_unverifiable_hook:不用复杂工具", providerStage: "text" }));
  assert.equal(hook.code, "CHEAP_HOOK_REJECTED");
  assert.match(hook.title, /标题/);
  assert.doesNotMatch(hook.title, /火山/);
  const procedure = generationFailureFeedback(new Error("TEXT_QUALITY_GATE_FAILED:wellness:missing_procedure"));
  assert.equal(procedure.code, "WELLNESS_PROCEDURE_MISSING");
  assert.match(procedure.detail, /三步|顺序动作/);
});

test("provider health distinguishes content rejection from connectivity failure", () => {
  assert.equal(providerHealthState({ configured: true, status: "FAIL_CLOSED", last_error: "TEXT_QUALITY_GATE_FAILED:wellness:missing_procedure" }), "UNVERIFIED");
  assert.equal(providerHealthState({ configured: true, status: "FAIL_CLOSED", last_error: "TEXT_QUALITY_GATE_FAILED:wellness:missing_procedure", last_success_at: "2026-08-23T00:00:00Z" }), "ONLINE");
  assert.equal(providerHealthState({ configured: true, status: "FAIL_CLOSED", last_error: "PAGE_PLAN_MODEL_CALL_FAILED:NETWORK_FETCH_FAILED:UND_ERR_CONNECT_TIMEOUT" }), "DEGRADED");
  assert.equal(providerHealthState({ configured: true, status: "TEXT_READY", last_error: null }), "UNVERIFIED");
  assert.equal(providerHealthState({ configured: true, status: "TEXT_READY", last_error: null, last_success_at: "2026-08-23T00:00:00Z" }), "ONLINE");
  assert.equal(providerHealthState({ configured: true, status: "CONFIGURED_UNVERIFIED", last_success_at: null }), "UNVERIFIED");
  assert.equal(providerHealthState({ configured: true, status: "READY_FOR_USE", last_success_at: null }), "ONLINE");
  assert.equal(providerHealthState({ configured: false, status: "NOT_CONFIGURED" }), "OFFLINE");
});

test("partial image failures tell the user exactly what is preserved and what resume will do", () => {
  const error = new Error("IMAGE_3_QA_REJECTED:HAND_INVALID");
  error.providerDetails = { resume_run_id: "images-2026-08-15T00-00-00-000Z-1234abcd", completed_pages: 2, total_pages: 4, failed_page: 3, actual_image_calls: 3, estimated_image_cost_cny: 0.66 };
  const feedback = generationFailureFeedback(error);
  assert.equal(feedback.code, "IMAGE_PARTIAL_RESULT_PRESERVED");
  assert.equal(feedback.title, "已保留 2/4 张图片");
  assert.match(feedback.detail, /第 3 张/);
  assert.match(feedback.detail, /¥0\.66/);
  assert.match(feedback.detail, /不会重新生成前 2 张/);
});

test("partial mother-sheet failures report paid calls instead of pretending they are final pages", () => {
  const error = new Error("MOTHER_SHEET_2_CALL_FAILED");
  error.providerDetails = { resume_run_id: "images-2026-08-23T00-00-00-000Z-abcd1234", completed_pages: 4, total_pages: 6, completed_mother_sheets: 1, total_mother_sheets: 2, failed_mother_sheet: 2, actual_image_calls: 1, estimated_image_cost_cny: 0.22 };
  const feedback = generationFailureFeedback(error);
  assert.equal(feedback.title, "已保留 1/2 张母图");
  assert.match(feedback.detail, /第 2 张母图/);
  assert.match(feedback.detail, /¥0\.22/);
});

test("public step failures discover the same paid operation instead of offering a paid replay", () => {
  const error = new Error("provider request failed: MOTHER_SHEET_2_CALL_FAILED");
  error.providerStage = "image";
  error.providerDetails = { resume_run_id: "images-2026-08-31T08-00-00-000Z-abcdef12", completed_pages: 2, total_pages: 4, completed_image_steps: 1, total_image_steps: 3, failed_image_step: 2, actual_image_calls: 2, estimated_image_cost_cny: 0.44, current_step_may_replay: true };
  const feedback = generationFailureFeedback(error);
  assert.equal(feedback.code, "IMAGE_PARTIAL_RESULT_PRESERVED");
  assert.match(feedback.title, /1\/3/);
  assert.match(feedback.detail, /发现|恢复.*同一/);
  assert.doesNotMatch(feedback.detail, /可能再产生一次图片调用|可以重新生成|点击.*重新生成|直接重试/);
  assert.equal(feedback.recovery_action, "DISCOVER_EXISTING_OPERATION");
  assert.equal(feedback.expected_upstream_calls, 0);
  assert.equal(feedback.direct_paid_retry_allowed, false);
});

test("image ledger and local media failures expose distinct, bounded recovery contracts", () => {
  const cases = [
    ["UNKNOWN", "DISCOVER_EXISTING_OPERATION", 0, true],
    ["IN_FLIGHT", "WAIT_AND_DISCOVER_EXISTING_OPERATION", 0, true],
    ["READY_RESPONSE_LOST", "READ_CACHED_RESULT", 0, true],
    ["EXPIRY_WINDOW_TOO_SHORT", "REAUTHENTICATE_THEN_DISCOVER", 0, true],
    ["PAID_CAPABILITY_EXPIRING", "REAUTHENTICATE_THEN_DISCOVER", 0, true],
    ["LEDGER_CAPACITY_EXHAUSTED", "WAIT_FOR_CAPACITY_THEN_DISCOVER", 0, true],
    ["IMAGE_LEDGER_RUN_MISSING", "CONFIRM_NOT_FOUND_BEFORE_NEW_OPERATION", 0, false],
    ["LOCAL_MEDIA_WRITE_FAILED", "RESTORE_LOCAL_MEDIA_FROM_CACHED_MANIFEST", 0, true],
    ["LOCAL_MEDIA_MISSING", "RESTORE_LOCAL_MEDIA_OR_BACKUP", 0, false],
    ["REFERENCE_PAYLOAD_TOO_LARGE", "REDUCE_REFERENCES_BEFORE_START", 0, false],
    ["MATERIALIZING", "RESUME_REFERENCE_MATERIALIZATION", 0, true],
  ];
  for (const [code, recoveryAction, expectedCalls, sevenDayRecoverable] of cases) {
    const error = Object.assign(new Error(`provider request failed: ${code}`), { providerCode: code, providerStage: "image" });
    const feedback = generationFailureFeedback(error);
    assert.equal(feedback.code, code);
    assert.equal(feedback.recovery_action, recoveryAction);
    assert.equal(feedback.expected_upstream_calls, expectedCalls);
    assert.equal(feedback.server_recoverable_within_7d, sevenDayRecoverable);
    assert.equal(feedback.direct_paid_retry_allowed, false);
  }
});

test("UNKNOWN, IN_FLIGHT and READY response loss never tell the user to create a new paid operation", () => {
  for (const code of ["UNKNOWN", "IN_FLIGHT", "READY_RESPONSE_LOST"]) {
    const feedback = generationFailureFeedback(Object.assign(new Error(code), { providerCode: code, providerStage: "image" }));
    assert.match(feedback.detail, /同一.*操作|现有.*操作|缓存结果/);
    assert.doesNotMatch(`${feedback.title}${feedback.detail}`, /可以重新生成|点击.*重新生成|新建.*操作|再付费|可能再次扣费|直接重试/);
    assert.equal(feedback.expected_upstream_calls, 0);
    assert.equal(feedback.server_recoverable_within_7d, true);
  }
});

test("raw media transport failures recover the cached operation without another paid image call", () => {
  for (const providerCode of ["IMAGE_MEDIA_FETCH_FAILED", "IMAGE_MEDIA_HEADER_HASH_MISMATCH", "IMAGE_MEDIA_BODY_HASH_MISMATCH"]) {
    const feedback = generationFailureFeedback({ providerCode, providerStage: "image" });
    assert.equal(feedback.code, "READY_RESPONSE_LOST");
    assert.equal(feedback.recovery_action, "READ_CACHED_RESULT");
    assert.equal(feedback.expected_upstream_calls, 0);
    assert.equal(feedback.direct_paid_retry_allowed, false);
  }
});
