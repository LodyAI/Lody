# 切换用量重置时间格式

Status: implemented
Translation: current

[English](2026-10-10-usage-reset-time-toggle.md)

## 摘要

输入框额度详情原本只显示相对重置时间，但数据已经是绝对 Unix 时间戳。
现在每行使用共享 UI 按钮和已有的 Lucide ArrowLeftRight 图标，在相对时间与绝对时间之间切换。
绝对日期按产品语言和本地时区显示。各行只在挂载期间保留选择。

## 决策

此变更扩展[用量指示器](../bug-fix/2026-10-01-five-hour-usage-indicator.zh.md)。
`ResetTime` 负责显示状态，使用 `resetsAtEpochSeconds`，不修改协议。
无时间戳的行不显示按钮。本地化无障碍名称和标题说明目标格式，绝对时间可在窄弹窗内换行。

## 验证

现有 `ContextAndQuota` 和 `QuotaOnly` stories 可展示控件。两个用量测试套件共 20 项通过，
Oxfmt 和翻译键检查通过。Chromium 在真实 QuotaOnly story 中验证了中英文桌面（1000px）和
窄屏（375px）布局、各行独立切换、点击切至绝对时间及 Enter 切回相对时间，页面无运行错误。
已检查截图。本地 Storybook 已登记到 Lody Preview，未验证完整桌面应用集成。
文档检查仍报告指向缺失 ACP 子模块文件的已有链接。

仓库 `pnpm format` 通过。全量 `pnpm check` 在类型检查阶段停止，原因是仅安装了 UI 工作区
依赖，其他包依赖缺失（例如 `packages/ignore` 无法解析 `effect` 和 Node 类型）。

PR: [#1416](https://github.com/LodyAI/Lody/pull/1416).
