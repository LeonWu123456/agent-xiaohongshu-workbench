# Task View

```mermaid
flowchart LR
  CAP_CREATE["CAP-CREATE<br/>小红书图文端到端生产"]
  BLOCK_IMAGE["BLOCK-IMAGE<br/>插图生成与母版切片"]
  FLOW_MOTHER_SHEET["FLOW-MOTHER-SHEET<br/>母版切片与媒体角色适配"]
  BLOCK_EDITOR["BLOCK-EDITOR<br/>HTML/Fabric 编辑与导出"]
  FLOW_EXPORT["FLOW-EXPORT<br/>发布包导出验证"]
  STATE_REALITY["STATE-REALITY<br/>24h/72h/7d Reality Feedback"]
  POL_REALITY["POL-REALITY<br/>Reality > actor narrative"]
  EVD_IMAGE_TEST["EVD-IMAGE-TEST<br/>母版切片回归测试"]
  EVD_EXPORT_TEST["EVD-EXPORT-TEST<br/>导出图片真实性测试"]
  EVD_REALITY_TEST["EVD-REALITY-TEST<br/>现实反馈持久化测试"]
  CAP_CREATE -->|contains| BLOCK_IMAGE
  CAP_CREATE -->|contains| BLOCK_EDITOR
  CAP_CREATE -->|contains| STATE_REALITY
  BLOCK_IMAGE -->|contains| FLOW_MOTHER_SHEET
  BLOCK_EDITOR -->|contains| FLOW_EXPORT
  FLOW_MOTHER_SHEET -->|constrained_by| POL_REALITY
  FLOW_EXPORT -->|constrained_by| POL_REALITY
  STATE_REALITY -->|constrained_by| POL_REALITY
  FLOW_MOTHER_SHEET -->|verified_by| EVD_IMAGE_TEST
  FLOW_EXPORT -->|verified_by| EVD_EXPORT_TEST
  STATE_REALITY -->|verified_by| EVD_REALITY_TEST
```

## Problems
- `D08` · RESOLVED_CONFIRMED · 固定 2% 内缩不识别真实网格线和背景
- `D13` · RESOLVED_CONFIRMED · Fabric 导出缺 blank/flat/image-region QA
- `D17` · RESOLVED_PRODUCTION_V15 · Production `dpl_Cj8uAE9utVX3oyLf6auJHMi824kj` 命中已验收 CSS；长封面标题、5 页导出、桌面/窄屏无 overflow，标题与交错图文由结构性 containment 约束
- `D24` · RESOLVED_PRODUCTION_DOWNLOAD · 公网发布包先生成校验，再由可见下载链接保存；Chrome 实物已落到 Desktop，ZIP CRC 与 5×1080×1440 PNG 通过；正式域名命中同一 JS
- `D29` · RESOLVED_PRODUCTION_REAL_GENERATION · Preview `dpl_EkcAFfJdCmcBxjzQCMkkwJdtF7ZE` 已用 BYOK 完成真实付费母版并回到浏览器；生成链随后未改，最终同构制品已提升至 Production
- `D20` · OPEN_CONFIRMED · Reality feedback 已有但未进入 layout/crop fitness
