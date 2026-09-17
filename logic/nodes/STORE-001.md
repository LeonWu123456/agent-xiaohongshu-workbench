# STORE-001｜生成会话与恢复点

- 回答：哪份状态或资产是权威，怎样恢复？
- 本节点答案：持久化DraftRecord-bound小快照、IndexedDB媒体refs与图片恢复点；不复制媒体或保存登录Authority
- 上游：FLOW-002(writes)、FLOW-006(writes)
- 下游：无（顶层能力入口）
- 实现：`src/generation-session.mjs`、`src/image-run-checkpoint.mjs`、`src/public-image-run.mjs`、`src/workspace-state.mjs`、`src/media-asset-store.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
