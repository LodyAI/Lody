import type { Meta, StoryObj } from '@storybook/react';
import { useState, type ComponentProps } from 'react';
import type { ConversationMessage, SessionMeta } from '@lody/shared';
import { ChatShareImageDialog } from '@/components/sessions/chat-share-image-dialog';

const meta = {
  title: 'Sessions/ChatShareImageDialog',
  component: ChatShareImageDialog,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ChatShareImageDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// Synthetic fixtures only — never real transcripts.
const multiTurnMessages: ConversationMessage[] = [
  {
    id: 'share-user-1',
    role: 'user',
    text: '帮我看一下这个 React 组件为什么在输入框里每敲一个字都会重新渲染整个列表？',
  },
  {
    id: 'share-assistant-1',
    role: 'assistant',
    modelName: 'Sonnet 4.5',
    text: [
      '问题在于 `onChange` 里直接调用了 `setItems(filter(items))`，每次按键都会生成一个新数组，导致整个 `<List>` 重新渲染。',
      '',
      '两个改法：',
      '',
      '1. 用 `useMemo` 缓存过滤结果，只在 `query` 或原始数据变化时重算；',
      '2. 把列表行抽成 `memo` 组件，行 props 不变就跳过重渲染。',
    ].join('\n'),
  },
  {
    id: 'share-user-2',
    role: 'user',
    text: '改成 useMemo 的话具体怎么写？',
  },
  {
    id: 'share-assistant-2',
    role: 'assistant',
    modelName: 'Sonnet 4.5',
    text: [
      '把过滤逻辑移出事件回调，变成派生状态：',
      '',
      '```tsx',
      'const [query, setQuery] = useState("");',
      '',
      'const visibleItems = useMemo(',
      '  () => items.filter((item) => item.name.includes(query)),',
      '  [items, query],',
      ');',
      '```',
      '',
      '这样 `input` 受控更新只改 `query`，过滤在渲染期按需重算，`List` 拿到的引用在数据没变时保持稳定。',
    ].join('\n'),
  },
];

const demoSession = {
  id: 'session-share-demo',
  machineId: 'machine-local',
  userId: 'user-local',
  createdAt: '2026-09-07T21:38:00.000Z',
  contextWindowUsage: { size: 200_000, used: 12_400 },
  title: '渲染性能排查',
  cliType: 'builtin',
  agentType: 'claude',
} as SessionMeta;

function DialogHarness(args: ComponentProps<typeof ChatShareImageDialog>) {
  const [open, setOpen] = useState(args.open);
  return <ChatShareImageDialog {...args} open={open} onOpenChange={setOpen} />;
}

const renderDialog: Story['render'] = (args) => <DialogHarness {...args} />;

export const Default: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    session: demoSession,
    messages: multiTurnMessages,
  },
  render: renderDialog,
};

export const NoSession: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    session: null,
    messages: multiTurnMessages,
  },
  render: renderDialog,
};

export const CustomRuntime: Story = {
  ...Default,
  args: {
    ...Default.args,
    session: { ...demoSession, cliType: 'custom', agentType: 'synthetic-custom-runtime' },
    agentName: 'Local Coding Agent',
  },
};
