# 小师妹迁移与运行真相｜2026-08-20

- 对外本地入口：`http://127.0.0.1:4184`
- 4184 常驻壳：`server/index.mjs`
- canonical UI 原件：`../Xiaoshimei-Studio`
- runtime build：`~/.mesy/runtime/xiaoshimei-studio/dist`
- 真实生成 Provider：`http://127.0.0.1:4175`
- Provider：`volcengine-ark`
- 当前文字模型：`doubao-seed-2-0-lite-260428`
- 当前图片模型：`doubao-seedream-5-0-lite-260128`
- Provider health：`LIVE_VERIFIED`（本次回读）
- Key：本机 Keychain / 运行环境，不进入浏览器 localStorage

## 当前职责

`../Xiaoshimei-Studio` 负责 UI、两阶段内容生产、对象编辑、状态、保存/回载、发布包、账号档案、研究桥和现实反馈。

本仓库当前负责 GitHub 基座、4184 server/API 壳与迁移/评测证据；不得维护第二套活动前端覆盖 canonical UI。

## 当前验证

- canonical tests：108/108 PASS
- production build：PASS
- 4184 HTTP：200
- 桌面真实 Chrome：PASS
- 390×844 移动端：PASS
- 移动编辑面板 5 步创作轨道：PASS
- 创作流收起后文案持续可见：PASS

2026-08-19 的 OpenAI 直连状态文件保留为历史，不再代表当前运行配置。
