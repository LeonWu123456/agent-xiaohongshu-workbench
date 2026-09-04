# TEST-001｜当前文字 Provider 与付费边界

- 回答：用什么自动化与 Reality 证据证明没有退化？
- 本节点答案：验证确认门、同 draft 锁定、不同 draft 解耦、发现与付费续步不混成一次点击
- 上游：FLOW-001(verified_by)、FLOW-002(verified_by)
- 下游：PAGE-001(covers)
- 实现：`tests/action-reference-media.test.mjs`、`tests/media-asset-store.test.mjs`、`tests/ark-provider.test.mjs`、`tests/cloud-provider.test.mjs`、`tests/xhs-publish-quality.test.mjs`、`scripts/attest-upstash-image-ledger.mjs`、`deployment/PRODUCTION_RUNBOOK.md`、`tests/foundation.test.mjs`、`tests/generation-session.test.mjs`、`tests/generation-feedback.test.mjs`、`tests/main-authority.test.mjs`、`tests/public-image-run.test.mjs`、`tests/workspace-state-v2.test.mjs`、`tests/creator-journey.test.mjs`、`tests/sol-workbench-contract.test.mjs`、`vercel.json`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/action-reference-media.test.mjs`、`tests/media-asset-store.test.mjs`、`tests/ark-provider.test.mjs`、`tests/cloud-provider.test.mjs`、`tests/xhs-publish-quality.test.mjs`、`tests/foundation.test.mjs`、`tests/generation-session.test.mjs`、`tests/generation-feedback.test.mjs`、`tests/main-authority.test.mjs`、`tests/public-image-run.test.mjs`、`tests/workspace-state-v2.test.mjs`、`tests/creator-journey.test.mjs`、`tests/sol-workbench-contract.test.mjs`
