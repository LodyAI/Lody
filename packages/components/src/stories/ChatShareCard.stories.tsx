import type { Meta, StoryObj } from '@storybook/react';
import { ChatShareCard, type ChatShareCardMessage } from '@/components/chat-share-card';
import { AgentIcon } from '@/components/icons/agent-icon';

const meta = {
  title: 'Sessions/ChatShareCard',
  component: ChatShareCard,
  parameters: {
    layout: 'centered',
  },
  argTypes: {
    format: {
      control: 'inline-radio',
      options: ['phone', 'desktop'],
      description: 'Chosen by the device sharing; the product never offers it as a control.',
    },
    theme: {
      control: 'inline-radio',
      options: ['light', 'dark'],
      description: 'The palette the card is printed in, independent of the app theme.',
    },
    backdrop: {
      control: 'inline-radio',
      options: ['none', 'lody', 'welcome', 'aurora', 'ocean', 'sunset'],
      description:
        'The ground the card is printed on; part of the exported image. `none` drops the mat, and the sign-off falls back into the caption.',
    },
    destination: {
      control: 'inline-radio',
      options: ['chat', 'post'],
      description:
        'Where the image is going, which is the only thing that sizes the mat. Inert without a ground.',
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof ChatShareCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const demoMeta = {
  name: 'Claude Code',
  params: ['Sonnet 4.5', '~12.4K tokens'],
  date: '2026-09-07 21:38',
  icon: <AgentIcon cliType="builtin" agentType="claude" className="size-5" />,
};

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

export const DesktopLight: Story = {
  args: {
    title: '渲染性能排查',
    messages: multiTurnMessages,
    format: 'desktop',
    theme: 'light',
    backdrop: 'lody',
    destination: 'post',
    meta: demoMeta,
  },
};

export const DesktopDark: Story = {
  args: { ...DesktopLight.args, theme: 'dark' },
};

export const PhoneLight: Story = {
  args: { ...DesktopLight.args, format: 'phone' },
};

export const PhoneDark: Story = {
  args: { ...DesktopLight.args, format: 'phone', theme: 'dark' },
};

/** The only light ground in the set: the sign-off has to ink the other way. */
export const WelcomeBackdrop: Story = {
  args: { ...DesktopLight.args, backdrop: 'welcome' },
};

export const WelcomeBackdropDarkCard: Story = {
  args: { ...DesktopLight.args, backdrop: 'welcome', theme: 'dark' },
};

export const SunsetBackdrop: Story = {
  args: { ...DesktopLight.args, backdrop: 'sunset', theme: 'dark' },
};

/** No mat: the card is the whole image, and `lody.ai` moves into the caption. */
export const NoBackdrop: Story = {
  args: { ...DesktopLight.args, backdrop: 'none' },
};

export const NoBackdropDarkCard: Story = {
  args: { ...DesktopLight.args, backdrop: 'none', theme: 'dark' },
};

/** The two destinations side by side: a thin bleed for a thread, a mat for a feed. */
export const ChatDestination: Story = {
  args: { ...DesktopLight.args, destination: 'chat' },
};

export const ChatDestinationPhone: Story = {
  args: { ...DesktopLight.args, format: 'phone', destination: 'chat' },
};

export const Untitled: Story = {
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
    format: 'phone',
    theme: 'light',
    backdrop: 'welcome',
    destination: 'post',
    meta: demoMeta,
  },
};

// One very long signature line: an image has no horizontal scrollbar, so the
// card must wrap it rather than clip it.
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
      '```',
    ].join('\n'),
  },
];

export const LongCodeLines: Story = {
  args: {
    title: '并发 helper review',
    messages: codeHeavyMessages,
    format: 'desktop',
    theme: 'dark',
    backdrop: 'lody',
    destination: 'post',
    meta: demoMeta,
  },
};
