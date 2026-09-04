# FLOW-001｜原文到发布包的创作旅程

- 回答：动作怎样跨状态、数据与失败边界流动？
- 本节点答案：控制当前阶段和唯一下一动作
- 上游：ACT-002(routes_to)、ACT-005(routes_to)
- 下游：FLOW-002(depends_on)、FLOW-003(depends_on)、FLOW-004(depends_on)、API-002(depends_on)、RULE-003(constrained_by)、TEST-001(verified_by)、TEST-003(verified_by)
- 实现：`src/creator-journey.mjs`、`src/main.jsx`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：TEST-001(verified_by)、TEST-003(verified_by)
