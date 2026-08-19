> **历史快照，已被 `MIGRATION_STATUS_2026-08-20.md` 取代。** 本文件中的 OpenAI 直连配置不再代表当前 4184 运行真相。

# 小师妹 Studio v2 迁移状态

- 新工作目录：`/Users/a1-6/MeSy-Workspace/Projects/Active/Xiaoshimei-Studio-v2`
- Git 分支：`xiaoshimei-v2`
- 运行地址：`http://127.0.0.1:4184`
- 常驻服务：`com.mesy.xiaoshimei-studio-v2`
- 基座：`EthanYoQ/agent-xiaohongshu-workbench`（MIT）
- 直连生成：OpenAI Node SDK + 官方 Quickstart 模式（MIT）
- 当前直连文字模型默认：`gpt-5.4-mini`
- 当前直连图片模型默认：`gpt-image-2`
- API Key：仅由本机后端写入 macOS Keychain，不写浏览器 localStorage
- 直接创作：输入素材 → 结构化文案 → 逐页无字场景图 → 原生中文文字层 → 1080×1440 PNG
- Codex Agent 工作流保留为高级模式，但不再是“直接创作”的依赖
- 测试：50/50 PASS
- 构建：PASS
- HTTP：4184 = 200
- 真实生图探针当前状态：`AI_KEY_MISSING`，尚未伪报成功

## 切换规则

旧版 4174 暂时保留作为回滚。只有 `先测 1 张真实图` 成功后，才把 v2 提升为正式运行端口。
