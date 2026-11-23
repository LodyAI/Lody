import { colors as uiColors } from '@lody/ui/tokens/colors.stylex';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';

import { MessageTextWithChips } from '@/components/mentions/message-text-chips';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import { applyTextRewrites, type MessageTextSpan, type SessionId } from '@lody/shared';
import { SettingsStoryProviders } from './settings-story-shell';
import { cn } from '@/lib/utils';
import {
  conversationReadingFontSizeStyle,
  userTextCollapsedStyle,
} from '@/components/ai-gui/conversation-font-size-classes';
import { getUserTextRenderSlice } from '@/components/ai-gui/message-copy';
const textStory = stylex.create({
  bubble: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  text: { minWidth: 0, maxWidth: '100%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  collapsed: { overflow: 'hidden' },
  path: { maxWidth: '20rem', alignSelf: 'flex-end' },
  narrow: { maxWidth: '16rem', alignSelf: 'flex-end' },
});
const storyLayoutStyles = stylex.create({
  caption: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  canvas: {
    'max-width': '100%',
    'min-width': 'calc(var(--spacing) * 0)',
    'border-radius': 'var(--radius-2xl)',
    'background-color': 'color-mix(in oklab, hsl(var(--foreground) / 1) 5%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 2.5)',
  },
  stack: {
    'margin-inline': 'auto',
    display: 'flex',
    'max-width': '42rem',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 8)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 8)',
  },
  stack2: {
    'margin-inline': 'auto',
    display: 'flex',
    'max-width': '48rem',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 8)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 8)',
  },
});

/**
 * Chips in a sent message.
 *
 * The fixtures are built by running the real `applyTextRewrites` over a
 * composer string, so what renders here is the same `{ text, spans }` pair the
 * send path will produce — including the expanded skill instruction and the
 * full pasted blob still sitting inside the text under its chip.
 */

const PASTED_BLOB = [
  'TypeError: Cannot read properties of undefined (reading ‘transport’)',
  '    at refineSessionFileBlock (packages/shared/src/message-schemas.ts:141:16)',
  '    at Object.superRefine (packages/shared/src/message-schemas.ts:172:5)',
  ...Array.from(
    { length: 40 },
    (_, i) =>
      `    at frame${i} (packages/components/src/components/sessions/session-detail.tsx:${i})`
  ),
].join('\n');

const COMPOSER_TEXT =
  'Compare @src/ui/mention/mention-highlighter.tsx against #482, run $review-diff on it, then summarise [Pasted] for @session:crdt-metadata-cleanup. Ask @Code-Reviewer to check it.';

const at = (token: string) => {
  const start = COMPOSER_TEXT.indexOf(token);
  if (start < 0) throw new Error(`token not in fixture: ${token}`);
  return { start, end: start + token.length };
};

/** The same shape the before-send rewrite will emit. */
const SENT = applyTextRewrites(COMPOSER_TEXT, [
  {
    ...at('@src/ui/mention/mention-highlighter.tsx'),
    span: {
      kind: 'file',
      label: '@src/ui/mention/mention-highlighter.tsx',
      target: 'src/ui/mention/mention-highlighter.tsx',
    },
  },
  { ...at('#482'), span: { kind: 'issue', label: '#482', target: '482' } },
  {
    ...at('$review-diff'),
    replacement: 'use /review-diff [Skill Path](.claude/skills/review-diff/SKILL.md)',
    span: { kind: 'skill', label: '$review-diff', target: 'review-diff' },
  },
  {
    ...at('[Pasted]'),
    replacement: PASTED_BLOB,
    span: { kind: 'pasted_text', label: `Pasted ${PASTED_BLOB.length.toLocaleString()} chars` },
  },
  {
    ...at('@session:crdt-metadata-cleanup'),
    replacement: '[@CRDT metadata cleanup](lody://session/9f2c-4a11?workspace=ws_demo)',
    span: { kind: 'session', label: 'CRDT metadata cleanup', target: '9f2c-4a11' },
  },
  {
    ...at('@Code-Reviewer'),
    replacement: '[Agent Role: Code Reviewer (agentRoleId: role-1)]',
    // An Agent Role freezes its emoji into the span, so the bubble paints the
    // same mark the composer did without reading the catalog.
    span: { kind: 'agent_role', label: 'Code-Reviewer', target: 'role-1', mark: '🔍' },
  },
]);

function Bubble({
  title,
  text,
  spans,
  collapsed = false,
  xstyle,
  fontSize = 14,
}: {
  title: string;
  text: string;
  spans?: MessageTextSpan[];
  /** Runs the production collapse: its real slice helper and its real height. */
  collapsed?: boolean;
  /** Narrows the column, the way a phone or a split pane does. */
  xstyle?: stylex.StyleXStyles;
  fontSize?: number;
}) {
  // `getUserTextRenderSlice` is what production truncates with, so the story
  // sees what production sees. Re-implementing the cut here is how the pasted
  // -text leak stayed invisible: the hand-rolled shell cut by height only and
  // never exercised the character budget that dropped the span.
  const slice = collapsed ? getUserTextRenderSlice(text, spans) : undefined;
  return (
    <div {...stylex.props(textStory.bubble, xstyle)}>
      <div {...stylex.props(storyLayoutStyles.caption)}>{title}</div>
      <div {...stylex.props(storyLayout.canvas)}>
        <div
          {...stylex.props(textStory.text, collapsed && textStory.collapsed)}
          style={{
            ...conversationReadingFontSizeStyle(fontSize),
            ...(collapsed ? userTextCollapsedStyle(fontSize) : {}),
          }}
        >
          <MessageTextWithChips text={slice?.text ?? text} spans={slice ? slice.spans : spans} />
        </div>
      </div>
    </div>
  );
}

/**
 * Long enough that `UserPlainTextBlock` collapses it under its
 * `maxHeight`. That height is a whole number of line boxes, so anything that
 * makes one line taller than the rest shows up here as a half-clipped row —
 * which no short fixture can reveal.
 */
const LONG = applyTextRewrites(
  `${COMPOSER_TEXT}\n${'会话 命令 hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh '.repeat(12)}`,
  [
    {
      ...at('@src/ui/mention/mention-highlighter.tsx'),
      span: { kind: 'file', label: '@src/ui/mention/mention-highlighter.tsx', target: 'a.tsx' },
    },
    { ...at('#482'), span: { kind: 'issue', label: '#482', target: '482' } },
    {
      ...at('$review-diff'),
      replacement: 'use /review-diff [Skill Path](.claude/skills/review-diff/SKILL.md)',
      span: { kind: 'skill', label: '$review-diff', target: 'review-diff' },
    },
  ]
);

/**
 * One path longer than any bubble it can be shown in.
 *
 * A chip that cannot break would pin this to a single line: the bubble grows to
 * its width cap for the sake of one token, and in a narrow column the label
 * loses its tail — the file NAME — to the clip. So this fixture is rendered in a
 * column too narrow to hold it, where wrapping is the only correct outcome.
 */
const LONG_PATH_SOURCE =
  'Look at @packages/components/scripts/generate-chat-workspace-geometry-report.mjs and the design around it';
const LONG_PATH = applyTextRewrites(LONG_PATH_SOURCE, [
  {
    start: LONG_PATH_SOURCE.indexOf('@packages/'),
    end: LONG_PATH_SOURCE.indexOf('.mjs') + '.mjs'.length,
    span: {
      kind: 'file',
      label: '@packages/components/scripts/generate-chat-workspace-geometry-report.mjs',
      target: 'packages/components/scripts/generate-chat-workspace-geometry-report.mjs',
    },
  },
]);

function Board({ withSpans }: { withSpans: boolean }) {
  return (
    <div {...stylex.props(storyLayout.stack)}>
      <Bubble
        title={withSpans ? 'With chips' : 'Raw text the agent receives'}
        text={SENT.text}
        spans={withSpans ? SENT.spans : undefined}
      />
      <Bubble
        title="Long enough to collapse"
        text={LONG.text}
        spans={withSpans ? LONG.spans : undefined}
        collapsed
      />
      <Bubble
        title="A path wider than the column"
        text={LONG_PATH.text}
        spans={withSpans ? LONG_PATH.spans : undefined}
        xstyle={textStory.path}
      />
    </div>
  );
}

const meta = {
  title: 'Chat/MessageTextChips',
  component: Board,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Board>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What the transcript shows today: the fully rewritten prompt, verbatim. */
export const WithoutSpans: Story = { args: { withSpans: false } };

/** Same string, with spans. Click the paste chip to expand the blob in place. */
export const WithSpans: Story = { args: { withSpans: true } };

export const WithSpansDark: Story = {
  args: { withSpans: true },
  globals: { theme: 'dark' },
};

/** Chinese prose and a paste chip must share a baseline at every text size. */
export const PastedTextAlignment: Story = {
  args: { withSpans: true },
  render: () => {
    const prefix = '请分析这段示例日志，并说明处理步骤 ';
    const pasted = applyTextRewrites(`${prefix}[Pasted]`, [
      {
        start: prefix.length,
        end: prefix.length + '[Pasted]'.length,
        replacement: PASTED_BLOB,
        span: {
          kind: 'pasted_text',
          label: `Pasted ${PASTED_BLOB.length.toLocaleString('en-US')} chars`,
        },
      },
    ]);
    return (
      <div {...stylex.props(storyLayout.stack2)}>
        {[12, 14, 18].map((fontSize) => (
          <Bubble
            key={fontSize}
            title={`${fontSize}px`}
            text={pasted.text}
            spans={pasted.spans}
            fontSize={fontSize}
          />
        ))}
        <Bubble
          title="Narrow column"
          text={pasted.text}
          spans={pasted.spans}
          xstyle={textStory.narrow}
        />
      </div>
    );
  },
};

export const PastedTextAlignmentDark: Story = {
  ...PastedTextAlignment,
  globals: { theme: 'dark' },
};

const rowsSessionId = 'message-text-chips-rows' as SessionId;
const MIXED_SOURCE =
  '先看 @src/ui/mention/mention-highlighter.tsx 里 `getComposerMentionChip()` 的实现，再对比 #482 ✅\n\n' +
  'Then run $review-diff and summarise for @session:crdt-metadata-cleanup — 长中文段落和 English words 混排，'.repeat(
    4
  ) +
  'https://example.com/a/very/long/url/' +
  'segment'.repeat(30);
const MIXED = applyTextRewrites(
  MIXED_SOURCE,
  (
    [
      [
        '@src/ui/mention/mention-highlighter.tsx',
        { kind: 'file', target: 'mention-highlighter.tsx' },
      ],
      ['#482', { kind: 'issue', target: '482' }],
      ['$review-diff', { kind: 'skill', target: 'review-diff' }],
      ['@session:crdt-metadata-cleanup', { kind: 'session', target: '9f2c-4a11' }],
    ] as const
  ).map(([token, span]) => {
    const start = MIXED_SOURCE.indexOf(token);
    return { start, end: start + token.length, span: { ...span, label: token } };
  })
);

/** Sent user rows as the conversation renders them, one per bubble shape. */
const SENT_ROWS: ChatStreamItem[] = (
  [
    { text: '好的' },
    { text: SENT.text, spans: SENT.spans },
    {
      text: '@src/ui/mention/mention-highlighter.tsx',
      spans: [
        {
          start: 0,
          end: 39,
          kind: 'file',
          label: '@src/ui/mention/mention-highlighter.tsx',
          target: 'a.tsx',
        },
      ],
    },
    { text: LONG.text, spans: LONG.spans },
    { text: LONG_PATH.text, spans: LONG_PATH.spans },
    { text: 'A long steering message that wraps across several lines. '.repeat(14) },
    { text: '一条很长的中文引导消息，用来检查气泡在不同宽度下的位置。'.repeat(10) },
    { text: `https://example.com/${'unbreakable'.repeat(40)}` },
    { text: MIXED.text, spans: MIXED.spans },
  ] satisfies { text: string; spans?: MessageTextSpan[] }[]
).map((item, index) => ({
  type: 'message',
  sessionId: rowsSessionId,
  turnIndex: index,
  message: {
    id: `layout-user-${index}`,
    role: 'user',
    timestamp: '2026-11-01T00:00:00Z',
    items: [{ type: 'text', ...item }],
  },
}));

/**
 * The same chips inside real conversation rows: every bubble must hug the
 * avatar's side of its column, at any column width, without touching the avatar.
 */
export const SentRows: Story = {
  args: { withSpans: true },
  render: () => (
    <SettingsStoryProviders>
      <div {...stylex.props(themeStyles.column)}>
        <SessionChatStreamView
          sessionId={rowsSessionId}
          items={SENT_ROWS}
          renderMessageRow={({ message, sessionId: id }) => (
            <MessageRowView
              message={message}
              sessionId={id}
              user={{ name: 'Story User', email: 'story@example.com' }}
            />
          )}
        />
      </div>
    </SettingsStoryProviders>
  ),
};

const themeStyles = stylex.create({
  column: { display: 'flex', height: '100dvh', flexDirection: 'column', backgroundColor: uiColors.background },
});
