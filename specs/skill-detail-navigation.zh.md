# Skills 详情导航

Status: draft
Translation: current

[English](skill-detail-navigation.md)

在 Settings → Projects → Skills 中，技能详情将现有 Markdown 展示为只读文档。
仅包含片段的链接，例如 `#handle-rebase-conflicts-agent-workflow`，应在当前详情中
导航，即使宿主页面处于其他路由。

标题按渲染后的文本生成 GitHub 风格的 slug。保留中文，内联格式贡献其文本；重复标题
按文档顺序使用 `-1`、`-2` 等后缀，嵌套标题也参与同一序列。百分号编码的片段指向相同
标题。导航滚动到当前详情中的匹配标题并聚焦它，不改变宿主 URL 或打开新标签页。
目标不存在或片段编码无效时，详情保持打开且不导航。

外部链接保留现有外链行为。关闭桌面详情保留 Skills 搜索词，并将焦点返回打开详情的
控件。技能源文件不被改写。降级渲染器为其能够渲染的标题提供锚点；现有 Markdown
子集并非完整解析器。

## 证据

- [详情界面](../packages/components/src/components/settings/skill-detail.tsx)
- [Markdown 渲染器](../packages/components/src/components/ai-gui/markdown-renderer.tsx)
- [降级渲染器](../packages/components/src/components/settings/skill-markdown.tsx)
- [回归测试](../packages/components/tests/skill-markdown.test.tsx)
- [决策与验证边界](../.agents/notes/implemented/bug-fix/2026-10-01-skill-detail-anchors.zh.md)
