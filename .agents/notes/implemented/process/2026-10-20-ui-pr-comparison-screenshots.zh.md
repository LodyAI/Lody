# 推荐不含私人数据的 UI 前后对比截图

Status: implemented
Translation: current
PR: [#1744](https://github.com/LodyAI/Lody/pull/1744)

[English](2026-10-20-ui-pr-comparison-screenshots.md)

## 摘要

UI PR 有时只描述可见变化而不展示结果，评审者需要自行复现前后两个版本。
现在 PR 模板推荐附上标注清楚的修改前后截图，可视化指南说明 Agent 如何在实现过程中
使用合成数据采集对比。隐私优先：作者在分享前检查导出图片。截图并非强制要求，
不提供也无需解释；这条建议没有增加自动检查门槛。

## 决定

现有的[可视化说明决定](2026-09-08-required-pr-visual-explanations.zh.md)要求复杂改动
提供结构图。截图对比回答的是另一个问题：评审者在 UI 修改前后会看到什么。
建议放在 PR 模板已有的 Before / after 部分，GitHub 贡献规范已经要求 Agent 阅读模板。
[可视化指南](../../../docs/visual-explanations.md#ui-screenshots)负责说明采集、隐私和展示方式。
没有向接近大小上限的根目录或 GitHub `AGENTS.md` 增加新的指令。

截图使用真实 UI 或所属的 Storybook 示例，并保持可比较的界面状态、视口和主题。
使用合成数据和隔离的开发场景，可以在截图前减少隐私暴露；提交或公开上传前，
检查最终裁剪或遮盖后的导出图片，确认其中没有私人内容。禁止提交捕获的用户或 Agent
对话记录的规则继续有效。评审者应能访问安全的图片，不能只有本地路径。

作者自行决定是否附上截图，不提供也无需解释。现有必填模板标题和结构图校验器
均保持不变。

## 验证

本次仅修改文档。已有 PR 模板与策略测试共 23 项全部通过，包含完整正文和拒绝案例。
`pnpm format` 和完整 `pnpm check` 均已通过。文档检查仅保留 subagent-events 双语笔记中
原有的六个 Kimi/Pi 子模块缺失链接，没有新增错误或需要审阅的 SHA 保护主题变化。
本次没有改变 UI 渲染行为。
