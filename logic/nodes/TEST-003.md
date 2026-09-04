# TEST-003｜保存重载与发布包实物

- 回答：用什么自动化与 Reality 证据证明没有退化？
- 本节点答案：验证媒体先落盘、稿件只存refs、第8天/离线重载、备份恢复、渲染导出和下载
- 上游：FLOW-001(verified_by)、FLOW-003(verified_by)、FLOW-004(verified_by)
- 下游：PAGE-001(covers)
- 实现：`tests/action-reference-media.test.mjs`、`tests/media-asset-store.test.mjs`、`tests/generation-session.test.mjs`、`tests/export-image-verification.test.mjs`、`tests/publish-package.test.mjs`、`tests/download-transport.test.mjs`、`tests/workspace-state-v2.test.mjs`、`tests/public-image-run.test.mjs`、`tests/publication-authority.test.mjs`、`tests/main-authority.test.mjs`、`tests/sol-workbench-contract.test.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/action-reference-media.test.mjs`、`tests/media-asset-store.test.mjs`、`tests/generation-session.test.mjs`、`tests/export-image-verification.test.mjs`、`tests/publish-package.test.mjs`、`tests/download-transport.test.mjs`、`tests/workspace-state-v2.test.mjs`、`tests/public-image-run.test.mjs`、`tests/publication-authority.test.mjs`、`tests/main-authority.test.mjs`、`tests/sol-workbench-contract.test.mjs`
