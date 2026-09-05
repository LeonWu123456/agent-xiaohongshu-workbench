# RULE-004｜Secret 与外部发布边界

- 回答：什么约束绝不能被绕过？
- 本节点答案：保护 Provider Key、Developer API、签名私钥、Redis token、账号和外部动作
- 上游：FLOW-002(constrained_by)
- 下游：无（顶层能力入口）
- 实现：`SECURITY.md`、`src/provider-client.mjs`、`api/provider.mjs`、`scripts/attest-upstash-image-ledger.mjs`、`deployment/PRODUCTION_RUNBOOK.md`、`vercel.json`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/current-logic-map.test.mjs` 与对应消费者 Reality readback
