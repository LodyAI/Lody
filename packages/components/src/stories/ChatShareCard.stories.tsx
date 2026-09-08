import type { Meta, StoryObj } from '@storybook/react';
import type { ComponentProps } from 'react';
import { ChatShareCard, type ChatShareCardMessage } from '@/components/chat-share-card';
import { AgentIcon } from '@/components/icons/agent-icon';

type ShareArgs = ComponentProps<typeof ChatShareCard> & {
  codeWrap?: boolean;
  codeCollapseLines?: number;
};

const meta = {
  title: 'Sessions/ChatShareCard',
  component: ChatShareCard,
  parameters: {
    layout: 'centered',
  },
  argTypes: {
    backdrop: {
      control: 'select',
      options: ['none', 'lody', 'aurora', 'ocean', 'sunset', 'welcome'],
      description: 'Gradient canvas framing the card (part of the exported image).',
    },
    footerVariant: {
      control: 'select',
      options: ['stacked', 'row', 'minimal', 'canvas', 'exif'],
    },
    codeWrap: {
      control: 'boolean',
      description: 'Soft-wrap long code lines (maps to `code.wrap`).',
    },
    codeCollapseLines: {
      control: { type: 'number', min: 0, max: 40, step: 1 },
      description:
        'Collapse code blocks beyond this many rendered lines (maps to `code.collapseAfter`; 0 = off).',
    },
  },
  tags: ['autodocs'],
} satisfies Meta<ShareArgs>;

export default meta;
type Story = StoryObj<ShareArgs>;

const renderShareCard = ({ codeWrap, codeCollapseLines, ...args }: ShareArgs) => (
  <ChatShareCard {...args} code={{ wrap: codeWrap, collapseAfter: codeCollapseLines }} />
);

// Synthetic fixtures only — never real transcripts.
const multiTurnMessages: ChatShareCardMessage[] = [
  {
    id: 'share-user-1',
    role: 'user',
    text: '帮我看一下这个 React 组件为什么在输入框里每敲一个字都会重新渲染整个列表？',
  },
  {
    id: 'share-assistant-1',
    role: 'assistant',
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
      '',
      'return (',
      '  <>',
      '    <input value={query} onChange={(e) => setQuery(e.target.value)} />',
      '    <List items={visibleItems} />',
      '  </>',
      ');',
      '```',
      '',
      '这样 `input` 受控更新只改 `query`，过滤在渲染期按需重算，`List` 拿到的引用在数据没变时保持稳定。',
    ].join('\n'),
  },
];

export const Light: Story = {
  args: {
    title: '渲染性能排查',
    messages: multiTurnMessages,
    backdrop: 'lody',
    footerVariant: 'exif',
    meta: {
      title: 'Claude Code',
      params: ['Sonnet 4.5', '12.4k tokens'],
      sub: '2026-09-07 21:38',
      icon: <AgentIcon cliType="builtin" agentType="claude" className="size-5" />,
    },
    codeWrap: false,
    codeCollapseLines: 0,
  },
  render: renderShareCard,
};

export const Dark: Story = {
  args: {
    title: '渲染性能排查',
    messages: multiTurnMessages,
    backdrop: 'lody',
    footerVariant: 'canvas',
    codeWrap: false,
    codeCollapseLines: 0,
  },
  globals: { theme: 'dark' },
  render: renderShareCard,
};

export const SingleTurn: Story = {
  args: {
    messages: [
      {
        id: 'share-single-user',
        role: 'user',
        text: '用一句话解释什么是闭包。',
      },
      {
        id: 'share-single-assistant',
        role: 'assistant',
        text: '闭包是函数连同它定义时所在作用域的变量一起被打包保存的机制，因此函数即使离开了定义它的作用域，仍然能访问当时的变量。',
      },
    ],
    backdrop: 'lody',
    footerVariant: 'canvas',
  },
  render: renderShareCard,
};

export const NoBackdropDark: Story = {
  args: {
    title: 'Memoizing a filtered list',
    messages: multiTurnMessages,
    backdrop: 'none',
    theme: 'dark',
    footerVariant: 'exif',
    codeWrap: true,
  },
  render: renderShareCard,
};

export const NoBackdropLight: Story = {
  ...NoBackdropDark,
  args: { ...NoBackdropDark.args, theme: 'light' },
};

export const WelcomeBackdrop: Story = {
  ...Light,
  args: { ...Light.args, backdrop: 'welcome' },
};

// Long code block with one very long line, to exercise wrap and collapse.
const codeHeavyMessages: ChatShareCardMessage[] = [
  {
    id: 'share-code-user',
    role: 'user',
    text: '这个并发请求helper帮我review一下，顺便看看有没有更稳的写法。',
  },
  {
    id: 'share-code-assistant',
    role: 'assistant',
    text: [
      '整体思路没问题，补两点：并发上限和单请求超时。改后的版本：',
      '',
      '```ts',
      'async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<R[]> {',
      '  const results: R[] = new Array(items.length);',
      '  let cursor = 0;',
      '  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {',
      '    while (cursor < items.length) {',
      '      if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");',
      '      const index = cursor++;',
      '      results[index] = await withTimeout(task(items[index], index), options?.timeoutMs ?? 10_000);',
      '    }',
      '  });',
      '  await Promise.all(workers);',
      '  return results;',
      '}',
      '',
      'function withTimeout<R>(promise: Promise<R>, timeoutMs: number): Promise<R> {',
      '  return Promise.race([',
      '    promise,',
      '    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),',
      '  ]);',
      '}',
      '```',
      '',
      '首行那一长串签名在截图里默认会横向溢出——用右侧控制面板的 `codeWrap` / `codeCollapseLines` 试试两种处理。',
    ].join('\n'),
  },
];

export const CodeOptions: Story = {
  args: {
    title: '并发 helper review',
    messages: codeHeavyMessages,
    backdrop: 'ocean',
    footerVariant: 'canvas',
    codeWrap: false,
    codeCollapseLines: 8,
  },
  render: renderShareCard,
};
