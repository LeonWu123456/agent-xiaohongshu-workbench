# RULE-003｜交付层级与 Reality 证据不可偷换

- 回答：什么约束绝不能被绕过？
- 本节点答案：区分机制、目标、生产与现实；advisory evidence 只能进入下一轮建议，不能替代 layout QA、发布验真或消费者 readback
- 上游：FLOW-001(constrained_by)、FLOW-004(constrained_by)、FLOW-005(constrained_by)
- 下游：UI-006(constrains)、UI-007(constrains)
- 实现：`PRODUCT_CONTRACT.md`、`AGENTS.md`、`src/publication-authority.mjs`、`package.json`、`scripts/verify-shareable-delivery.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
