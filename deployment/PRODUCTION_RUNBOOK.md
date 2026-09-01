# 小师妹 Studio｜GitHub → Vercel 生产手册

更新时间：2026-08-31

## 单一权威链

```text
本地功能分支
→ GitHub Pull Request / quality workflow
→ Vercel Preview
→ 桌面 + 360px + 编辑/保存/导出验收
→ 合并 main
→ 提升同一已验收 deployment 到 Production
→ 正式域名回读
```

- 可写源码权威：`https://github.com/LeonWu123456/agent-xiaohongshu-workbench` 的 `main`。
- 上游同步：`https://github.com/EthanYoQ/agent-xiaohongshu-workbench/pull/13`；当前账号对上游只有 READ，不把等待上游合并当成生产阻塞。
- 当前集成分支：`xiaoshimei-v2`。
- 唯一正式 Vercel 项目：`xiaoshimei-full-workbench`。
- 稳定域名：`https://xiaoshimei-full-workbench.vercel.app/`。
- 构建合同：Vercel 项目当前锁定 Node 24.x；`npm ci --omit=dev --workspaces=false`，`npm test`，`npm run build`，输出 `dist/`。每次发布前必须从 Vercel Project readback 复核 Node 版本，手册不得凭旧值覆盖生产事实。

## 数据与秘密

- GitHub/Vercel 只接收源码和公开静态资产。
- `.data`、生成图片、Provider 回执、账号素材、下载包和 `.env*` 不进入 Git。
- 本地运行数据落在 `~/.mesy/runtime/packages/xiaoshimei-studio-v2/`。
- Vercel BYOK API Key 只由使用者当前标签页提交到 `/api/provider`，服务端不持久化；本地 Key 只从 Keychain/环境读取。

## D36 跨实例图片账本（当前仅本地候选，未启用）

这条 Lane 解决的是：Vercel 实例死亡或响应丢失后，已经发生的图片付费副作用不能被另一个实例重复执行。它不替代浏览器 IndexedDB 的长期稿件/媒体权威；Redis 只保留完整 run、step 和 raw asset 七天。

### 一次 Human Gate 的精确边界

执行下列任一外部动作前必须由 Leon 一次明确批准：

1. 在 **native Upstash account** 中创建或选用一个只供小师妹使用的 Free Redis database；不得用 Vercel 托管的第三方账号冒充 Developer API 可见资源。
2. 按 Vercel Integration Option 2 把该 existing native resource 链接到唯一项目 `xiaoshimei-full-workbench`。
3. 让 Runtime 外短进程持有 Upstash Developer API Basic credential 与 Ed25519 私钥，执行一次不可压缩 worst-case 校准、写 signed sentinel，并在受控变更前或最迟第 6 天刷新。
4. 向目标 Vercel environment 写入 Redis REST token、签名公钥和下表绑定值。

该 Gate **不**授权：信用卡/付费升级、auto-upgrade、eviction、共享数据库、Runtime 持有 Developer credential/私钥、自动部署或图片 Provider 调用。官方控制面依据：[Upstash Developer API](https://upstash.com/docs/devops/developer-api/overall/getstarted)、[Audit Logs](https://upstash.com/docs/devops/developer-api/account/list_audit_logs)、[Vercel existing account/resource link](https://upstash.com/docs/redis/howto/connectwithvercel)。

### 秘密与绑定分层

| 所在面 | 变量 | 作用 |
|---|---|---|
| Runtime 外 attestor | `UPSTASH_DEVELOPER_EMAIL`、`UPSTASH_DEVELOPER_API_KEY` | 只读 database/config/stats/account audit logs |
| Runtime 外 attestor | `XIAOSHIMEI_LEDGER_ATTESTATION_PRIVATE_KEY` | Ed25519 签名；绝不进入 Vercel Runtime |
| attestor + Runtime | `UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN` | 同一 native database 的 data plane；Vercel 中设为 Sensitive |
| attestor + Runtime | `XIAOSHIMEI_VERCEL_PROJECT_ID`、`VERCEL_ENV`、`XIAOSHIMEI_CANDIDATE_COMMIT` | receipt 与当前部署精确绑定 |
| attestor | `UPSTASH_DATABASE_ID`、`XIAOSHIMEI_WORST_CASE_RUN_BYTES` | 控制面定位与不可压缩校准输入 |
| Runtime | `XIAOSHIMEI_UPSTASH_DATABASE_ID_SHA256`、`XIAOSHIMEI_LEDGER_ATTESTATION_PUBLIC_KEY` | 只保存数据库 ID 哈希与验签公钥 |

`XIAOSHIMEI_APP_SCOPE` 由当前 access/origin 配置确定；attestor 与 Runtime 必须逐字一致。日志、CI artifact 和聊天里不得输出 REST token、Basic credential 或私钥。

### 签发、续签与运行门

1. 冻结 candidate commit、Vercel project/environment、native database 和 app scope。
2. 在 Runtime 外运行 `node scripts/attest-upstash-image-ledger.mjs`。脚本只在 active、not modifying、TLS on、eviction/db_eviction/auto-upgrade off、七天审计连续、校准写入/readback/物理用量/DEL/absence 全部可证时签发。
3. 回读输出中的 `control_config_hash`、`relevant_audit_set_hash`、audit high-water、`attestation_generation`、`capacity_generation`、第 6 天 renew 和第 7 天 hard expiry；输出不含秘密。
4. 相同 capacity identity 的续签只改变 `attestation_generation`，保留所有 live reservation；改变 database/origin/app scope/key schema/calibration/capacity 时，旧 `live_reservations`、`reserved_bytes`、`unfinalized_inventory` 任一非零都拒绝切换。
5. 新 START 在 Provider 前验签 sentinel，并执行 Redis TIME、PING、DBSIZE A/full SCAN/DBSIZE B、exact inventory union、物理/逻辑容量检查；同一 claim Lua 再验 generation 并原子占 worst-case reservation。STEP 只重验当前 receipt、稳定 `capacity_generation` 和已有 reservation，不重复全库扫描。
6. 七天内不得因 COMPLETE、本机已保存或 helper 调用提前删除 server raw asset。Redis TIME 到恢复截止后，下一次 paid admission 才有界执行 inventory freeze → exact DEL → 每键 EXISTS=0 + run-root SCAN empty → 原子 capacity release；TTL 设得晚于七天，仅作无后续请求时的物理兜底，TTL 本身不释放 reservation。

### 触发与失败语义

- 立即重签：deploy/rollback、Vercel env、Redis resource/config/token/public key、签名 key、协议/key schema、校准或 capacity 变化之前，以及 audit log 出现相关新 entry 时。
- 周期刷新：无变化时最迟第 6 天由 Runtime 外 Intel/CI 短进程运行，留一天重试缓冲；这不是 Runtime 内常驻自签。
- 第 7 天 receipt 过期：只关闭 paid START/STEP，Provider 调用必须为 0；登录、`GET /config`、DISCOVER 与已认证 raw asset recovery 不连坐。
- Provider 已产生图片副作用但首次 durable commit 前死亡：标记 `UNKNOWN`，不得自动重试；没有官方 attempt-id 查询证据时，结果恢复保持未证明。
- Developer API、audit continuity、签名、SCAN/DBSIZE、foreign key、generation、capacity 或校准任一 UNKNOWN：fail closed，不签发、不减计、不调用 Provider。

### 部署前与回滚

只有本地 fake Developer API/Redis 正负矩阵、完整测试、production build、同一制品 Preview 实际路径与消费者回读全绿后，才可请求上述 Human Gate。外部启用失败时撤销新增 Vercel D36 env 并关闭 paid 图片 Lane；不得删除浏览器 IndexedDB 稿件/媒体，不得用不兼容的旧 receipt 恢复 STEP。只有旧、新 deployment 绑定同一 `capacity_generation` 与兼容协议时，才可沿用未完成 reservation；否则保持 fail closed，等待七天 finalizer 清零后再切换。

## 每次发布必须记录

| 字段 | 值 |
|---|---|
| source commit | 发布时填写 |
| Preview deployment | 发布时填写 |
| Preview QA | 桌面、360px、编辑、刷新、导出 |
| Production deployment | 发布时填写 |
| stable-domain readback | HTTP、资源 hash、核心交互 |
| rollback deployment | 上一份已验证 Production |

## 回滚

1. 不重新构建失败提交。
2. 将正式别名指回表中记录的上一份已验证 deployment。
3. 回读稳定域名的 HTML/JS 资源与核心路径。
4. GitHub 用修复提交前进；禁止强推重写已经发布的 `main`。

## 2026-08-30 发布记录

| 字段 | 值 |
|---|---|
| source commit | `0df5f59a64a2533045cf6d8d2fe666bf44e8a05a`；连续性补记提交随后进入同一 PR |
| GitHub | fork 分支 `xiaoshimei-v2`；CI run `33311107288` 全绿；上游 PR `#13` |
| Preview deployment | `dpl_CLPNZ9vJZX5T2pdwyq8L2Mz3tPMy` |
| Preview URL | `https://xiaoshimei-full-workbench-29ft74u88-892350620-5733s-projects.vercel.app`（Vercel Authentication 保护） |
| Preview QA | Vercel inspect Ready；HTML/JS/CSS 200；1440px 与 360px 浏览器回读；360px 无横向溢出；编辑后刷新保持；无 Key 请求 401 `ARK_API_KEY_REQUIRED`；本地完整五页编辑/撤销/回载/导出证据见 `artifacts/design-qa/full-dogfood-20260830/RESULT.md` |
| Production deployment | `dpl_Afw8Q5Vai578FVs11waZvd24CYBp`（由已验收 Preview promote） |
| stable-domain readback | `https://xiaoshimei-full-workbench.vercel.app/` HTTP 200；命中 `index-DwYvjSMn.js` / `index-B7TgIjcy.css`；线上与本地两份资源 SHA-256 分别完全一致；1440px 既有五页草稿与编辑/回载/发布包入口现场可见；无 Key 请求 401 `ARK_API_KEY_REQUIRED` |
| rollback deployment | `dpl_CunmG5zG5kq6CLtVJzaDjjLsQ5aN` |

当前边界：GitHub 可写 `main` 已合并 PR `#1`（merge commit `cdc713b2d465f625fbc34ee39fdadf08de4f2e7d`），正式域名已命中本轮新制品。未使用付费生成调用，未验证外部小红书发布或读者效果；上游 PR `#13` 仍等待上游维护者处理。

## 2026-08-30 生产事故与待发布修复

- 当前 Production `dpl_Afw8Q5Vai578FVs11waZvd24CYBp` 已由真实使用证明不可交付：`/api/provider/generate-images` 函数日志为 200，但浏览器收到 `Failed to fetch`；公网 ZIP 下载也无法完成。
- 根因分别是：整次生成把全部原尺寸切片以 Base64 塞进一个 JSON，缺少传输预算；以及公网错误地先调用仅本地存在的 `/api/local-export`。
- 本地修复分支：`fix/online-generation-export-layout-20260830`。
- 本地提交：`e169bd3`；尚未推送。
- 本地证据：264/264 tests；Vite build；五页窄屏无 overflow/overlap；改字、撤销、重做、刷新保存通过；白底几何 QA 夹具 `~/Downloads/小师妹-QA夹具-传输排版-20260830.zip` CRC PASS，5 张 PNG 均 1080×1440，SHA-256 `1dc44be370ccc2db178e85e74a8f61fa659e879708e76c6c6067ba9232f92d31`。该夹具只证明传输和排版，不冒充真实待发布内容。
- 发布边界：未获 Human Gate 前不推送、不生成 Preview、不替换 Production。获批后只允许“修复分支 → Preview 真实 BYOK/下载验收 → 同一 deployment promote → 正式域名回读”这一条路径。

### 事故修复 Preview 回读

| 字段 | 值 |
|---|---|
| Human Gate | 已批准：推送、Preview、真实 BYOK、下载验收；仅全绿时提升同一 deployment |
| source commit | `c4696a3`（生成链截止 `38ca9d5`；其后仅标题 CSS、history 与下载交互） |
| real-generation Preview | `dpl_EkcAFfJdCmcBxjzQCMkkwJdtF7ZE`：真实付费母版返回浏览器，3 页/3 图组装并可编辑 |
| final Preview | `dpl_E3eLycjdGTLSRXRKgtTJVYZmrJG4` · `https://xiaoshimei-full-workbench-7lnsp2620-892350620-5733s-projects.vercel.app/` |
| Preview QA | Ready；HTML 200；health 200 `AWAITING_BYOK`；无 Key 401 `ARK_API_KEY_REQUIRED`；长标题无 overflow；undo/redo；保存刷新；5 页发布包实际下载到 Desktop |
| package evidence | `~/Desktop/小师妹-发布包-最终预览QA-20260830.zip`；1,560,041 bytes；CRC PASS；5 PNG 均 1080×1440；SHA-256 `da279675ee39ba78e5f756e0c86dc7b2eb3e6cdb01bed920afda55dbb6ea5438` |
| pre-promotion Production | `dpl_Afw8Q5Vai578FVs11waZvd24CYBp`，事故版本；提升前现场状态 |
| rollback after promotion | `dpl_Afw8Q5Vai578FVs11waZvd24CYBp`；历史安全点另保留 `dpl_CunmG5zG5kq6CLtVJzaDjjLsQ5aN` |

### 事故修复 Production 应用

| 字段 | 值 |
|---|---|
| GitHub main | merge `e1e775f`；Vercel 项目 `link=null`，Git push 不触发平行自动部署 |
| promoted source | 已验收 Preview `dpl_E3eLycjdGTLSRXRKgtTJVYZmrJG4` |
| Production deployment | `dpl_Cj8uAE9utVX3oyLf6auJHMi824kj` · Ready |
| stable-domain readback | `https://xiaoshimei-full-workbench.vercel.app/` → `dpl_Cj8uAE9utVX3oyLf6auJHMi824kj`；HTML 200；health 200 `AWAITING_BYOK`；无 Key 401 `ARK_API_KEY_REQUIRED` |
| asset identity | `index-BHKoq_Od.css` SHA-256 `c50209b7dfc35784cc8b83c0b4677c86ef8c04dad859bdb91673097190514f37`；`index-CzpwE6Sa.js` SHA-256 `fc13f671e0ee8a8a3c908628c612187982aeb64df1e5a0731c38bff953b881d6`；线上/本地逐字节一致 |
| rollback deployment | `dpl_Afw8Q5Vai578FVs11waZvd24CYBp`；更早安全点 `dpl_CunmG5zG5kq6CLtVJzaDjjLsQ5aN` |

当前边界：旧部署的传输与下载机制曾通过，但下述新现实已撤销“工作台 Production 可交付”的总判断。

## 2026-08-30 视觉质量事故重新打开

- 当前 Production `dpl_Cj8uAE9utVX3oyLf6auJHMi824kj` 的“Ready、资源同构、BYOK 曾成功、ZIP 曾落盘”事实继续有效，但用户在同一正式域名的新生成中给出封面串入 A/B/C、内页人物截头、重复步骤前缀、错字和失控排版的现场证据。因此它不再是可交付视觉基线。
- 根因不是单页参数：首张母版固定按 2/3 切割；Page Plan 容量门未在公网付费调用前强制；页面 CSS v3–v15 叠加；配置存在被显示成连接成功；CI 没有绑定完成作品的视觉 dogfood。
- 本地根治候选已具备 mechanism + local reality evidence：自适应真实分界、失败补绘、付费前内容门、唯一 `xhs-page-contract.css`、HTML state v12、真实调用验证态、DOM 文本盒门；271/271 tests 与 Vite build PASS。476px 实机五页逐页量测均无 overflow/layout warning；封面 KV 9:8，全部内页插图 3:4；改字、模块移动和撤销成功。
- 本地真实下载证据：`~/Downloads/小师妹-发布包-2026-08-30T15-52-46-231Z-1.zip`，8 个文件可解，5 张 PNG 均为 1080×1440；封面和三单元内页已实际打开目检。该证据验证当前候选的编辑与导出，不替代新 BYOK 母版切片验证。
- 本轮剩余生产条件仍从零计算：Vercel Preview、真实 BYOK 新生成、Preview ZIP 实物、同一 deployment promote 与稳定域名回读。任何一项未通过，保持旧 Production 并明确其视觉不可交付，不得把旧 R30 复用为新 PASS。

### 根治候选 Preview（尚未提升）

| 字段 | 值 |
|---|---|
| source commit | `166ae87` · branch `fix/root-cure-layout-pipeline-20260830` |
| GitHub | fork PR `#3`；quality run `33321044122` PASS |
| Preview deployment | `dpl_A7Q7kiA5RLEQqqiiGyt1kZeTxJeP` · Ready |
| Preview URL | `https://xiaoshimei-full-workbench-kodvqmfy3-892350620-5733s-projects.vercel.app/`（Vercel Authentication 保护） |
| Preview readback | 登录态浏览器实际打开并显示“小师妹 Studio”；新稿、创作阶段、回载入口与 Provider “离线”状态可见；无错误覆盖层 |
| not yet proven | 尚未向 Preview 上传本地稿；尚未输入 BYOK、产生新母版、复核真实分界、下载 Preview ZIP；不得提升 Production |

## 2026-08-31 根治版 Production 应用

| 字段 | 值 |
|---|---|
| source commit | `8ad523b31e72c35b52f2b4ea98050077ad0c83bb`；PR `#3` 合并为 `b1c9af41c4139756c520fc04f54e1c81b5dfb83e`；`main` 与发布源 tree 均为 `07d632ced7599321e7f4cfe82b2f5b14dd9b3840` |
| GitHub QA | 分支 CI `33358315728` PASS；`main` CI `33359028594` PASS；275/275 tests 与 Vite production build PASS |
| Preview deployment | `dpl_36WGLvbRwtoAmMnESrk29oXZiSJP` · Ready；`https://xiaoshimei-full-workbench-5zlsj6kqr-892350620-5733s-projects.vercel.app/` |
| Preview real QA | 真实 BYOK 生成 5 页 / 11 个插图单元；浏览器完成文案修订、编辑与发布包下载；`~/Downloads/小师妹-发布包-2026-08-31T04-49-37-937Z-1.zip` CRC PASS，5 张 PNG 均为 1080×1440，SHA-256 `00ce959ffcbbab63ad0a2a553cae40e875faa285ff33f7977a8954d410d14a67` |
| Production deployment | `dpl_D4aZhhd2XQqTgZ1NEmamqusxn758` · Ready / Promoted；`originalDeploymentId=dpl_36WGLvbRwtoAmMnESrk29oXZiSJP` |
| stable-domain readback | `https://xiaoshimei-full-workbench.vercel.app/` HTTP 200；390px 无横向溢出，五阶段、新创作、回载与下载入口可见；health 200 `AWAITING_BYOK`；无 Key 401 `ARK_API_KEY_REQUIRED`；真实 BYOK 文案生成 200，Provider `volcengine-ark`，状态 `TEXT_READY_FOR_USER_CONFIRMATION` |
| asset identity | Production 与已验收 Preview 核心资源逐字节一致：`index-CFrBYFIi.js` SHA-256 `ebbef1808130c6f56648fbfda8dccb90c7deb485caf7a353e2ecd8f1e442274d`；`index-Dnkbj1z6.css` SHA-256 `0405bf792711bc036e9bdbb543fde89a29bdd4922235c724d700c3536ef45a0c` |
| rollback deployment | `dpl_Cj8uAE9utVX3oyLf6auJHMi824kj` |

当前边界：正式应用、真实生成链、编辑与发布包制品已经验证；BYOK 仍按使用者当前标签页保存在 `sessionStorage`，未把本地 Keychain 密钥上传为 Vercel 持久 Secret，也未扩大站点访问权限。另一位操作者的独立账号/设备接入，以及实际发布到小红书后的读者效果，仍需各自现实验证。
