# FLOW-006｜当前稿与旧恢复稿血缘分流

- 回答：动作怎样跨状态、数据与失败边界流动？
- 本节点答案：用 current text draft id、pending frozen text draft id 与 pending location 判定锁定范围；迁移采用 snapshot/token CAS，一次提交 source release + recovery insert
- 上游：ACT-009(routes_to)
- 下游：API-002(depends_on)、STORE-001(writes)、RULE-005(constrained_by)、TEST-005(verified_by)
- 实现：`src/main.jsx`、`src/workspace-state.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：TEST-005(verified_by)

- 身份判定：只有 `pendingTextDraftId === currentTextDraftId` 才锁当前稿；不同 ID 进入恢复卡；缺少 ID 时保守关闭付费，不猜。
