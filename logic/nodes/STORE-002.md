# STORE-002｜当前稿资产库与编辑历史

- 回答：哪份状态或资产是权威，怎样恢复？
- 本节点答案：v3保存稿件引用，IndexedDB保存本机长期媒体，v2回滚不裂图；第8天与离线仍可编辑导出
- 上游：FLOW-002(writes)、FLOW-003(writes)
- 下游：无（顶层能力入口）
- 实现：`src/workspace-state.mjs`、`src/editor-history.mjs`、`src/media-asset-store.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
