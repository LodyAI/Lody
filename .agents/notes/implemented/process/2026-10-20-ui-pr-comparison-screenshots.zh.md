# 推荐不含私人数据的 UI 前后对比截图

Status: implemented
Translation: current
PR: [#1744](https://github.com/LodyAI/Lody/pull/1744)

[English](2026-10-20-ui-pr-comparison-screenshots.md)

## 摘要

UI PR 有时只描述可见变化而不展示结果，评审者需要自行复现前后两个版本。
现在 PR 模板推荐附上标注清楚的修改前后截图，可视化指南说明 Agent 如何在实现过程中
使用合成数据采集对比。隐私优先：作者在分享前检查导出图片，再作为 GitHub 附件上传，
不把评审截图放进提交。截图并非强制要求，
不提供也无需解释；这条建议没有增加自动检查门槛。

## 决定

现有的[可视化说明决定](2026-09-08-required-pr-visual-explanations.zh.md)要求复杂改动
提供结构图。截图对比回答的是另一个问题：评审者在 UI 修改前后会看到什么。
建议放在 PR 模板已有的 Before / after 部分，GitHub 贡献规范已经要求 Agent 阅读模板。
[可视化指南](../../../docs/visual-explanations.md#ui-screenshots)负责说明采集、隐私和展示方式。
没有向接近大小上限的根目录或 GitHub `AGENTS.md` 增加新的指令。

截图使用真实 UI 或所属的 Storybook 示例，并保持可比较的界面状态、视口和主题。
使用合成数据和隔离的开发场景，可以在截图前减少隐私暴露；公开上传前，
检查最终裁剪或遮盖后的导出图片，确认其中没有私人内容。禁止提交捕获的用户或 Agent
对话记录的规则继续有效。评审者应能访问安全的图片，不能只有本地路径。

附件说明明确：仅供 PR 评审的截图放在临时或已忽略的目录，不纳入 Git 提交。
GitHub CLI 的 `gh pr create --attach` 和 `gh pr edit --attach` 支持直接上传，
并把完整正文文件中匹配的本地 Markdown 图片引用替换为附件链接。
指南提供修改前后两张图的具体命令。

作者自行决定是否附上截图，不提供也无需解释。现有必填模板标题和结构图校验器
均保持不变。

## 验证

附件说明仅修改文档。已有 PR 模板与策略测试共 23 项全部通过；本机
`gh pr create --help` 和 `gh pr edit --help` 确认支持附件上传及本地图片引用替换。
`pnpm format` 通过。文档检查保留原有六个 Kimi/Pi 子模块缺失链接，没有新增错误或
保护主题变化。本次文档说明未重跑完整类型、构建和运行时检查。
模板标题、校验器和运行时代码均未改变。
