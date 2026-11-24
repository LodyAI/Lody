import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

const text = `### Ordered task list

1. [ ] 触发一次 \`release\` CI 出正式签名包，用自己生产账号开 **Developer mode** 做最后冒烟（重点补测 \`https://lody.ai\` **Web 端 Passkey** + 生产 APNs + CI 公证包打开正常）
2. [x] 拆掉 e2eeWorkspaces.ts 的 \`developerMode: true\` 与 \`activation: 'control-only'\` 锁，正式开放 GA

### Unordered task list

- [ ] First unchecked task item with wrapping prose that continues cleanly on the next line aligned with the text start.
- [x] Completed task item
  - Regular nested bullet under a task item
  - [ ] Nested unchecked task item

### Mixed lists

1. First regular ordered item
2. [ ] Task item inside an ordered list
3. Third regular ordered item

- Regular unordered item
- [ ] Task item inside an unordered list`;

const meta: Meta<typeof MarkdownRenderer> = {
  title: 'AI GUI/Markdown Task Lists',
  component: MarkdownRenderer,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, padding: 24 }}>
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
