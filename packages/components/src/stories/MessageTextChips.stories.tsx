import type { Meta, StoryObj } from '@storybook/react';

import { MessageTextWithChips } from '@/components/mentions/message-text-chips';
import { applyTextRewrites, type MessageTextSpan } from '@lody/shared';
import { cn } from '@/lib/utils';
import { userTextCollapsedHeight } from '@/components/ai-gui/conversation-font-size-classes';
import { getUserTextRenderSlice } from '@/components/ai-gui/message-copy';

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
    replacement: 'use lody mcp to query session[id: 9f2c-4a11] history',
    span: { kind: 'session', label: 'CRDT metadata cleanup', target: '9f2c-4a11' },
  },
  {
    ...at('@Code-Reviewer'),
    replacement:
      'use lody mcp to create a session with agent role[id: role-1, name: Code Reviewer]',
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
  className,
}: {
  title: string;
  text: string;
  spans?: MessageTextSpan[];
  /** Runs the production collapse: its real slice helper and its real height. */
  collapsed?: boolean;
  /** Narrows the column, the way a phone or a split pane does. */
  className?: string;
}) {
  // `getUserTextRenderSlice` is what production truncates with, so the story
  // sees what production sees. Re-implementing the cut here is how the pasted
  // -text leak stayed invisible: the hand-rolled shell cut by height only and
  // never exercised the character budget that dropped the span.
  const slice = collapsed ? getUserTextRenderSlice(text, spans) : undefined;
  return (
    <div className={cn('flex flex-col items-end gap-1.5', className)}>
      <div className="font-medium text-muted-foreground text-xs">{title}</div>
      <div className="min-w-0 max-w-full rounded-2xl border border-foreground/[0.08] bg-foreground/[0.05] px-4 py-2.5">
        <div
          className={cn(
            'min-w-0 max-w-full whitespace-pre-wrap text-sm [overflow-wrap:anywhere]',
            collapsed && 'overflow-hidden'
          )}
          style={collapsed ? { maxHeight: userTextCollapsedHeight(14) } : undefined}
        >
          <MessageTextWithChips text={slice?.text ?? text} spans={slice ? slice.spans : spans} />
        </div>
      </div>
    </div>
  );
}

/**
 * Long enough that `UserPlainTextBlock` collapses it under its fixed
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
    <div className="mx-auto flex max-w-2xl flex-col gap-8 bg-background p-8">
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
        className="max-w-[20rem] self-end"
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
