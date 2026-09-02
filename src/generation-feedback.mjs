export function providerHealthState(health) {
  if (!health || health.configured !== true) return "OFFLINE";
  const status = String(health.status || "");
  const lastError = String(health.last_error || "");
  const hasVerifiedSuccess = Boolean(health.last_success_at);
  if (status === "READY_FOR_USE") return "ONLINE";
  if (status === "CONFIGURED_UNVERIFIED" || status === "READY_FOR_PROBE") return "UNVERIFIED";
  if (status !== "FAIL_CLOSED") return hasVerifiedSuccess || status === "LIVE_VERIFIED" ? "ONLINE" : "UNVERIFIED";
  if (/NETWORK_FETCH_FAILED|UND_ERR|SSL.*timeout|fetch failed|ARK_HTTP_(401|403|408|429|5\d\d)|ModelNotOpen|quota|billing/i.test(lastError)) return "DEGRADED";
  return hasVerifiedSuccess ? "ONLINE" : "UNVERIFIED";
}

const IMAGE_RECOVERY_STATES = Object.freeze({
  UNKNOWN: {
    title: "这次配图操作的状态还不能确认",
    detail: "不要重新生成。请先发现或恢复同一操作；这一步只查询现有账本和缓存，图片上游调用数为 0，七天恢复窗内仍可继续找回结果。",
    recovery_action: "DISCOVER_EXISTING_OPERATION",
    server_recoverable_within_7d: true,
  },
  IN_FLIGHT: {
    title: "同一配图操作仍在处理中",
    detail: "请等待后发现同一操作，不要另开付费步骤。发现操作只读现有进度，图片上游调用数为 0；结果在七天恢复窗内可继续读取。",
    recovery_action: "WAIT_AND_DISCOVER_EXISTING_OPERATION",
    server_recoverable_within_7d: true,
  },
  READY_RESPONSE_LOST: {
    title: "结果已就绪，但刚才的响应丢失了",
    detail: "请读取同一操作的缓存结果，不要重新生成。读取缓存的图片上游调用数为 0，结果在七天恢复窗内可取回。",
    recovery_action: "READ_CACHED_RESULT",
    server_recoverable_within_7d: true,
  },
  EXPIRY_WINDOW_TOO_SHORT: {
    title: "当前登录剩余时间不足以安全完成本步",
    detail: "先重新登录，再发现同一操作。登录和发现不会调用图片上游，现有操作在七天恢复窗内仍可恢复。",
    recovery_action: "REAUTHENTICATE_THEN_DISCOVER",
    server_recoverable_within_7d: true,
  },
  PAID_CAPABILITY_EXPIRING: {
    title: "当前付费能力即将过期",
    detail: "先重新登录，再发现同一操作；不要直接重做本步。该恢复路径图片上游调用数为 0，现有结果在七天恢复窗内可读取。",
    recovery_action: "REAUTHENTICATE_THEN_DISCOVER",
    server_recoverable_within_7d: true,
  },
  LEDGER_CAPACITY_EXHAUSTED: {
    title: "配图恢复账本暂时没有安全容量",
    detail: "系统已在图片上游前停住。等待容量释放后发现同一操作；查询调用数为 0，现有操作在七天恢复窗内仍可读取。",
    recovery_action: "WAIT_FOR_CAPACITY_THEN_DISCOVER",
    server_recoverable_within_7d: true,
  },
  IMAGE_LEDGER_RUN_MISSING: {
    title: "服务器已找不到这次配图操作",
    detail: "本机稿件和媒体仍保留，但服务器七天恢复结果已不可确认。只有明确读到 NOT_FOUND 并冻结本机旧操作后，才允许创建新的配图操作。",
    recovery_action: "CONFIRM_NOT_FOUND_BEFORE_NEW_OPERATION",
    server_recoverable_within_7d: false,
  },
  LOCAL_MEDIA_WRITE_FAILED: {
    title: "结果尚未安全写入本机媒体库",
    detail: "不要重新生成。请从同一操作的缓存清单恢复媒体并再次完成本机校验；恢复图片上游调用数为 0，缓存结果在七天窗口内可取回。",
    recovery_action: "RESTORE_LOCAL_MEDIA_FROM_CACHED_MANIFEST",
    server_recoverable_within_7d: true,
  },
  LOCAL_MEDIA_MISSING: {
    title: "本机缺少这次操作需要的媒体",
    detail: "图片上游尚未被重新调用。请先从本机备份恢复缺失媒体；不能把一个断图稿直接送进新的付费操作。",
    recovery_action: "RESTORE_LOCAL_MEDIA_OR_BACKUP",
    server_recoverable_within_7d: false,
  },
  REFERENCE_PAYLOAD_TOO_LARGE: {
    title: "参考图体积超过安全传输上限",
    detail: "请求已在联网前拦截，图片上游调用数为 0。减少参考图数量或重新压缩后，再从同一文字稿准备操作。",
    recovery_action: "REDUCE_REFERENCES_BEFORE_START",
    server_recoverable_within_7d: false,
  },
  MATERIALIZING: {
    title: "正在补齐同一操作的参考媒体",
    detail: "系统只会继续上传同一 nonce 缺少的已校验媒体，图片上游调用数为 0；不要重新选择参考图或新建操作，七天恢复窗内可继续。",
    recovery_action: "RESUME_REFERENCE_MATERIALIZATION",
    server_recoverable_within_7d: true,
  },
});

function imageRecoveryFeedback(code, meta) {
  const state = IMAGE_RECOVERY_STATES[code];
  if (!state) return null;
  return {
    ...meta,
    stage: "image",
    code,
    title: state.title,
    detail: state.detail,
    recovery_action: state.recovery_action,
    expected_upstream_calls: 0,
    server_recoverable_within_7d: state.server_recoverable_within_7d,
    direct_paid_retry_allowed: false,
  };
}

export function generationFailureFeedback(error) {
  const message = String(error?.message || error || "");
  const technicalCode = String(error?.providerCode || message.replace(/^provider request failed:\s*/i, "") || "GENERATION_FAILED").slice(0, 220);
  const inferredStage = error?.providerStage || (/IMAGE_|PAGE_PLAN|image/i.test(technicalCode) ? "image" : "text");
  const meta = { technical_code: technicalCode, stage: inferredStage, failure_id: error?.failureId || null, failed_at: new Date().toISOString() };
  const resume = error?.providerDetails;
  if (technicalCode === "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS") {
    return {
      ...meta,
      stage: "image",
      code: "IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS",
      title: "分镜规划没有通过，图片还没开始生成",
      detail: "本次图片调用数为 0，当前文字稿和旧画布均已保留，页数与画面设置已经重新开放。调整后点击下方按钮会重新规划，并在规划通过后进入新的付费图片步骤。",
      recovery_action: "EDIT_VISUAL_INPUTS_THEN_RESTART",
      expected_image_upstream_calls_so_far: 0,
      direct_paid_retry_allowed: true,
      retry_label: "调整后重新规划并生成",
    };
  }
  const exactRecoveryCode = Object.keys(IMAGE_RECOVERY_STATES).find((code) => technicalCode === code || technicalCode.startsWith(`${code}:`));
  const exactRecovery = imageRecoveryFeedback(exactRecoveryCode, meta);
  if (exactRecovery) return exactRecovery;
  if (/^IMAGE_MEDIA_(?:FETCH|HEADER|BODY)_/.test(technicalCode)) return imageRecoveryFeedback("READY_RESPONSE_LOST", meta);
  if (resume?.retry_scope === "CHANGE_VISUAL_INPUTS_THEN_RESTART") {
    return { ...meta, stage: "image", code: "IMAGE_REPAIR_EXHAUSTED", title: "剩余插画连续未过切片校验", detail: `已保存 ${resume.completed_pages || 0}/${resume.total_pages || 0} 页可用结果；本轮约发生 ¥${Number(resume.estimated_image_cost_cny || 0).toFixed(2)}。继续点重试不会盲目重复扣费，请先调整画面要求或动作参考，再重新开始配图。` };
  }
  if (resume?.resume_run_id && Number.isInteger(resume.completed_image_steps) && Number.isInteger(resume.total_image_steps)) {
    return { ...meta, stage: "image", code: "IMAGE_PARTIAL_RESULT_PRESERVED", title: `已保存图片步骤 ${resume.completed_image_steps}/${resume.total_image_steps}`, detail: `停在第 ${resume.failed_image_step || resume.completed_image_steps + 1} 步；本轮约发生 ¥${Number(resume.estimated_image_cost_cny || 0).toFixed(2)}。请先发现并恢复同一操作，读取既有 checkpoint 或缓存结果；这一步图片上游调用数为 0，不会重新生成之前步骤。`, recovery_action: "DISCOVER_EXISTING_OPERATION", expected_upstream_calls: 0, server_recoverable_within_7d: true, direct_paid_retry_allowed: false };
  }
  if (resume?.resume_run_id && Number.isInteger(resume.completed_mother_sheets) && Number.isInteger(resume.total_mother_sheets)) {
    return { ...meta, stage: "image", code: "IMAGE_PARTIAL_RESULT_PRESERVED", title: `已保留 ${resume.completed_mother_sheets}/${resume.total_mother_sheets} 张母图`, detail: `停在第 ${resume.failed_mother_sheet || resume.completed_mother_sheets + 1} 张母图；已发生约 ¥${Number(resume.estimated_image_cost_cny || 0).toFixed(2)}。先发现并恢复同一操作，读取已有母图和断点；恢复查询的图片上游调用数为 0。`, recovery_action: "DISCOVER_EXISTING_OPERATION", expected_upstream_calls: 0, server_recoverable_within_7d: true, direct_paid_retry_allowed: false };
  }
  if (resume?.resume_run_id && Number.isInteger(resume.completed_pages) && Number.isInteger(resume.total_pages)) {
    return { ...meta, stage: "image", code: "IMAGE_PARTIAL_RESULT_PRESERVED", title: `已保留 ${resume.completed_pages}/${resume.total_pages} 张图片`, detail: `停在第 ${resume.failed_page || resume.completed_pages + 1} 张；已发生约 ¥${Number(resume.estimated_image_cost_cny || 0).toFixed(2)}。先发现并恢复同一操作，读取已有结果；恢复查询的图片上游调用数为 0，不会重新生成前 ${resume.completed_pages} 张。`, recovery_action: "DISCOVER_EXISTING_OPERATION", expected_upstream_calls: 0, server_recoverable_within_7d: true, direct_paid_retry_allowed: false };
  }
  if (/ModelNotOpen/.test(message)) return { ...meta, code: "MODEL_NOT_OPEN", title: "当前模型尚未开通", detail: "请先在火山方舟开通当前模型；画布和旧稿没有改变。" };
  if (/PAGE_PLAN_MODEL_CALL_FAILED:NETWORK_FETCH_FAILED|fetch failed/i.test(message) && inferredStage === "image") return { ...meta, stage: "image", code: "ARK_NETWORK_UNAVAILABLE", title: "当前网络连不上火山方舟", detail: "本机工作台正常，但配图分镜请求没有到达方舟。本轮没有取得图片调用结果；请检查网络、代理或 VPN，稍后从这里重试。" };
  if (/IMAGE_ASSET_DOWNLOAD_NETWORK_FAILED/i.test(message)) return { ...meta, stage: "image", code: "IMAGE_DOWNLOAD_INTERRUPTED", title: "生成图下载中断", detail: "方舟可能已经返回图片，但本机未能下载完成。不要重新开始整批生成，请从当前断点继续。" };
  if (/NETWORK_FETCH_FAILED|UND_ERR|SSL.*timeout|fetch failed/i.test(message)) return { ...meta, code: "ARK_NETWORK_UNAVAILABLE", title: "火山方舟连接异常", detail: "本机工作台仍正常，旧稿和当前画布均已保留。请检查网络、代理或 VPN 后重试当前节点。" };
  if (/Ark function arguments are not valid JSON|INVALID_JSON|function arguments/i.test(message)) {
    if (inferredStage === "image") return { ...meta, stage: "image", code: "MODEL_FORMAT_REJECTED", title: "分镜结构没有通过校验", detail: "模型返回的分镜 JSON 不完整。发布文字和旧画布都已保留，图片模型尚未调用，本轮图片费用为 ¥0.00；可从当前配图节点重试。" };
    return { ...meta, stage: "text", code: "MODEL_FORMAT_REJECTED", title: "文字格式没有通过校验", detail: "模型返回的文字结构不完整。旧稿已保留，可在这里重试文字。" };
  }
  if (/TEXT_QUALITY_GATE_FAILED:titles:cheap_or_unverifiable_hook/i.test(message)) return { ...meta, stage: "text", code: "CHEAP_HOOK_REJECTED", title: "标题钩子太虚，已拦截", detail: "系统已尝试把标题改成更具体、可验证的表达，但本轮仍未过线。旧稿没有丢；重试会继续围绕主题本身改写，不会调用图片。" };
  if (/TEXT_QUALITY_GATE_FAILED:publish_copy:cheap_or_unverifiable_hook/i.test(message)) return { ...meta, stage: "text", code: "CHEAP_COPY_REJECTED", title: "正文有夸张或不可核验表达", detail: "系统已经做过有界修稿，但仍有低门槛、强效果或主观自证式表达。旧稿已保留；重试文字不会产生图片费用。" };
  if (/TEXT_QUALITY_GATE_FAILED:wellness:missing_procedure/i.test(message)) return { ...meta, stage: "text", code: "WELLNESS_PROCEDURE_MISSING", title: "养生稿缺少清楚步骤", detail: "正文讲了原因或感受，但没有形成至少三步可照做的顺序动作。系统会在重试时优先补齐步骤和停止条件。" };
  if (/TEXT_QUALITY_GATE_FAILED:wellness:missing_safety_boundary/i.test(message)) return { ...meta, stage: "text", code: "WELLNESS_SAFETY_MISSING", title: "养生稿缺少安全边界", detail: "需要明确哪些情况应停止、就医或咨询专业人士。系统会在重试时补齐，而不是放松安全标准。" };
  if (/TEXT_QUALITY_GATE_FAILED.*too_short|body:too_short/i.test(message)) return { ...meta, stage: "text", code: "COPY_TOO_SHORT", title: "正文太短，已拦截", detail: "模型没有写到可发布长度。旧稿已保留；修改原文或补充要求后重试文字。" };
  if (/TEXT_QUALITY_GATE_FAILED.*body:length|body:length/i.test(message)) return { ...meta, stage: "text", code: "COPY_LENGTH_REJECTED", title: "正文长度没有通过校验", detail: "模型连续尝试后仍没有落在可发布长度。旧稿已保留；修改原文或补充要求后重试文字。" };
  if (/PAGE_PLAN|pages\[[0-9]+\].*action|action_not_visually_demonstrated|eye_care_action_not_visible|VISUAL_SUBJECT_MISSING/i.test(message)) return { ...meta, stage: "image", code: "IMAGE_PLAN_REJECTED", title: "分镜描述不够明确", detail: "发布文案仍然有效，图片模型尚未调用。补充动作参考或画面设置后重试图片。" };
  if (/return_xiaoshimei_image_qa|IMAGE_[0-9]+_QA_CALL_FAILED/i.test(message)) return { ...meta, stage: "image", code: "IMAGE_QA_UNAVAILABLE", title: "图片质检暂时不可用", detail: "已生成图片应继续保留供人工确认，不会自动覆盖或重复计费。" };
  if (/production layout budget|TEXT_QUALITY_GATE_FAILED/i.test(message)) return { ...meta, code: "QUALITY_GATE_REJECTED", title: "内容没有通过质量校验", detail: "文字密度、主题相关性或表达边界仍有明确问题。旧稿已保留，重试只修当前文字节点。" };
  if (/AbortError|aborted|timeout/i.test(message)) return { ...meta, code: "GENERATION_TIMEOUT", title: "生成等待超时", detail: "旧稿没有改变。服务恢复后可从当前节点重试。" };
  return { ...meta, code: "GENERATION_FAILED", title: "生成请求没有完成", detail: "旧稿和当前画布均已保留。下方保留了技术码，可从当前节点重试。" };
}
