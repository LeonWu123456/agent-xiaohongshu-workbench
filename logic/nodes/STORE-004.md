# STORE-004｜发布后 Reality feedback

- 回答：哪份状态或资产是权威，怎样恢复？
- 本节点答案：记录真实而非推断指标
- 上游：FLOW-005(writes)
- 下游：无（顶层能力入口）
- 实现：`src/reality-feedback.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
