import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

const meta: Meta<typeof MarkdownRenderer> = {
  title: 'AI GUI/Markdown Emphasis',
  component: MarkdownRenderer,
  args: {
    text: [
      '**检查完成。**接着执行下一步。',
      '前文**“重点”**后文，前文*“提示”*后文。',
      '**確認できました。**次へ進みます。',
      '**확인했습니다。**다음 단계입니다。',
      '`**检查完成。**接着执行下一步。`',
      String.raw`\*\*检查完成。\*\*接着执行下一步。`,
      '**English bold.** Next sentence.',
    ].join('\n\n'),
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Completed: Story = {};
export const Streaming: Story = { args: { isStreaming: true } };
