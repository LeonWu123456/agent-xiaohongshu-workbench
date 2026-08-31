# 小师妹 Studio｜GitHub → Vercel 生产手册

更新时间：2026-08-30

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
- 构建合同：Node 22，`npm ci --omit=dev --workspaces=false`，`npm test`，`npm run build`，输出 `dist/`。

## 数据与秘密

- GitHub/Vercel 只接收源码和公开静态资产。
- `.data`、生成图片、Provider 回执、账号素材、下载包和 `.env*` 不进入 Git。
- 本地运行数据落在 `~/.mesy/runtime/packages/xiaoshimei-studio-v2/`。
- Vercel BYOK API Key 只由使用者当前标签页提交到 `/api/provider`，服务端不持久化；本地 Key 只从 Keychain/环境读取。

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
