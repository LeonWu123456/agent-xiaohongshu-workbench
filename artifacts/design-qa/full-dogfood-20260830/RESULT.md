# 小师妹工作台完整 Dogfood｜TaskSpec × 逻辑地图对照

日期：2026-08-30

## 结论

上午的本地完整创作链确实走通过，但随后正式站暴露了两个会阻断交付的生产事故：`generate-images` 函数返回 200 后浏览器仍 `Failed to fetch`，以及公网下载错误地先调用本地专用 `/api/local-export`。因此本文件此前的“正式版可用”结论被现实推翻，不再沿用。

当前修复分支已在本地重新闭环：公网生成响应加入按插图总数分配的切片字节预算与 4 MB 总响应闸；公网下载直接走浏览器 attachment；HTML v11 清理旧标题/面板位移，v14 用明确的 3:4 宽高和配套 Grid 列把图文限制在各自行内。264/264 tests、生产构建、五页窄屏测量、改字/撤销/重做、保存刷新、真实下载、ZIP CRC、5 张 1080×1440 PNG 和逐页目检均通过。

这仍不等于公网正式版已经更新：当前 Vercel Production 还是事故版本，且修复后尚未用公网 BYOK 重跑一次真实付费生图。外部发布与生产替换仍受一次 Human Gate 约束。

## TaskSpec 主流程对照

| 合同节点 | 现实结果 | 证据 |
|---|---|---|
| 原文/主题 | PASS | 东方生活/文化原文在刷新后仍保留 |
| 只生成文字 | PASS | `text-2026-08-30T08-51-55-860Z-3c5a41bd`，第一次尝试通过，正文 447 字 |
| 图片前人工确认 | PASS | 3 个标题、完整正文、恰好 5 tags 先出现并确认；确认前图片调用 0 |
| 1–8 页 | PASS | 用户采用 5 页；最终 5 个画板 |
| 场景图片 | PASS | `images-2026-08-30T08-52-49-596Z-c82e63c9`；2 张母版、10 个插画单元、2 次图片调用、¥0.44 |
| 3:4 编辑 | PASS | 每个可见插图源为 1080×1440；白底、橙色、无页码；图文左右交替 |
| 编辑/撤销 | PASS | 点图出现“裁剪 / 取景”；缩放操作后撤销恢复，重做可用 |
| 保存/回载 | PASS | 保存草稿后刷新，文章、5 页、发布文案和版式均恢复 |
| 发布文案 | PASS | 复制按钮回读 530 字，标题开头和 5 个标签完整 |
| 下载发布包 | PASS | 最终 ZIP 新落盘、CRC 全通过、包含 5 PNG + 文案 + content.json + manifest |
| 人工发布 | NOT RUN | 外部发布不在本轮授权内 |
| 24h/72h/7d 反馈 | NOT RUN | 尚无真实平台结果，不伪造为 0 |

## 逻辑地图 Acceptance 对照

| Gate | 结果 | 现场证据 |
|---|---|---|
| A10 白边 | PASS | 白背景保留；分隔线、灰框和邻格残片已从源像素清除；最终 5 页目检无串格线 |
| A11 构图 | PASS | 不等宽 A/B 单元按真实分隔线完整合成；人物头、手和关键器物未再被固定三等分裁掉 |
| A12 手机 | PASS | 设备级 360×1125：`innerWidth=360`、`scrollWidth=360`、无横向溢出；标题和正文层级清楚 |
| A13 版式 | PASS | 5 页导出无文字、图片或页脚溢出；每页一个主重点；空白为有意呼吸区 |
| A14 编辑 | PASS | 取景、缩放边界、undo/redo 现场可用；撤销后无遗留修改 |
| A15 导出 | PASS | `~/Downloads/小师妹-发布包-2026-08-30T09-33-12-009Z-1.zip`；8 文件 CRC PASS；5 PNG 均 1080×1440 |
| A16 参考 | PASS | 封面大字两行、正文纵向节奏、插图服务对应段落，不是等权 PPT 九宫格 |
| A17 全旅程 | PASS（本地关键链） | 生成、确认、翻页、取景、撤销、保存、刷新、复制、下载、桌面与窄屏均现场执行 |

## 五层真相

| 层 | 结果 |
|---|---|
| mechanism_ready | PASS_LOCAL：动态母版分隔线、边带清理、付费原图断点、语义标题换行、复制失败回读均已实现 |
| package_verified | PASS_LOCAL_ZIP：264/264 tests，Vite build，ZIP CRC，5 张 1080×1440 PNG 逐页目检 |
| production_applied | FAIL_CURRENT：Vercel Production `dpl_Afw8Q5Vai578FVs11waZvd24CYBp` 未包含本轮传输、下载和 v14 排版修复 |
| runtime_operational | PARTIAL：本地编辑/保存/导出可用；当前正式站生图与下载已由现实证明不可用 |
| reality_validated | PASS_LOCAL_DOGFOOD：本地五页关键旅程可用；修复后公网真实生图、下载与外部平台效果未验证 |

## 本轮发现并上移的根因

1. 固定三等分把“模型画出的网格”误当成确定性坐标，导致动作图裁手、裁物件。现在先检测真实分隔线，再完整合成到 3:4 白底。
2. 旧清理只涂白分隔线本体，邻格残片仍留在边缘。现在清理“边缘到分隔线”的完整污染带。
3. 白底被误判成白边，激进裁切反而裁头。现在白色负空间合法，只拒绝非白中性网格、透明边和比例错误。
4. 付费调用与切片写成一个不可恢复步骤。现在先登记已付费原图，再切片；切片失败从本地原图重放，不再重复计费。
5. 标题可以按单字断行。现在高亮和普通片段都按语义短语换行。
6. 复制按钮过去不等待 Clipboard 结果，可能假成功。现在 Clipboard API 失败会回退到选区复制，仍失败则显示真实失败。
7. 公网生图把所有母版切片原尺寸 Base64 一次返回；Vercel 函数日志是 200，不代表响应成功到达浏览器。现在每张切片按整次单元数自适应压缩，并在 JSON 超过 4 MB 前明确失败。
8. 公网下载先请求只存在于本地 Express 的 `/api/local-export`，异步失败后才 Blob fallback。现在公网从一开始就走浏览器 attachment，本地才使用原子落盘接口。
9. `left-first` 只交换 DOM 顺序、没交换 Grid 列定义，图片和文字会坐进对方的列；标题短语又被强制 nowrap。现在左右顺序和列模板成对绑定，长标题允许语义换行，旧危险位移通过 v11 一次迁移清除。

## 资产落点

- 生产规则：`logic/XHS_GRAPHIC_PRODUCTION_STANDARD.md`
- 工作台体验规则：`logic/WORKBENCH_EXPERIENCE_STANDARD.md`
- 动态母版坐标：`src/mother-sheet-adaptive-regions.mjs`
- 串格边带清理：`src/mother-sheet-artifact-cleanup.mjs`
- 付费断点：`src/image-run-checkpoint.mjs`
- 可重放修复：`scripts/repair-generated-run-assets.mjs`
- 公网切片传输预算：`api/provider.mjs`
- 公网/本地下载分流：`src/download-transport.mjs`
- 安全排版与旧稿迁移：`src/html-layout.mjs`、`src/styles.css` v14
- 真实生成回执：`~/.mesy/runtime/packages/xiaoshimei-studio-v2/artifacts/provider-runs/images-2026-08-30T08-52-49-596Z-c82e63c9.json`
- 最新发布前复核包：`~/Downloads/小师妹-发布包-2026-08-30T13-24-11-537Z-1.zip`
- 最新发布前复核包 SHA-256：`1dc44be370ccc2db178e85e74a8f61fa659e879708e76c6c6067ba9232f92d31`

## 唯一剩余现实条件

如要把“正式版也已修复”写成 PASS，下一步只能是：获得一次明确的公网发布 Human Gate → 推送当前修复分支并生成 Vercel Preview → 在 Preview 用 BYOK 重跑一次真实生图与浏览器下载 → 桌面/窄屏/保存/编辑/ZIP 全通过后提升同一 deployment 到 Production → 正式域名回读。未做之前，正式版保持“事故版本，不能交给小师妹使用”。
