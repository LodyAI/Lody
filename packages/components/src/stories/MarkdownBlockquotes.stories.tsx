import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

const text = `## 合入清单

| PR | 关联 Issue | Commit |
| --- | --- | --- |
| #42 | Fixes #36 | \`a1b2c3d\` |
| #43 | Fixes #37 | \`d4e5f6a\` |

> 连同此前已合入的 **#38** 与 **#39**，全部目标 PR 已落入 \`main\`，发布 PR 会汇总全部 \`.changeset\` 供你发布 **1.18.0**。

普通正文接在引用后面，保持相同的阅读字号。

> 第一段引用，包含 **重点**、\`inline code\` 和 [文档链接](https://example.com)。
>
> 第二段引用。A longer English sentence wraps naturally beside 中文内容。
>
> - 列表中的第一项
> - 列表中的第二项
>
> > 嵌套引用，与外层保持清楚的层次。

> 最后一段引用。`;

const meta: Meta<typeof MarkdownRenderer> = {
  title: 'AI GUI/Markdown Blockquotes',
  component: MarkdownRenderer,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 760, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
  args: { text },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Completed: Story = {};
export const Streaming: Story = { args: { isStreaming: true } };
