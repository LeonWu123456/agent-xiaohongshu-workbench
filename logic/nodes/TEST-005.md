# TEST-005｜旧任务分流与九类逻辑地图回归

- 回答：用什么自动化与 Reality 证据证明没有退化？
- 本节点答案：验证 stale READY/UNKNOWN 分流零 Provider 且原子；验证当前地图完整回答 CAP/PAGE/UI/ACT/FLOW/API/STORE/RULE/TEST、关系、旅程和反馈环
- 上游：FLOW-006(verified_by)
- 下游：PAGE-001(covers)
- 实现：`tests/main-authority.test.mjs`、`tests/workspace-state-v2.test.mjs`、`tests/current-logic-map.test.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/main-authority.test.mjs`、`tests/workspace-state-v2.test.mjs`、`tests/current-logic-map.test.mjs`

- 红灯样例：仅检查版本号、入口或 `problems=RESOLVED` 不足以证明是逻辑地图；缺任一九类、孤立节点、无关键旅程、无反馈环或节点无实现/验证，测试必须失败。
