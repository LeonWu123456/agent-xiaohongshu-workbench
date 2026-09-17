# STORE-003｜生成资产与发布包

- 回答：哪份状态或资产是权威，怎样恢复？
- 本节点答案：从本机内容寻址媒体解引用生成可交付物，不让Redis TTL决定旧稿生死
- 上游：FLOW-002(writes)、FLOW-004(writes)
- 下游：无（顶层能力入口）
- 实现：`src/publish-package.mjs`、`src/download-transport.mjs`、`src/media-asset-store.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
