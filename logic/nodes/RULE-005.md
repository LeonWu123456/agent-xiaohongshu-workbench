# RULE-005｜不同 confirmed draft 不得互锁或串写

- 回答：什么约束绝不能被绕过？
- 本节点答案：同 draft pending 才能锁当前配图；不同 draft pending 只能进入独立恢复面。身份未知时 fail closed，迁移失败不释放源任务
- 上游：FLOW-006(constrained_by)
- 下游：UI-009(constrains)
- 实现：`src/main.jsx`、`src/workspace-state.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback

- 禁止：旧任务不能禁用新稿页数、模式、参考图或提示词；新稿不能覆盖旧任务 checkpoint；恢复卡不能把 DISCOVER 和 STEP 合并。
