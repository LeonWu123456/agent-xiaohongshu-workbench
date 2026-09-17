# PAGE-003｜生成服务设置

- 回答：用户在哪个页面完成哪一段任务？
- 本节点答案：配置 Provider 但不冒充调用成功
- 上游：CAP-001(contains)
- 下游：UI-008(exposes)
- 实现：`src/main.jsx`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
