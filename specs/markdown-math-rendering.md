# Markdown math rendering

Status: draft
Translation: current

[中文](markdown-math-rendering.zh.md)

When a reader enables inline math in Appearance settings, Markdown content
renders `$...$` and `\(...\)` as inline KaTeX while keeping display math
available through `$$...$$` and block-positioned `\[...\]` delimiters. A
`\[...\]` opener embedded in paragraph text is not promoted to a display
block. The preference is local to the
client, persists across launches, and defaults off so existing conversations
remain readable source. Code spans, fenced code, indented code, links, and tool
payloads remain literal; display math is unchanged by the preference.

The shared Markdown renderer owns the preference for chat, previews, skills, and
comments. Static and streaming paths use the same delimiter normalization and
remark/rehype plugin set. A malformed or incomplete inline delimiter remains
text until a complete pair is present.

## Evidence

- Implementation: [Markdown renderer](../packages/components/src/components/ai-gui/markdown-renderer.tsx), [math delimiters](../packages/components/src/lib/markdown-single-dollar-math.ts), and [appearance settings](../packages/components/src/components/settings/appearance-setting.tsx).
- Verification: [renderer tests](../packages/components/tests/markdown-streaming-reparse.test.ts), [delimiter tests](../packages/components/tests/markdown-math-delimiters.test.ts), and [settings tests](../packages/components/tests/appearance-settings.test.tsx).
- Decision: [inline math preference note](../.agents/notes/implemented/feature/2026-09-28-inline-math-preference.md).
- Correction: [display math block context note](../.agents/notes/implemented/bug-fix/2026-09-29-inline-display-math-block-context.md).
