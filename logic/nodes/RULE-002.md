# RULE-002｜同一页面几何与导出真相

- 回答：什么约束绝不能被绕过？
- 本节点答案：阻断空白溢出缺图和错裁
- 上游：FLOW-003(constrained_by)、FLOW-004(constrained_by)
- 下游：无（顶层能力入口）
- 实现：`src/xhs-page-contract.css`、`src/export-image-verification.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
