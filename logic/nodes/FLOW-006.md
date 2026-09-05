# FLOW-006｜当前任务状态与旧恢复稿血缘分流

- 回答：动作怎样跨状态、数据与失败边界流动？
- 本节点答案：用 current text draft id、pending frozen text draft id 与 pending location 判定当前查询还是旧稿分流；迁移采用 snapshot/token CAS，恢复检查零图片调用，缺记录可能重建文字分镜。
- 上游：ACT-009(routes_to)、ACT-010(routes_to)
- 下游：API-001(depends_on)、API-002(depends_on)、STORE-001(writes)、STORE-005(writes)、RULE-001(constrained_by)、RULE-005(constrained_by)、TEST-001(verified_by)、TEST-005(verified_by)
- 实现：`src/main.jsx`、`src/workspace-state.mjs`
- 规则：以节点 ID、typed relation 和 confirmed draft / DraftRecord 身份为准；UI 标签不能自报完成。
- 验证：TEST-001(verified_by)、TEST-005(verified_by)

- 身份判定：只有 `pendingTextDraftId === currentTextDraftId` 才锁当前稿；不同 ID 进入恢复卡；缺少 ID 时保守关闭付费，不猜。

- 失败分支：真实 `IMAGE_STEP_UNKNOWN/IMAGE_STEP_IN_FLIGHT` 先映射为 `UNKNOWN/IN_FLIGHT`，保留各自原因；画布上下文不得覆盖成泛化的“仍在恢复窗”。
- 邻接发布门：文字未确认、正文漂移、来源缺失、未组装、不同稿均保持发布锁；同稿通过只证明文案来源一致，不能代替媒体和下载验收。
- 恢复成本：检查不调用图片模型；记录缺失可能调用文字模型重建分镜，不能统一写成“只读、没有模型调用”。
- 反例来源：`tests/generation-feedback.test.mjs` 由真实 `derivePublicationAuthority` 返回值驱动恢复文案，防止两个单测各自正确但界面矛盾。
- 参考图调整：存在当前 DraftRecord 的 pending 时，先保留原任务、画布、冻结快照和恢复点，再原子保存并激活同文案编辑副本；副本不携带 pending 或 image_resume，不调用生成 Provider。没有当前 pending 时直接打开参考图设置。
- 目的地验收：不能以滚动/高亮算通过。参考图说明必须可编辑、保存重载仍在；原任务仍可返回检查。未确认文字先回文字确认，不自动赋予确认状态。陈旧回调、媒体缺失、只读或 CAS 失败不得先导航或覆盖原稿。
- 对应实现与验证：`forkDraftForReferenceEditV3`、`openReferenceSettings`；`tests/workspace-state-v2.test.mjs`、`tests/main-authority.test.mjs`、`tests/generation-feedback.test.mjs`。
- 相邻资产库：持久化与媒体回载视图共同消费 `libraryContentsFromNormalized`；原 pending 稿必须显示“待恢复配图”和原任务文字标题，不能在 UI 的重复投影里丢失恢复标记。
