# 小师妹工作台完整 Dogfood｜TaskSpec × 逻辑地图对照

日期：2026-08-30

## 结论

上午的本地完整创作链确实走通过，但随后正式站暴露了两个会阻断交付的生产事故：`generate-images` 函数返回 200 后浏览器仍 `Failed to fetch`，以及公网下载错误地先调用本地专用 `/api/local-export`。因此本文件此前的“正式版可用”结论被现实推翻，不再沿用。

发布 Human Gate 已获批准，修复分支随后完成公网 Reality 回读：Preview `dpl_EkcAFfJdCmcBxjzQCMkkwJdtF7ZE` 用 BYOK 走通真实付费母版生成、缺格自动补绘、3 页/3 图回到浏览器并可编辑；最终 Preview `dpl_E3eLycjdGTLSRXRKgtTJVYZmrJG4` 追加 v15 标题换行、可见下载链接和 redo 保护。268/268 tests、生产构建、长标题、改字/撤销/重做、保存刷新、无 Key 401、ZIP 实际落盘、CRC、5 张 1080×1440 PNG 和逐页像素边距均通过。

这仍不等于公网正式版已经更新：当前 Vercel Production 仍是事故版本。Preview 与真实付费生成 Gate 已通过，下一步只能把同一最终候选提升到 Production，再回读稳定域名；外部小红书发布和读者效果仍未执行。

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
| A15 导出 | PASS | 最终 Preview 的用户式下载实物：`~/Desktop/小师妹-发布包-最终预览QA-20260830.zip`；8 文件 CRC PASS；5 PNG 均 1080×1440；SHA-256 `da279675ee39ba78e5f756e0c86dc7b2eb3e6cdb01bed920afda55dbb6ea5438` |
| A16 参考 | PASS | 封面大字两行、正文纵向节奏、插图服务对应段落，不是等权 PPT 九宫格 |
| A17 全旅程 | PASS（本地关键链） | 生成、确认、翻页、取景、撤销、保存、刷新、复制、下载、桌面与窄屏均现场执行 |

## 五层真相

| 层 | 结果 |
|---|---|
| mechanism_ready | PASS_PREVIEW：动态母版分隔线、缺格有界补绘、传输预算、语义标题换行、redo 保护与两段式下载均已实现并进入 Preview |
| package_verified | PASS_PREVIEW_ZIP：268/268 tests，Vite build，ZIP CRC，5 张 1080×1440 PNG 逐页目检与像素边距回读 |
| production_applied | FAIL_CURRENT：Vercel Production `dpl_Afw8Q5Vai578FVs11waZvd24CYBp` 未包含本轮传输、下载和 v14 排版修复 |
| runtime_operational | PASS_PREVIEW：真实 BYOK 付费生图返回浏览器；编辑、undo/redo、保存刷新和 Chrome ZIP 落盘通过 |
| reality_validated | PASS_PREVIEW_DOGFOOD：公网 Preview 关键旅程可用；Production 稳定域名和外部平台效果待验证 |

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
10. `record:false` 的布局初始化过去会把 redo future 清空；撤销一落地，重做立刻失效。现在非记录性初始化默认保留 future，只有明确的新语义编辑才清空。
11. 异步渲染结束后自动点击隐藏 Blob 链接，页面提示成功却缺少可见的用户动作。现在先生成并校验 ZIP，再出现真实“保存发布包”链接；最终 Preview 的 Chrome 下载实物已回读。

## 资产落点

- 生产规则：`logic/XHS_GRAPHIC_PRODUCTION_STANDARD.md`
- 工作台体验规则：`logic/WORKBENCH_EXPERIENCE_STANDARD.md`
- 动态母版坐标：`src/mother-sheet-adaptive-regions.mjs`
- 串格边带清理：`src/mother-sheet-artifact-cleanup.mjs`
- 付费断点：`src/image-run-checkpoint.mjs`
- 可重放修复：`scripts/repair-generated-run-assets.mjs`
- 公网切片传输预算：`api/provider.mjs`
- 公网/本地下载分流：`src/download-transport.mjs`
- 安全排版与旧稿迁移：`src/html-layout.mjs`、`src/styles.css` v15
- 真实生成回执：`~/.mesy/runtime/packages/xiaoshimei-studio-v2/artifacts/provider-runs/images-2026-08-30T08-52-49-596Z-c82e63c9.json`
- 最新传输/排版 QA 夹具：`~/Downloads/小师妹-QA夹具-传输排版-20260830.zip`（白底几何测试图，不是待发布内容）
- QA 夹具 ZIP SHA-256：`1dc44be370ccc2db178e85e74a8f61fa659e879708e76c6c6067ba9232f92d31`
- 最终 Preview：`dpl_E3eLycjdGTLSRXRKgtTJVYZmrJG4`，URL `https://xiaoshimei-full-workbench-7lnsp2620-892350620-5733s-projects.vercel.app/`
- 公网真实生成 Preview：`dpl_EkcAFfJdCmcBxjzQCMkkwJdtF7ZE`
- 最终 Preview 下载实物：`~/Desktop/小师妹-发布包-最终预览QA-20260830.zip`，SHA-256 `da279675ee39ba78e5f756e0c86dc7b2eb3e6cdb01bed920afda55dbb6ea5438`

## 唯一剩余现实条件

如要把“正式版也已修复”写成 PASS，唯一剩余条件是：合并当前已验收提交到 fork `main` → 提升最终 Preview `dpl_E3eLycjdGTLSRXRKgtTJVYZmrJG4` 到 Production → 回读稳定域名的 deployment、HTML/JS/CSS、无 Key 401、编辑保存和下载入口。未完成前，正式版仍保持“事故版本，不能交给小师妹使用”。
