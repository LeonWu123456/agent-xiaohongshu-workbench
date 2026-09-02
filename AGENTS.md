# Agent小红书工作台：项目指引

## 产品边界

- 这是本地优先、可部署到 Vercel 的单账号图文内容工作台。文字与配图可通过火山方舟或 OpenAI 兼容 Provider 生成；必须保持先确认文字、再付费生成图片的边界。
- 浏览器读取和小红书发布仍通过用户自己的 OpenCLI Browser Bridge 登录会话完成；应用不读取、复制或保存 Cookie、账号密码。云端 BYOK Key 只存在当前标签页 `sessionStorage`，本地 Key 只存在 macOS Keychain 或进程环境，不得写入源码、日志或 Git。
- 研究只接纳经媒体探针确认的纯图文笔记：`mediaKind=graphic`、`hasVideo=false`、`imageCount>=1`。视频、混合媒体与无法确认的媒体一律排除。
- 发布必须经过完整预览确认和独立动作确认。`publish_now` 需返回可验证的笔记 ID 或 URL；`save_draft` 只能点击小红书创作页文字完全一致的“暂存离开”，绝不点击“发布”。
- 不使用 Superpowers。热点拆解只使用随项目分发的 Lingzao Skill；不调用 Lingzao API、积分服务或生图服务。

## 内置依赖与路径

- Codex Agent 任务固定使用 `gpt-5.6-terra`。拆解、初稿、中文去 AI 味与涉及文稿的修改使用 `high`；检索、头像/配图、纯视觉修改和发布使用 `medium`。
- 项目内置的 Skill 在 `.agents/skills/`：`lingzao`、`humanized-chinese-writing-polisher` 与 `opencli-browser`。不得要求用户另行克隆或安装这些 Skill。
- 运行依赖由根目录 `package.json` 安装：`@jackwener/opencli`。Codex CLI 是外部前置条件，必须由每位用户自行安装并登录；Chrome 扩展和小红书登录态同样属于必要个人配置，不能随仓库分发。

## 隐私与公开发布

- `.data/`、`public/generated/`、`public/brand/avatars/` 与 `public/brand/actions/` 是运行时用户数据，必须保持未跟踪。
- `npm start` 默认把新生成图片、Provider 回执和工作状态写入 `~/.mesy/runtime/packages/xiaoshimei-studio-v2/`；源码树只保留空目录占位、测试夹具、逻辑地图和最小结果记录。
- 不要把账号定位、热点 URL、笔记正文、评论、发布记录、浏览器日志、Cookie、令牌、截图或用户上传头像写入源码、测试夹具、文档或 Git 历史。
- 新安装从空白状态开始；只有用户主动输入定位并生成/上传品牌角色后，才可执行后续流程。
- 品牌角色必须支持用户本地上传。Agent 需从上传母版提取脸部、发型、穿着、比例与渲染方式的身份锁，并生成 6 个只改变动作、手势和表情的系列形象；后续配图必须同时参考母版与该系列，不得硬编码某个示例人物。
- 每轮内容的配图数量由用户选择，合法范围为 1–6 张；该数量从初稿卡片、去 AI 味、角色动作、最终渲染到发布必须始终一致。
- 热点研究只接纳有可验证点赞与收藏数据的爆款图文：点赞至少 300，或收藏至少 100，或点赞与收藏合计至少 400。评论数不得单独使笔记达标，因为其中可能包含作者自评；不达标或指标缺失的笔记不能进入 signals、选题证据或拆解。
- 故事线仍只收录有笔记 ID 或公开 URL 的已发布内容。除发布成功即时归档外，工作台必须提供只读的创作后台历史同步，用于跨版本、清空本地数据或旧任务未归档后的恢复；不得把 failed、unknown 或 draft_saved 自动当成已发布。

## 小项目现实收敛

### 动作前能力激活（折叠进现有 Loop，不另建流程）

- 只有需求存在多种合理解释、路线需要选型、事实会变化，或同类任务曾被 Leon 否决时，才做能力激活；明确的小修直接执行，不交“概念税”。
- 写代码前先在当前回复内形成一屏 `Activation Brief`：`observable_effect`、`most_likely_rejection`、`key_unknown`、`selected_capabilities`（最多 5 项）、`first_reality_probe`、`reality_checks`、`stop`。它是本轮工作内存，不创建新文档、Task、Agent、Registry 或 Queue。
- 先查本项目合同/逻辑地图/AGENTS、项目内 Skill、当前 Task Evidence、源码与 Runtime Reality；概念只用来扩大检索词，不直接当答案。内部可广召回 8–12 项，最终只加载 3–5 项，只有会改变路线的 2–3 项才深查外部来源。
- 每个入选能力必须落到可执行对象：`Skill / Tool / Knowledge / source / method`、为什么现在需要、预期改变哪个决策、成本/风险、如何现实验收；其余候选给一句淘汰理由，防止下一轮重新研究。
- 只在答案会改变外部/不可逆动作、验收无法观察，或缺少 Leon 专属资产/权限时，询问一个信息价值最高的问题；否则写明可回滚假设并继续。
- 执行中按“行动 → 环境观察 → 校验”回读；Reality 推翻路线时只允许一次有界重新检索，然后修正第一步。禁止无限头脑风暴、把全量 Tools 塞进上下文，或让自我反思直接改全局记忆。
- 如果现有 Production 与关键旅程已经通过，不得为了显得勤快继续造功能；第一探针应转向真实消费者、真实内容和结果窗口。好车已经到终点，就别继续给方向盘贴钻。

- Codex 每轮先绑定一个用户可观察结果和一条最短关键旅程；本项目当前旅程是“原文 → 文字 → 配图 → 排版 → 编辑 → 保存/重载 → 下载”。测试项、提交数、文档数和部署次数都不是用户结果。
- 证据分三层：`mechanism`（测试/构建）、`target`（同一 commit 的 Preview/API/静态资产）、`reality`（该 Preview 上的桌面与窄屏关键旅程）。三层必须分别报告，任何适用层缺失都不得说“已完成”“可用了”或请求切生产。
- 浏览器现实验收必须使用本轮 commit 和能触发本轮缺陷的数据。视觉问题必须看当前渲染结果；不能从 CSS、DOM、HTTP 200 或旧截图推断视觉 PASS。下载必须由真实用户手势触发并核对落盘文件；保存/重载必须证明编辑仍在。
- 一旦现实验收发现缺陷，留在同一 Task、同一分支和同一最短旅程内修复并重跑失败切片；不得为每个缺陷重开项目、重写架构或把“下一轮继续”当交付。只有出现权限、Secret、外部依赖或不可逆风险的真实阻塞才停。
- 并行时实行单写者：项目 Codex 修改产品代码；治理 Agent 只调整 Acceptance、Guard 和 Evidence，不同时改同一代码写集。治理发现只通过当前 Task/AGENTS 传入，不建立第二队列或控制面。
- 对 Leon 的状态只允许“可用 / 局部可用 / 不可用”，并附当前 commit、已通过的现实旅程和唯一剩余阻塞。失败日志、测试绿和 Preview Ready 只能作证据，不能替代这个结论。
- 生产提升只允许来自通过三层证据的 commit；提升后必须回读正式域名，并保留一个已知可用 rollback deployment。若正式回读与 Preview 不一致，立即回滚，不继续在生产试错。
- 对用户给出“可以发给小师妹”的入口前，必须运行 `npm run verify:shareable-delivery -- --url <stable-url> --expected-commit <exact-40-sha> --candidate-root <clean-worktree> --receipt <operator-journey.json>`。只有机器结果 `HANDOFF_READY` 才能说“可以发给她”；这个工具永远不能签发 `CONSUMER_VALIDATED`，只有小师妹本人在独立设备上的直接反馈才能证明“她已经能用”。`LOCAL_ONLY`、`BLOCKED`、缺回执或任何 Hash/同稿 identity 漂移都必须直说不可交付，禁止用 HTTP 200、Preview Ready、旧 Production、Leon 本机试用或自填 actor 字段升级措辞。

```yaml
small_project_reality_convergence:
  incident_ref:
    - artifacts/design-qa/full-dogfood-20260830/RESULT.md
    - ../../Tasks/TSK-260827-1821-Radar-Q注意力智能现实闭环/Evidence/PRE_ACTION_INTELLIGENCE_INVESTIGATION_20260830.md
  applies_only_when: 用户要求可见产品效果、修复用户旅程、存在多种合理路线，或准备把 Preview 提升到生产
  false_positive_cost: 真实桌面/窄屏与保存下载回读会增加一次验收时间；纯后端、文档或无 UI 变更只跑受影响旅程
  review_when: 小师妹闭环后，再用一个独立小项目检验是否减少返工和“测试绿但现实坏”
  kill_if: 该合同连续两个独立项目只增加仪式时间，且未减少现实缺陷、返工轮数或用户追问
  owner: Xiaoshimei 项目 Codex Owner
```

## 源码与发布权威

- GitHub `LeonWu123456/agent-xiaohongshu-workbench` 的 `main` 是当前可写正式源码权威；上游 `EthanYoQ/agent-xiaohongshu-workbench` 仅通过 PR 同步。本地目录是工作副本，不得长期承载未推送的唯一实现。
- `xiaoshimei-v2` 等功能分支必须先通过 `npm test`、`npm run build`、Vercel Preview 和桌面/窄屏浏览器验收，再合并 `main`。
- 正式 Vercel 项目只维护 `xiaoshimei-full-workbench` 这一入口；不得再造 layout-preview、share-site 或第二套线上工作台。
- 每次生产提升都要把 commit、Preview、Production deployment、正式域名回读和 rollback deployment 写入 `deployment/PRODUCTION_RUNBOOK.md`，并同步更新 `XIAOSHIMEI_WORKBENCH_FULL_LOGIC_MAP.md` 的五层真相。
