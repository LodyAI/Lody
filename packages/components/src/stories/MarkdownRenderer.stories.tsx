import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState, type ReactNode } from 'react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';

const meta = {
  title: 'AI/MarkdownRenderer',
  component: MarkdownRenderer,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: { type: 'number', min: 9, max: 32, step: 1 },
    },
  },
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

// Mirror the production assistant-message container so stories render the
// markdown under the same wrapper styles as the assistant content path
// (`AssistantChatItem` → `renderAssistantContent` → `MarkdownBlock`) in
// `components/ai-gui/view.tsx` (py-2.5 / px-2 / text-sm / max-w-[800px]). The
// outer rounded border is story-only chrome and is not applied in production.
const wrap = (children: ReactNode) => (
  <div className="w-[820px] rounded-xl border border-border bg-background">
    <div className="max-w-[800px] break-words py-2.5 text-sm text-foreground">
      <div className="px-2">{children}</div>
    </div>
  </div>
);

export const Paragraphs: Story = {
  args: {
    size: 'default',
    text: [
      'This is the first paragraph with some **bold** and _italic_ text.',
      '',
      'This is the second paragraph. It should have comfortable vertical spacing.',
      '',
      'A third paragraph to check last-child spacing.',
    ].join('\n'),
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

export const ListsAndBlockquote: Story = {
  args: {
    size: 'default',
    text: [
      'A list:',
      '',
      '- First item',
      '- Second item with a nested list:',
      '  - Nested item A',
      '  - Nested item B',
      '',
      'A blockquote:',
      '',
      '> This is a blockquote.',
      '> It should have a left border and spacing.',
    ].join('\n'),
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

export const LooseListWithMultiParagraphItems: Story = {
  args: {
    size: 'default',
    text: [
      'Quint 会让你更轻松的任务',
      '',
      '1. **描述状态机/协议行为**',
      '',
      '   例如账户转账、共识投票、两阶段提交、缓存一致性、权限流转。你写 `init`、`step`、`action`、`nondet`，不用手工展开 `s0, s1, ..., sk` 和转移约束。',
      '',
      '2. **检查 safety invariant**',
      '',
      '   比如"余额不会为负""不会两个 leader 同时被提交""锁不会被两个进程同时持有"。Quint 的主路径就是写模型、写 invariant，然后 `quint run` 或 `quint verify`。',
      '',
      '3. **寻找可复现反例 trace**',
      '',
      '   直接用 Z3 通常给你一个 model；Quint 会把结果还原成状态序列，更像"重现步骤"。这对调试协议设计很有价值。',
      '',
      '4. **表达 nondeterminism 和 interleaving**',
      '',
      '   网络延迟、消息丢失、随机选一个节点、任意执行某个 actor，这些在 Quint 中比较自然；直接 Z3 要自己编码选择变量、路径和约束。',
    ].join('\n'),
  },
  parameters: {
    docs: {
      description: {
        story:
          'Loose lists (blank lines between items) wrap each item in `<p>` tags. The between-item gap must visibly exceed the within-item paragraph gap, or items merge into each other.',
      },
    },
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

export const CodeBlocks: Story = {
  args: {
    size: 'default',
    text: [
      'Inline code: `pnpm --filter @lody/components storybook`',
      '',
      'Fenced code with language:',
      '',
      '```ts',
      'export const hello = (name: string) => `Hello, ${name}`;',
      '```',
      '',
      'Fenced code without language:',
      '',
      '```',
      'echo "hello"',
      '```',
    ].join('\n'),
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

export const DiffCodeBlocks: Story = {
  name: 'Diff Code Blocks',
  args: {
    size: 'default',
    text: [
      'Headerless explanatory diffs are the common chat form:',
      '',
      '```diff',
      ' resolveSessionMentionProjectSource(session)',
      '-  if codeCollabProvider or providerPending',
      '-    return provider                    # won even on this machine',
      '+  if no localFileSource',
      '+    and (codeCollabProvider or providerPending)',
      '+    return provider                    # remote machine only',
      '   if localFileSource is session-worktree  -> local + worktree',
      '   if localFileSource is local-project     -> local',
      '   if repoFullName                         -> github',
      '```',
      '',
      'Full unified patches keep their metadata and hunk rows distinct:',
      '',
      '```diff',
      'diff --git a/list-files.ts b/list-files.ts',
      'index 4f5f1c2..8a629bb 100644',
      '--- a/list-files.ts',
      '+++ b/list-files.ts',
      '@@ -1,2 +1,1 @@',
      '-git ls-files -z',
      '-git ls-files --others --exclude-standard -z',
      '+git ls-files -z --cached --others --exclude-standard',
      '```',
    ].join('\n'),
  },
  parameters: {
    docs: {
      description: {
        story:
          'Diff fences use a lightweight row renderer that supports explanatory snippets, full unified patches, and incomplete streaming fences without requiring patch parsing.',
      },
    },
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

export const CodeBlockPaddingSymmetry: Story = {
  name: 'Code Block Layout',
  args: {
    size: 'default',
    text: [
      'Single-line code blocks stay compact and vertically centered, with the',
      'language label floating in the top-right corner.',
      '',
      '```ts',
      'const answer = 42;',
      '```',
      '',
      '```bash',
      'pnpm --filter @lody/components storybook',
      '```',
      '',
      'A short multi-line block keeps the same compact frame:',
      '',
      '```tsx',
      'export const Hello = ({ name }: { name: string }) => (',
      '  <span>Hello, {name}</span>',
      ');',
      '```',
      '',
      'A block without a language fence has no label and keeps the same compact body:',
      '',
      '```',
      'echo "no language"',
      '```',
      '',
      'A long first line scrolls the full width and slides beneath the floating label:',
      '',
      '```ts',
      "const command = 'pnpm --filter @lody/components exec vitest run tests/markdown-streaming-reparse.test.ts --reporter=verbose';",
      '```',
    ].join('\n'),
  },
  parameters: {
    docs: {
      description: {
        story:
          'Verifies the Streamdown code block frame: compact, vertically centered single-line height, symmetric multi-line padding, no reserved rail (the language label and copy action float as top-right overlays), and full-width horizontal scroll for long lines.',
      },
    },
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

const allMarkdownFormatsText = [
  '# Markdown coverage',
  '',
  'A dense fixture for checking typography, spacing, GFM, code highlighting, math, Mermaid, links, and long content in one pass.',
  '',
  '## Inline formatting',
  '',
  'Plain text with **bold**, _italic_, ***bold italic***, ~~strikethrough~~, `inline code`, [named links](https://example.com/docs), autolinks https://example.com/a/b?x=1, email test@example.com, and trailing punctuation https://example.com/path).',
  '',
  'Escaped markdown characters: \\*not italic\\*, \\`not code\\`, and \\[not a link\\].',
  '',
  '## Headings',
  '',
  '### Heading level 3',
  '',
  '#### Heading level 4',
  '',
  '##### Heading level 5',
  '',
  '###### Heading level 6',
  '',
  '---',
  '',
  '## Lists',
  '',
  '- Unordered item one',
  '- Unordered item two with nested content:',
  '  - Nested bullet A',
  '  - Nested bullet B with `inline code`',
  '    1. Nested ordered item',
  '    2. Another nested ordered item',
  '- Task list states:',
  '  - [x] Finished task',
  '  - [ ] Pending task',
  '',
  '1. Ordered item one',
  '2. Ordered item two',
  '3. Ordered item three',
  '',
  '## Blockquotes',
  '',
  '> A blockquote with **formatting** and a link https://example.com.',
  '>',
  '> - Quoted list item',
  '> - Another quoted list item',
  '',
  '## Code',
  '',
  'Inline code should stay compact: `pnpm --filter @lody/components storybook`.',
  '',
  'TypeScript fenced code should preserve line breaks and syntax highlighting:',
  '',
  '```tsx',
  'type Message = {',
  '  id: string;',
  '  text: string;',
  '  metadata?: Record<string, unknown>;',
  '};',
  '',
  'export function renderMessage(message: Message) {',
  '  if (!message.text.trim()) {',
  '    return null;',
  '  }',
  '',
  '  return <article data-message-id={message.id}>{message.text}</article>;',
  '}',
  '```',
  '',
  'Shell fenced code:',
  '',
  '```bash',
  'pnpm --filter @lody/components typecheck',
  'pnpm --filter @lody/components exec vitest run tests/markdown-streaming-reparse.test.ts',
  '```',
  '',
  'JSON fenced code:',
  '',
  '```json',
  '{',
  '  "name": "lody",',
  '  "features": ["markdown", "streaming", "syntax-highlighting"],',
  '  "enabled": true',
  '}',
  '```',
  '',
  'A long code line should scroll instead of destroying layout:',
  '',
  '```ts',
  'const veryLongLine = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
  '```',
  '',
  'Fenced code without language:',
  '',
  '```',
  'first line',
  'second line',
  'third line',
  '```',
  '',
  '## Tables',
  '',
  '| Feature | Status | Notes |',
  '| --- | --- | --- |',
  '| GFM table | Supported | Should have borders and readable spacing |',
  '| Inline code | `ok` | Code inside cells should remain inline |',
  '| Links | [docs](https://example.com) | Links remain clickable |',
  '',
  'A wide table should be horizontally scrollable:',
  '',
  '| ID | File | Description | Long value | Status | Owner |',
  '| --- | --- | --- | --- | --- | --- |',
  '| 1 | packages/components/src/components/ai-gui/markdown-renderer.tsx | Markdown renderer fixture | abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz-abcdefghijklmnopqrstuvwxyz | Active | UI |',
  '| 2 | packages/components/src/stories/MarkdownRenderer.stories.tsx | Storybook coverage | 1234567890-1234567890-1234567890-1234567890-1234567890 | Review | Components |',
  '',
  '## Math',
  '',
  'Inline math: $E = mc^2$ and $a^2 + b^2 = c^2$.',
  '',
  '$$',
  '\\frac{\\partial L}{\\partial q} - \\frac{d}{dt}\\frac{\\partial L}{\\partial \\dot q} = 0',
  '$$',
  '',
  '## Mermaid',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  participant U as User',
  '  participant M as MarkdownRenderer',
  '  participant S as Streamdown',
  '  U->>M: streaming text',
  '  M->>S: stable blocks',
  '  S-->>U: formatted output',
  '```',
  '',
  '## Raw HTML',
  '',
  '<strong>Raw HTML should stay escaped unless allowHtml is enabled.</strong>',
  '',
  '## Images',
  '',
  '![Tiny placeholder](https://placehold.co/320x120?text=Markdown+Image)',
].join('\n');

export const AllMarkdownFormats: Story = {
  args: {
    size: 'default',
    text: allMarkdownFormatsText,
  },
  parameters: {
    docs: {
      description: {
        story:
          'One dense fixture covering Markdown syntax and Streamdown-specific rendering so regressions are visible in a single Storybook preview.',
      },
    },
  },
  render: (args) => (
    <div
      data-testid="all-markdown-formats-story"
      className="max-h-[calc(100vh-48px)] w-[920px] overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xs"
    >
      <MarkdownRenderer {...args} />
    </div>
  ),
};

const streamdownDemoChunks = [
  [
    '### Streamdown native rendering',
    '',
    'This story exercises Mermaid, LaTeX, and word-level streaming animation in one Markdown response.',
    '',
  ].join('\n'),
  [
    'Inline math is rendered by KaTeX: $E = mc^2$, and display math works too:',
    '',
    '$$',
    '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
    '$$',
    '',
  ].join('\n'),
  [
    '```mermaid',
    'flowchart TD',
    '  A[User output streams in] --> B[Streamdown splits stable blocks]',
    '  B --> C[GFM markdown]',
    '  B --> D[KaTeX math]',
    '  B --> E[Mermaid diagram]',
    '  E --> F[SVG with zoom / copy / download controls]',
    '  D --> G[Animated new text settles]',
    '```',
    '',
  ].join('\n'),
  [
    '| Feature | Expected behavior |',
    '| --- | --- |',
    '| Mermaid | Rendered as an SVG diagram with controls |',
    '| LaTeX | Rendered by KaTeX, not plain text |',
    '| Streaming | Newly arrived text fades in without full-message remounts |',
  ].join('\n'),
];

function StreamingMarkdownDemo() {
  const [chunkCount, setChunkCount] = useState(1);

  useEffect(() => {
    setChunkCount(1);
    const intervalId = window.setInterval(() => {
      setChunkCount((current) => {
        if (current >= streamdownDemoChunks.length) {
          window.clearInterval(intervalId);
          return current;
        }
        return current + 1;
      });
    }, 650);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <MarkdownRenderer
      size={24}
      text={streamdownDemoChunks.slice(0, chunkCount).join('')}
      isStreaming={chunkCount < streamdownDemoChunks.length}
    />
  );
}

export const MermaidLatexAndAnimation: Story = {
  args: {
    size: 24,
    text: streamdownDemoChunks.join(''),
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows Streamdown native Mermaid and KaTeX rendering while text arrives in chunks to trigger animation.',
      },
    },
  },
  render: () => (
    <div
      data-testid="streamdown-demo-story"
      className="w-[820px] rounded-xl border border-border bg-background p-5 shadow-xs"
    >
      <StreamingMarkdownDemo />
    </div>
  ),
};

const mermaidStyleReviewText = [
  '```mermaid',
  'flowchart TD',
  '  Source["Markdown message"] --> Parser["Stable Mermaid block"]',
  '  Parser --> Runtime["Lazy runtime"]',
  '  Runtime --> Theme["Current theme"]',
  '  Theme --> Svg["Readable SVG"]',
  '  Svg --> Layout["Single frame + natural height"]',
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  participant U as User',
  '  participant M as Renderer',
  '  participant P as Plugin',
  '  U->>M: message',
  '  M->>P: render Mermaid',
  '  P-->>M: themed SVG',
  '  M-->>U: diagram',
  '```',
].join('\n');

export const MermaidStyleReview: Story = {
  args: {
    size: 'default',
    text: mermaidStyleReviewText,
  },
  globals: { theme: 'dark' },
  parameters: {
    docs: {
      description: {
        story:
          'Focused review fixture for Mermaid block frame, current-theme rendering, natural height, and horizontal overflow behavior.',
      },
    },
  },
  render: (args) => (
    <div
      data-testid="mermaid-style-review-story"
      className="w-[860px] bg-background p-5 text-foreground"
    >
      <MarkdownRenderer {...args} />
    </div>
  ),
};

export const TablesAndHeadings: Story = {
  args: {
    size: 'default',
    text: [
      '# Heading 1',
      '',
      'Some text under heading 1.',
      '',
      '## Heading 2',
      '',
      '| Column A | Column B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '| 3 | 4 |',
      '',
      '### Heading 3',
      '',
      'A markdown link: [example](https://example.com)',
      '',
      'An autolink: https://example.com',
      '',
      'A www link: www.example.com',
      '',
      'An autolink with punctuation: https://example.com).',
    ].join('\n'),
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

export const ConfigurationTable: Story = {
  args: {
    size: 'default',
    text: [
      '`jh` 当前配置如下：',
      '',
      '| 项目 | 配置 |',
      '|---|---|',
      '| 状态 | `RUNNING` |',
      '| 项目 / 区域 | `lorohub` / `us-central1-a` |',
      '| 机型 | `n2-highmem-8` |',
      '| CPU | 8 vCPU，Intel Cascade Lake |',
      '| 内存 | 64 GB |',
      '| 系统 | Debian 12 Bookworm，x86-64 |',
      '| 启动盘 | 1 TB `pd-standard`，读写 |',
      '| 删除实例时磁盘 | 自动删除 |',
      '| 内网 IP | `10.128.0.5` |',
      '| 网络 | `default`，Premium Tier |',
      '| 实例类型 | 标准实例，非 Spot/抢占式 |',
      '| 宿主机维护 | 自动迁移 |',
      '| 异常停止 | 自动重启 |',
      '| 删除保护 | 未开启 |',
      '| IP 转发 | 未开启 |',
      '| Secure Boot | 未开启 |',
      '| vTPM / 完整性监控 | 已开启 |',
      '| 标签 | 无 |',
      '',
      '远程访问方面：',
      '',
      '- SSH `22` 对 `0.0.0.0/0` 开放',
      '- RDP `3389` 对 `0.0.0.0/0` 开放',
      '- 两个端口均实测可连接',
      '- 使用默认 Compute Engine 服务账号',
      '- 当前本地 SSH key 无法通过认证',
      '',
      '实例是今天约 `19:47`（北京时间）启动的。',
    ].join('\n'),
  },
  parameters: {
    docs: {
      description: {
        story:
          'Long two-column configuration table with Chinese labels, inline code, follow-up list content, and no public IP fixture.',
      },
    },
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

export const WideTableScrollable: Story = {
  args: {
    size: 'default',
    text: [
      'A wide table that overflows on narrow screens:',
      '',
      '| ID | Name | Email | Department | Role | Location | Start Date | Salary | Status | Notes |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | Alice Johnson | alice.johnson@example.com | Engineering | Senior Engineer | San Francisco, CA | 2020-01-15 | $150,000 | Active | Team lead for infrastructure |',
      '| 2 | Bob Williams | bob.williams@example.com | Marketing | Marketing Manager | New York, NY | 2019-06-01 | $120,000 | Active | Manages social media campaigns |',
      '| 3 | Carol Davis | carol.davis@example.com | Product | Product Designer | Seattle, WA | 2021-03-20 | $135,000 | On Leave | Currently on parental leave |',
    ].join('\n'),
  },
  render: (args) => (
    <div className="w-[360px] rounded-xl border border-border bg-background p-4">
      <MarkdownRenderer {...args} />
    </div>
  ),
};

export const GitHubLinks: Story = {
  args: {
    size: 'default',
    text: [
      'GitHub links should be auto-linked:',
      '',
      'A PR link: https://github.com/loro-dev/lody/pull/602',
      '',
      'An issue link: https://github.com/loro-dev/lody/issues/123',
      '',
      'A repo link: https://github.com/loro-dev/lody',
      '',
      'Multiple links in one line: Check https://github.com/loro-dev/lody/pull/602 and https://github.com/loro-dev/lody/pull/603',
      '',
      'Link with trailing punctuation: See https://github.com/loro-dev/lody/pull/602.',
      '',
      'Inline code link: `https://github.com/loro-dev/lody/pull/602`',
      '',
      'Mixed inline code: Check `https://github.com/loro-dev/lody/pull/602` for details.',
    ].join('\n'),
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

export const InlineCodeDensity: Story = {
  args: {
    size: 'default',
    text: [
      'When consecutive lines have inline code, the borders should not overlap:',
      '',
      'Use `useState` for local state management.',
      'Use `useEffect` for side effects and subscriptions.',
      'Use `useMemo` for expensive computations.',
      'Use `useCallback` for stable function references.',
      'Use `useRef` for mutable values that persist across renders.',
      '',
      'Mixed density paragraph with `inline code` on the first line',
      'and `more code` on the second line and `even more` on the third.',
      '',
      'A paragraph with multiple inline codes: `pnpm install`, then `pnpm build`, and finally `pnpm check` to verify.',
    ].join('\n'),
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

export const AgentFileLinks: Story = {
  args: {
    size: 'default',
    text: [
      'Agent filesystem links should not navigate inside the web app:',
      '',
      'A labeled worktree file: [markdown-renderer.tsx](/home/agent/.lody/repos/github---example---project/worktrees/5110aa94-b18b-43cf-afa7-369905c2515a/packages/components/src/components/ai-gui/markdown-renderer.tsx)',
      '',
      'A repo-relative GitHub line anchor: [README.md#L100](README.md#L100)',
      '',
      'A repo-relative line reference: [README.md:100](README.md:100)',
      '',
      'A raw path label: [/tmp/lody-output.log](/tmp/lody-output.log)',
      '',
      'A protocol-relative web URL stays a normal link: [CDN script](//cdn.example.com/app.js)',
    ].join('\n'),
  },
  render: (args) => wrap(<MarkdownRenderer {...args} />),
};

const mermaidPhoneText = [
  'The run below is the shape a keeper agent reports back:',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  participant U as User',
  '  participant K as Keeper runtime',
  '  participant G as Game',
  '  participant V as Vision runtime',
  '  participant L as Upper LLM',
  '  participant T as Task verifier',
  '  U->>K: Start whole-run task with intent and context',
  '  K->>G: Launch game',
  '  K->>V: Start capture, recording, and tracking',
  '  V-->>K: Ready at observed frame',
  '  K->>L: Start Upper with whole-run context',
  '  L->>V: Query current world state',
  '  V-->>L: Structured snapshot (observed frame)',
  '  L->>T: Verify current task (task instance)',
  '  T-->>L: Status, evidence, task instance, observed frame',
  '  L-->>K: Keep current task',
  '  K-->>U: Report final status',
  '```',
].join('\n');

/**
 * Phone-shaped fixture for the Mermaid full-screen viewer. Open it through
 * `iframe.html` sized to a phone viewport: the viewer portals to
 * `document.body`, so a story frame nested inside a desktop-sized page cannot
 * show where its controls actually land.
 *
 * The `--safe-area-*` variables are set on the document element (the same names
 * `tailwind/index.css` maps to `env(safe-area-inset-*)`) because a headless
 * browser reports zero insets — without them nothing here can show that a
 * control has been parked under the status bar.
 */
export const MermaidPhoneViewer: Story = {
  args: {
    size: 'default',
    text: mermaidPhoneText,
  },
  globals: { theme: 'dark' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Mermaid on a phone-sized viewport with simulated safe-area insets, for reviewing the full-screen diagram viewer.',
      },
    },
  },
  render: (args) => <MermaidPhoneFrame>{<MarkdownRenderer {...args} />}</MermaidPhoneFrame>,
};

const PHONE_SAFE_AREA = {
  '--safe-area-top': '59px',
  '--safe-area-right': '0px',
  '--safe-area-bottom': '34px',
  '--safe-area-left': '0px',
} as const;

function MermaidPhoneFrame({ children }: { children: ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(PHONE_SAFE_AREA)) {
      root.style.setProperty(name, value);
    }
    return () => {
      for (const name of Object.keys(PHONE_SAFE_AREA)) {
        root.style.removeProperty(name);
      }
    };
  }, []);

  return (
    <div
      data-testid="mermaid-phone-story"
      className="flex h-screen w-full flex-col bg-background text-foreground"
    >
      {/* Stand-in for the system status bar the insets above reserve. */}
      <div className="flex shrink-0 items-end justify-between bg-black px-6 pb-1 text-xs text-white [block-size:var(--safe-area-top)]">
        <span>21:00</span>
        <span>76%</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">{children}</div>
    </div>
  );
}
