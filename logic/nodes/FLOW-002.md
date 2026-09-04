# FLOW-002｜当前文字 Provider 生成链路

- 回答：动作怎样跨状态、数据与失败边界流动？
- 本节点答案：文字确认后才允许为同一 confirmed draft 进入 START/DISCOVER/STEP；不同 draft 的 pending 不得进入当前链路
- 上游：ACT-001(routes_to)、ACT-003(routes_to)、ACT-008(routes_to)、FLOW-001(depends_on)
- 下游：API-001(depends_on)、API-002(depends_on)、STORE-001(writes)、STORE-002(writes)、STORE-003(writes)、STORE-005(writes)、RULE-001(constrained_by)、RULE-004(constrained_by)
- 实现：`src/ark-provider-core.mjs`、`src/xhs-publish-quality.mjs`、`src/action-reference-media.mjs`、`src/media-asset-store.mjs`、`src/provider-client.mjs`、`src/provider-contract.mjs`、`src/generation-session.mjs`、`src/generation-feedback.mjs`、`src/public-image-run.mjs`、`src/mother-sheet-artifact-cleanup.mjs`、`src/mother-sheet-tile-quality.mjs`、`api/provider.mjs`、`scripts/attest-upstash-image-ledger.mjs`、`tests/attestation-workflow-contract.test.mjs`、`deployment/PRODUCTION_RUNBOOK.md`、`vercel.json`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/attestation-workflow-contract.test.mjs`
