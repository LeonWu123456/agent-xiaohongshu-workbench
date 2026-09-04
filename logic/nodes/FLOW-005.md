# FLOW-005｜Reality Feedback → 下一轮建议

- 回答：动作怎样跨状态、数据与失败边界流动？
- 本节点答案：只有真实发布证据可形成 advisory context；它能影响下一轮建议，但不能绕过 deterministic layout QA 或付费门
- 上游：ACT-007(routes_to)、ACT-007(feedback_to_node)
- 下游：STORE-004(writes)、RULE-003(constrained_by)、TEST-004(verified_by)、FLOW-003(routes_to)、API-002(depends_on)
- 实现：`src/reality-feedback.mjs`、`src/main.jsx`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：TEST-004(verified_by)
