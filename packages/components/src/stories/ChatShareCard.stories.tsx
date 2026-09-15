import type { Meta, StoryObj } from '@storybook/react';
import { ChatShareCard, type ChatShareCardMessage } from '@/components/share-card/chat-share-card';
import { AgentIcon } from '@/components/icons/agent-icon';

const meta = {
  title: 'Sessions/ChatShareCard',
  component: ChatShareCard,
  parameters: {
    layout: 'centered',
  },
  argTypes: {
    destination: {
      control: 'inline-radio',
      options: ['chat', 'post'],
      description: "The card's own size: `chat` is 360pt, `post` is 560pt.",
    },
    mat: {
      control: { type: 'range', min: 0, max: 96, step: 4 },
      description:
        'Ground showing around the card, in px. Below 12 the sign-off moves into the caption; ignored entirely when `backdrop` is `none`.',
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
        'The ground the card is printed on; part of the exported image. `none` prints the card alone and moves the sign-off into the caption.',
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

export const PostLight: Story = {
  args: {
    title: '渲染性能排查',
    messages: multiTurnMessages,
    destination: 'post',
    mat: 56,
    theme: 'light',
    backdrop: 'lody',
    meta: demoMeta,
  },
};

export const PostDark: Story = {
  args: { ...PostLight.args, theme: 'dark' },
};

export const ChatLight: Story = {
  args: { ...PostLight.args, destination: 'chat', mat: 16 },
};

export const ChatDark: Story = {
  args: { ...PostLight.args, destination: 'chat', mat: 16, theme: 'dark' },
};

/** The slider's tight end: no mat to sign on, so `lody.ai` drops into the caption. */
export const FlushMat: Story = {
  args: { ...PostLight.args, mat: 0 },
};

/** The slider's loose end. */
export const WideMat: Story = {
  args: { ...PostLight.args, mat: 96 },
};

/** The only light ground in the set: the sign-off has to ink the other way. */
export const WelcomeBackdrop: Story = {
  args: { ...PostLight.args, backdrop: 'welcome' },
};

export const WelcomeBackdropDarkCard: Story = {
  args: { ...PostLight.args, backdrop: 'welcome', theme: 'dark' },
};

export const SunsetBackdrop: Story = {
  args: { ...PostLight.args, backdrop: 'sunset', theme: 'dark' },
};

/** No mat: the card is the whole image, and `lody.ai` moves into the caption. */
export const NoBackdrop: Story = {
  args: { ...PostLight.args, backdrop: 'none' },
};

export const NoBackdropDarkCard: Story = {
  args: { ...PostLight.args, backdrop: 'none', theme: 'dark' },
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
    destination: 'chat',
    mat: 16,
    theme: 'light',
    backdrop: 'welcome',
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

// A fenced `diff` renders through `MarkdownDiffBlock`, whose `pre` sets
// `width: max-content` so a wide patch can scroll inside the app. Nothing else
// in this file exercises that path, which is how a clipped diff block reached
// review.
const diffMessages: ChatShareCardMessage[] = [
  {
    id: 'share-diff-user',
    role: 'user',
    text: '你改了哪几行？',
  },
  {
    id: 'share-diff-assistant',
    role: 'assistant',
    text: [
      '就两处，一处是签名，一处是调用点：',
      '',
      '```diff',
      '-export async function exportShareImage(element: HTMLElement, title: string | undefined, fallback: string): Promise<void> {',
      '+export async function exportShareImage(element: HTMLElement, title: string | undefined, fallback: string): Promise<{ saved: boolean }> {',
      '   const blob = await captureShareImage(element);',
      '-    return;',
      '+    return { saved: result.saved === true };',
      '   }',
      '```',
    ].join('\n'),
  },
];

export const DiffBlock: Story = {
  args: {
    title: '导出契约',
    messages: diffMessages,
    destination: 'post',
    mat: 56,
    theme: 'light',
    backdrop: 'lody',
    meta: demoMeta,
  },
};

export const DiffBlockChat: Story = {
  args: { ...DiffBlock.args, destination: 'chat', mat: 16 },
};

export const LongCodeLines: Story = {
  args: {
    title: '并发 helper review',
    messages: codeHeavyMessages,
    destination: 'post',
    mat: 56,
    theme: 'dark',
    backdrop: 'lody',
    meta: demoMeta,
  },
};
