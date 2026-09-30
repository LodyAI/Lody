# Markdown 公式渲染

Status: draft
Translation: current

[English](markdown-math-rendering.md)

用户在外观设置中开启行内公式后，Markdown 内容会将 `$...$` 和
`\(...\)` 排版为行内 KaTeX，同时继续支持 `$$...$$` 和处于块起始位置的
`\[...\]` 块级公式。嵌入正文且在同一行完成的 `\[...\]` 配对会按行内
公式排版；跨行配对会与前后正文分开并按块级公式排版，同时保留引用和列表
前缀。该选项保存在客户端本地，重启后保留，默认关闭，以保持现有对话的
源码可读性。代码 span、围栏代码、缩进代码、链接和工具调用负载仍按字面
显示；该选项不改变块级公式。

共享 Markdown 渲染器统一管理这个选项，因此聊天、预览、技能和评论使用
相同规则。静态和流式路径使用相同的定界符归一化及 remark/rehype 插件配置。
不完整的行内定界符在形成完整配对前保持文本。

## 证据

- 实现：[Markdown 渲染器](../packages/components/src/components/ai-gui/markdown-renderer.tsx)、[公式定界符](../packages/components/src/lib/markdown-single-dollar-math.ts) 和 [外观设置](../packages/components/src/components/settings/appearance-setting.tsx)。
- 验证：[渲染测试](../packages/components/tests/markdown-streaming-reparse.test.ts)、[定界符测试](../packages/components/tests/markdown-math-delimiters.test.ts) 和 [设置测试](../packages/components/tests/appearance-settings.test.tsx)。
- 决策：[行内公式选项记录](../.agents/notes/implemented/feature/2026-09-28-inline-math-preference.zh.md)。
- 修正：[块级公式上下文记录](../.agents/notes/implemented/bug-fix/2026-09-29-inline-display-math-block-context.zh.md)。
