# FLOW-004｜发布包生成与落盘

- 回答：动作怎样跨状态、数据与失败边界流动？
- 本节点答案：渲染校验组包下载回读
- 上游：ACT-006(routes_to)、FLOW-001(depends_on)
- 下游：API-002(depends_on)、API-003(depends_on)、STORE-003(writes)、RULE-002(constrained_by)、RULE-003(constrained_by)、TEST-003(verified_by)、TEST-004(verified_by)
- 实现：`src/publication-authority.mjs`、`src/publish-package.mjs`、`src/download-transport.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：TEST-003(verified_by)、TEST-004(verified_by)
