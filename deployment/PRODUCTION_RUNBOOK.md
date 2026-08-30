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

- 源码权威：`https://github.com/EthanYoQ/agent-xiaohongshu-workbench` 的 `main`。
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

## 当前边界

2026-08-30 开始把此前本地大工作树收敛进 GitHub/Vercel 正式链。完成前，既有正式域名仍是旧构建；不能把本地 v13 设计程序宣称为线上已生效。
