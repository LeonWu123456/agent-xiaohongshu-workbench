# PAGE-002｜资产库与现实反馈

- 回答：用户在哪个页面完成哪一段任务？
- 本节点答案：保存稿件与发布后结果
- 上游：CAP-001(contains)、TEST-004(covers)
- 下游：UI-007(exposes)
- 实现：`src/main.jsx`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
