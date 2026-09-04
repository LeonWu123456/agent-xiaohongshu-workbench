# TEST-002｜母图排版与编辑回归

- 回答：用什么自动化与 Reality 证据证明没有退化？
- 本节点答案：验证切片布局编辑、纯白纸面像素与邻接面
- 上游：FLOW-002(verified_by)、FLOW-003(verified_by)
- 下游：无（顶层能力入口）
- 实现：`tests/mother-sheet.test.mjs`、`tests/mother-sheet-artifact-cleanup.test.mjs`、`tests/mother-sheet-tile-quality.test.mjs`、`tests/layout-qa.test.mjs`、`tests/editor-history.test.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：`tests/mother-sheet.test.mjs`、`tests/mother-sheet-artifact-cleanup.test.mjs`、`tests/mother-sheet-tile-quality.test.mjs`、`tests/layout-qa.test.mjs`、`tests/editor-history.test.mjs`
