# RULE-001｜付费图片与 confirmed draft 精确绑定

- 回答：什么约束绝不能被绕过？
- 本节点答案：当前操作只锁定自己的 confirmed draft；旧 draft 的 pending 必须可保留、可发现、可恢复，但不能劫持新 draft 控件
- 上游：FLOW-002(constrained_by)
- 下游：UI-001(constrains)
- 实现：`src/main.jsx`、`AGENTS.md`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
