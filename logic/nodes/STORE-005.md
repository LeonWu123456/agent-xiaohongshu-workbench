# STORE-005｜跨实例图片调用幂等账本

- 回答：哪份状态或资产是权威，怎样恢复？
- 本节点答案：上游前以签名readiness和全局容量原子拒绝重放；run/raw资产完整保留七天并仅在物理读回后释放；不拥有登录或长期媒体Authority
- 上游：FLOW-002(writes)
- 下游：无（顶层能力入口）
- 实现：`api/provider.mjs`、`scripts/attest-upstash-image-ledger.mjs`、`tests/attestation-workflow-contract.test.mjs`、`deployment/PRODUCTION_RUNBOOK.md`、`src/provider-client.mjs`、`src/public-image-run.mjs`、`tests/cloud-provider.test.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/attestation-workflow-contract.test.mjs`、`tests/cloud-provider.test.mjs`
