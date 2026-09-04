# PAGE-001｜创作与编辑工作台

- 回答：用户在哪个页面完成哪一段任务？
- 本节点答案：正式 compose 入口
- 上游：CAP-001(contains)、TEST-001(covers)、TEST-005(covers)、TEST-003(covers)
- 下游：UI-001(exposes)、UI-002(exposes)、UI-003(exposes)、UI-004(exposes)、UI-005(exposes)、UI-006(exposes)、UI-009(exposes)
- 实现：`src/main.jsx`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
