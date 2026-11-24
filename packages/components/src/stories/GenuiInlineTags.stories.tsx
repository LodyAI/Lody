import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

const meta = {
  title: 'AI GUI/GenUI Inline Tags',
  component: MarkdownRenderer,
  tags: ['autodocs'],
  args: { allowHtml: true },
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

const checkTable = `| 检查项 | #2620 | #3041 |
|---|---|---|
| CLI tests 1/2 | <icon name="x-circle" color="danger" inline/> 失败 | <icon name="x-circle" color="danger" inline/> 失败 |
| Lint | <icon name="check" color="success" inline/> 通过 | <icon name="check" color="success" inline/> 通过 |`;

const prose = `部署已完成 <icon name="check" color="success" inline/>，两个服务在线 <badge tone="success">running</badge>，一个仍在启动 <badge tone="warning">pending</badge>。`;

export const InTable: Story = {
  args: { text: checkTable },
};

export const InProse: Story = {
  args: { text: prose },
};

export const StreamingPartial: Story = {
  args: { text: 'status: <icon name="x-ci', isStreaming: true },
};
