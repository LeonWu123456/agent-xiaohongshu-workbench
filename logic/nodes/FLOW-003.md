# FLOW-003｜页面排版与编辑

- 回答：动作怎样跨状态、数据与失败边界流动？
- 本节点答案：同一模型的可撤销编辑
- 上游：ACT-004(routes_to)、FLOW-001(depends_on)、FLOW-005(routes_to)
- 下游：API-002(depends_on)、STORE-002(writes)、RULE-002(constrained_by)、TEST-002(verified_by)、TEST-003(verified_by)、TEST-004(verified_by)、ACT-006(consumer_readback)
- 实现：`src/main.jsx`、`src/HtmlPageEditor.jsx`、`src/MaturePageEditor.jsx`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：TEST-002(verified_by)、TEST-003(verified_by)、TEST-004(verified_by)
