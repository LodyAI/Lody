import * as stylex from '@stylexjs/stylex';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { CheckCircle2, ChevronRight, Copy, Info, MousePointer2, UserIcon } from 'lucide-react';
import { Button } from './button';
import { ReplicaMarkdown } from './markdown';
import type {
  ReplicaAssistantItem,
  ReplicaAssistantMessage,
  ReplicaChatUser,
  ReplicaImage,
  ReplicaLocale,
  ReplicaMessage,
  ReplicaToolCall,
  ReplicaUserMessage,
  ReplicaVisualAnnotation,
} from './types';

const streamLayout = stylex.create({
  column: {
    marginInline: 'auto',
    width: '100%',
    maxWidth: '46rem',
    paddingInline: { default: 14, '@media (width >= 40rem)': 18 },
  },
  root: {
    height: '100%',
    containerType: 'inline-size',
    position: 'relative',
    backgroundColor: 'hsl(var(--background))',
  },
  avatar: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 8)',
    width: 'calc(var(--spacing) * 8)',
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: 'calc(infinity * 1px)',
  },
  mobileAvatar: { height: 'calc(var(--spacing) * 7)', width: 'calc(var(--spacing) * 7)' },
  desktopAvatar: { height: 'calc(var(--spacing) * 8)', width: 'calc(var(--spacing) * 8)' },
  processMobile: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground))',
  },
  processDesktop: { height: '1em', width: '1em' },
  footer: { paddingTop: 0, paddingBottom: 0 },
  image: { paddingTop: 'calc(var(--spacing) * 3)', paddingBottom: 0 },
  prose: { paddingTop: 'calc(var(--spacing) * 1)', paddingBottom: 0 },
  last: {
    paddingBottom: {
      default: 'calc(var(--spacing) * 2)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 3)',
    },
  },
  user: {
    paddingBlock: {
      default: 'calc(var(--spacing) * 2)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 3)',
    },
  },
});
const chatStreamComposition = stylex.create({
  part1: {
    'margin-inline': 'auto',
    width: '100%',
    'max-width': '46rem',
    'padding-inline': '14px',
    '@media (width >= 40rem)': {
      'padding-inline': '18px',
    },
  },
  part2: {
    display: 'inline-flex',
    flex: 'none',
    'flex-shrink': '0',
    'transform-origin': 'center',
    color: 'hsl(var(--muted-foreground))',
  },
  part3: {
    opacity: '0%',
    'transition-property': 'opacity',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': '150ms',
    '@media (hover: hover)': {
      ':is(*):is(:where(.group):hover *)': {
        opacity: '100%',
      },
    },
    ':is(*):is(:where(.group):focus-visible *)': {
      opacity: '100%',
    },
  },
  part4: {
    'min-width': '0px',
  },
  part5: {
    flex: '1',
    'font-size': '12.5px',
    'line-height': 'var(--leading-snug)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground))',
  },
  part6: {
    'font-size': 'var(--markdown-body-font-size,1em)',
    'line-height': '1.75',
    'font-weight': 'var(--font-weight-normal)',
  },
  part7: {
    display: 'flex',
    width: '100%',
    'align-items': 'center',
    'padding-block': 'calc(var(--spacing) * 0.5)',
    'text-align': 'left',
  },
  part8: {
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-md)',
    'padding-right': 'var(--spacing)',
    'font-size': '12.5px',
    'line-height': 'var(--leading-snug)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground))',
    '@media (hover: hover)': {
      ':is(*):hover': {
        'background-color': 'color-mix(in oklab, hsl(var(--hover)) 40%, transparent)',
      },
    },
  },
  part9: {
    'justify-content': 'flex-start',
    gap: 'calc(var(--spacing) * 0.5)',
    'padding-inline': '4px',
    color: 'hsl(var(--muted-foreground))',
  },
  part10: {
    display: 'flex',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    'justify-content': 'flex-start',
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  part11: {
    'min-height': 'calc(var(--spacing) * 6)',
    gap: 'var(--spacing)',
  },
  part12: {
    'min-height': 'calc(var(--spacing) * 7)',
    gap: 'calc(var(--spacing) * 2)',
  },
  part13: {
    opacity: '0%',
    'transition-property': 'opacity',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': '150ms',
    ':is(*):focus-within': {
      opacity: '100%',
    },
  },
  part14: {
    'max-width': '800px',
    'overflow-wrap': 'break-word',
  },
  part15: {
    color: 'hsl(var(--muted-foreground))',
  },
  part16: {
    color: 'hsl(var(--foreground))',
  },
  part17: {
    display: 'flex',
    width: '100%',
    'max-width': 'var(--container-sm)',
    'flex-direction': 'column',
    gap: 'var(--spacing)',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'text-align': 'left',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  part18: {
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '@media (hover: hover)': {
      ':is(*):hover': {
        'background-color': 'color-mix(in oklab, hsl(var(--muted)) 70%, transparent)',
      },
    },
  },
  part19: {
    cursor: 'default',
  },
  part20: {
    position: 'relative',
    display: 'flex',
    width: 'calc(var(--spacing) * 8)',
    height: 'calc(var(--spacing) * 8)',
    'flex-shrink': '0',
    overflow: 'hidden',
    'border-radius': 'calc(infinity * 1px)',
  },
  part21: {
    display: 'flex',
    width: '100%',
    'flex-direction': 'row-reverse',
  },
  part22: {
    gap: 'calc(var(--spacing) * 2)',
    'padding-left': 'calc(var(--spacing) * 7)',
  },
  part23: {
    gap: 'calc(var(--spacing) * 2.5)',
  },
  part24: {
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'flex-direction': 'column',
    'align-items': 'flex-end',
    'text-align': 'left',
  },
  part25: {
    'max-width': 'min(100%, 28rem)',
    gap: 'var(--spacing)',
  },
  part26: {
    'max-width': '100%',
    gap: 'calc(var(--spacing) * 1.5)',
    '@container (width >= 520px)': {
      'max-width': '80%',
    },
    '@container (width >= 720px)': {
      'max-width': '70%',
    },
  },
  part27: {
    'container-type': 'inline-size',
    position: 'relative',
    height: '100%',
    'background-color': 'hsl(var(--background))',
  },
});

const chatStreamStylesNative = stylex.create({
  row: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-sm)',
    color: 'hsl(var(--muted-foreground))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '@media (hover: hover)': {
      ':is(*):hover': {
        'background-color': 'color-mix(in oklab, hsl(var(--hover)) 50%, transparent)',
        color: 'hsl(var(--foreground))',
      },
    },
    ':is(*):focus-visible': {
      'box-shadow':
        '0 0 #0000, 0 0 #0000, 0 0 #0000,  0 0 0 calc(1px + 0px) currentcolor, 0 0 #0000',
      'outline-style': 'none',
    },
  },
});

const chatStreamStyles = stylex.create({
  row: {
    display: 'inline-flex',
    'transform-origin': 'center',
  },
  row2: {
    display: 'flex',
    width: '100%',
    'justify-content': 'flex-start',
  },
  stack: {
    display: 'inline-flex',
    'max-width': '100%',
    'flex-direction': 'column',
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 20%, transparent)',
  },
  row3: {
    display: 'inline-flex',
    'max-width': '100%',
  },
  element: {
    display: 'block',
    'max-height': '10.5rem',
    'max-width': '100%',
    'object-fit': 'contain',
  },
  stack2: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'var(--spacing)',
  },
  label: {
    'flex-shrink': '0',
    'font-variant-numeric': '   tabular-nums ',
  },
  row4: {
    'margin-right': 'calc(7px * -1)',
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 0.5)',
  },
  glyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  section: {
    position: 'relative',
  },
  frame: {
    width: '100%',
  },
  row5: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground))',
  },
  glyph2: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    'flex-shrink': '0',
  },
  label2: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  },
  caption: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 75%, transparent)',
  },
  caption2: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-family': 'var(--font-mono)',
    'font-size': '10px',
    color: 'hsl(var(--muted-foreground))',
  },
  frame2: {
    'aspect-ratio': '1 / 1',
    width: '100%',
    height: '100%',
  },
  row6: {
    display: 'flex',
    width: '100%',
    height: '100%',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'hsl(var(--muted))',
  },
  glyph3: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  caption3: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    'flex-shrink': '0',
    color: 'hsl(var(--muted-foreground))',
  },
  row7: {
    display: 'flex',
    'flex-direction': 'row-reverse',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-size': '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  label3: {
    'font-variant-numeric': '   tabular-nums ',
  },
  glyph4: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    color: 'hsl(var(--primary))',
  },
  row8: {
    display: 'flex',
    width: '100%',
    'min-width': '0px',
    'align-items': 'flex-start',
    'justify-content': 'flex-end',
  },
  row9: {
    display: 'flex',
    width: '100%',
    'max-width': '100%',
    'min-width': '0px',
    'justify-content': 'flex-end',
  },
  frame3: {
    position: 'relative',
    width: 'fit-content',
    'max-width': '100%',
    'min-width': '0px',
  },
  frame4: {
    width: 'fit-content',
    'max-width': '100%',
    'min-width': '0px',
    color: 'hsl(var(--foreground))',
    '@media (width >= 40rem)': {
      'max-width': '800px',
    },
  },
  stack3: {
    display: 'flex',
    'max-width': '100%',
    'min-width': '0px',
    'flex-direction': 'column',
    'align-items': 'flex-end',
    gap: 'calc(var(--spacing) * 2)',
  },
  row10: {
    display: 'flex',
    width: '100%',
    'justify-content': 'flex-end',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-top': 'var(--spacing)',
  },
  row11: {
    display: 'flex',
    'max-width': '100%',
    'justify-content': 'flex-end',
    '@media (width >= 40rem)': {
      'padding-left': 'calc(var(--spacing) * 2)',
    },
  },
  surface: {
    'max-width': '100%',
    'min-width': '0px',
    'border-radius': '1.15rem',
    'background-color': 'color-mix(in oklab, hsl(var(--foreground)) 5%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 3.5)',
    'padding-block': 'calc(var(--spacing) * 2)',
    '@media (width >= 40rem)': {
      'border-radius': 'var(--radius-2xl)',
      'padding-inline': 'calc(var(--spacing) * 4)',
      'padding-block': 'calc(var(--spacing) * 2.5)',
    },
  },
  caption4: {
    'max-width': '100%',
    'min-width': '0px',
    'overflow-wrap': 'anywhere',
    'white-space': 'pre-wrap',
    color: 'hsl(var(--foreground))',
  },
  row12: {
    display: 'flex',
    gap: 'calc(var(--spacing) * 0.5)',
  },
  frame5: {
    position: 'relative',
    height: '100%',
    'overflow-x': 'hidden',
    'padding-block': 'calc(var(--spacing) * 5)',
    '@media (width >= 40rem)': {
      'padding-block': 'calc(var(--spacing) * 6)',
    },
  },
  overlay: {
    'pointer-events': 'none',
    position: 'absolute',
    'inset-inline': '0px',
    top: '0px',
    height: 'calc(var(--spacing) * 12)',
    'background-image':
      'linear-gradient(to bottom in oklab, hsl(var(--background)) 0%, transparent 100%)',
  },
});

const buttonStyles = stylex.create({
  copy: {
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    color: {
      default: 'hsl(var(--muted-foreground))',
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--foreground))' },
    },
    backgroundColor: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'hsl(var(--hover))' },
    },
  },
  fade: { transitionProperty: 'opacity' },
  desktopCopy: { opacity: { default: 0, ':is(.group\\/usermsg:hover *)': 1, ':focus-visible': 1 } },
});

/* Display-only replica of the app's ai-gui conversation renderer
   (`SessionChatStreamView` + `MessageRowView` + `AssistantChatItem`), following
   only the render path the landing reaches: no live status row, no selection,
   no expanded groups, no hover. Plain DOM scrolling replaces Virtua. */

type Variant = 'desktop' | 'mobile';

const STRINGS = {
  en: {
    finishedWorking: 'Finished working',
    commands: ['Ran {n} command', 'Ran {n} commands'],
    readFiles: ['Read {n} file', 'Read {n} files'],
    editedFiles: ['Edited {n} file', 'Edited {n} files'],
    searches: ['Ran {n} search', 'Ran {n} searches'],
    tools: ['Called {n} tool', 'Called {n} tools'],
    copyMessage: 'Copy message',
    copyResponse: 'Copy response',
    turnConfig: 'Turn configuration',
  },
  zh: {
    finishedWorking: '已完成工作',
    commands: ['调用了 {n} 个命令', '调用了 {n} 个命令'],
    readFiles: ['阅读了 {n} 个文件', '阅读了 {n} 个文件'],
    editedFiles: ['编辑了 {n} 个文件', '编辑了 {n} 个文件'],
    searches: ['进行了 {n} 次搜索', '进行了 {n} 次搜索'],
    tools: ['调用了 {n} 个工具', '调用了 {n} 个工具'],
    copyMessage: '复制消息',
    copyResponse: '复制回答',
    turnConfig: '运行配置',
  },
} as const;

type Strings = (typeof STRINGS)[ReplicaLocale];

/** `lib/conversation-layout` CONVERSATION_CONTENT_WIDTH_CLASS. */
export function ConversationColumn({
  className,
  style,
  xstyle,
  ...props
}: HTMLAttributes<HTMLDivElement> & { xstyle?: stylex.StyleXStyles }) {
  const sx = stylex.props(streamLayout.column, xstyle);
  return (
    <div
      {...props}
      className={[sx.className, className].filter(Boolean).join(' ')}
      style={{ ...sx.style, ...style }}
    />
  );
}

// ---- Timestamps (lib/format-conversation-timestamp.ts) ---------------------

const INTL_LOCALE: Record<ReplicaLocale, string> = { en: 'en', zh: 'zh-CN' };
const DAY_MS = 24 * 60 * 60 * 1000;
const calendarDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;

function formatConversationTimestamp(timestamp: string, locale: ReplicaLocale): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const intl = INTL_LOCALE[locale];
  const now = new Date();
  const time = new Intl.DateTimeFormat(intl, { hour: '2-digit', minute: '2-digit' }).format(date);
  const daysAgo = calendarDay(now) - calendarDay(date);
  if (daysAgo === 0) return time;
  const withTime = (options: Intl.DateTimeFormatOptions) =>
    `${new Intl.DateTimeFormat(intl, options).format(date)} ${time}`;
  if (daysAgo > 0 && daysAgo < 7) return withTime({ weekday: 'long' });
  const lastDay = new Date(now.getFullYear() - 1, now.getMonth() + 1, 0).getDate();
  const cutoff =
    Date.UTC(now.getFullYear() - 1, now.getMonth(), Math.min(now.getDate(), lastDay)) / DAY_MS;
  if (calendarDay(date) <= cutoff) {
    return withTime({ year: 'numeric', month: 'numeric', day: 'numeric' });
  }
  return withTime({ month: 'numeric', day: 'numeric' });
}

// ---- Assistant turn layout (assistant-turn-render-blocks.ts + message-copy.ts)

type TurnBlock =
  | {
      kind: 'content';
      key: string;
      itemIndex: number;
      item: Exclude<ReplicaAssistantItem, ReplicaToolCall>;
    }
  | { kind: 'activity'; key: string; tools: ReplicaToolCall[] };

type TurnRow =
  | { kind: 'content'; key: string; item: Exclude<ReplicaAssistantItem, ReplicaToolCall> }
  | { kind: 'activity'; key: string; label: string }
  | { kind: 'worked'; key: string }
  | { kind: 'footer'; key: string; hasCopyableText: boolean };

function buildBlocks(items: ReplicaAssistantItem[]): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  let activity: Extract<TurnBlock, { kind: 'activity' }> | null = null;
  items.forEach((item, itemIndex) => {
    if (item.type === 'tool_call') {
      if (!activity) {
        activity = { kind: 'activity', key: `activity:${itemIndex}`, tools: [] };
        blocks.push(activity);
      }
      activity.tools.push(item);
      return;
    }
    activity = null;
    blocks.push({ kind: 'content', key: `content:${itemIndex}:${item.type}`, itemIndex, item });
  });
  return blocks;
}

/** Indexes folded into the finished turn's work region: everything but the final
    contiguous text run and the never-collapsed image tail. */
function collapsibleItemIndexes(items: ReplicaAssistantItem[], finished: boolean): Set<number> {
  const collapsible = new Set<number>();
  if (!finished || items.length < 2) return collapsible;
  let runStart = items.length - 1;
  while (runStart >= 0 && items[runStart]?.type === 'image') runStart -= 1;
  if (items[runStart]?.type !== 'text') {
    runStart = items.length;
  } else {
    while (runStart > 0 && items[runStart - 1]?.type === 'text') runStart -= 1;
  }
  items.forEach((item, index) => {
    if (index === items.length - 1 || item.type === 'image') return;
    if (item.type === 'text' && index >= runStart) return;
    collapsible.add(index);
  });
  return collapsible;
}

function activityLabel(tools: ReplicaToolCall[], t: Strings): string {
  const count = (kind: ReplicaToolCall['kind']) =>
    tools.filter((tool) => tool.kind === kind).length;
  const parts: string[] = [];
  const push = (n: number, forms: readonly [string, string]) => {
    if (n > 0) parts.push((n === 1 ? forms[0] : forms[1]).replace('{n}', String(n)));
  };
  push(count('execute'), t.commands);
  push(count('read'), t.readFiles);
  push(count('edit'), t.editedFiles);
  push(count('search'), t.searches);
  push(count('other'), t.tools);
  return parts.join(' · ');
}

function buildTurnRows(message: ReplicaAssistantMessage, t: Strings): TurnRow[] {
  const { items, finished } = message;
  const blocks = buildBlocks(items);
  const collapsible = collapsibleItemIndexes(items, finished);
  const isWork = (block: TurnBlock) =>
    block.kind === 'activity' || collapsible.has(block.itemIndex);
  const workCount = blocks.filter(isWork).length;
  const useWorkedGroup = finished && workCount > 0 && workCount < blocks.length;

  const rows: TurnRow[] = [];
  let insertedWorked = false;
  for (const block of blocks) {
    if (useWorkedGroup && isWork(block)) {
      if (!insertedWorked) rows.push({ kind: 'worked', key: 'worked' });
      insertedWorked = true;
      continue;
    }
    if (block.kind === 'content') {
      rows.push({ kind: 'content', key: block.key, item: block.item });
    } else {
      const label = activityLabel(block.tools, t);
      if (label) rows.push({ kind: 'activity', key: block.key, label });
    }
  }

  const hasCopyableText =
    finished &&
    items.some(
      (item, index) => item.type === 'text' && !collapsible.has(index) && item.text.trim()
    );
  if (message.modelLabel || hasCopyableText) {
    rows.push({ kind: 'footer', key: 'footer', hasCopyableText });
  }
  return rows;
}

// ---- Assistant rows -----------------------------------------------------------

/** `ProcessDisclosureButton` (collapsed): activity-group and "Finished working" headers. */
function ProcessDisclosure({ label, variant }: { label: string; variant: Variant }) {
  const isMobile = variant === 'mobile';
  const chevron = (
    <span
      {...stylex.props([chatStreamComposition.part2, !isMobile && chatStreamComposition.part3])}
    >
      <span {...stylex.props(chatStreamStyles.row)}>
        <ChevronRight
          {...stylex.props(isMobile ? streamLayout.processMobile : streamLayout.processDesktop)}
        />
      </span>
    </span>
  );
  const title = (
    <span
      {...stylex.props([
        chatStreamComposition.part4,
        isMobile ? chatStreamComposition.part5 : chatStreamComposition.part6,
      ])}
    >
      {label}
    </span>
  );
  return (
    <button
      type="button"
      aria-expanded={false}
      className={[
        stylex.props([
          chatStreamComposition.part7,
          isMobile ? chatStreamComposition.part8 : chatStreamComposition.part9,
        ]).className,
        'group',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {isMobile ? chevron : title}
      {isMobile ? title : chevron}
    </button>
  );
}

/** `ImageGroupBubble` with one image, `align="start"`. */
function AssistantImage({ image }: { image: ReplicaImage }) {
  // The app's img is capped by `max-h-[10.5rem]` (168px); pre-size it so the row
  // height is right before the bitmap decodes.
  const height = Math.min(168, image.height);
  const width = Math.round((height * image.width) / image.height);
  return (
    <div {...stylex.props(chatStreamStyles.row2)}>
      <div {...stylex.props(chatStreamStyles.stack)}>
        <button type="button" {...stylex.props(chatStreamStyles.row3)}>
          <img
            src={image.src}
            alt={image.fileName}
            width={width}
            height={height}
            {...stylex.props(chatStreamStyles.element)}
          />
        </button>
      </div>
    </div>
  );
}

/** `AssistantTurnFooter`: desktop keeps it hover-only (opacity-0), mobile always shows it. */
function AssistantFooter({
  hasCopyableText,
  hasConfig,
  variant,
  t,
}: {
  hasCopyableText: boolean;
  hasConfig: boolean;
  variant: Variant;
  t: Strings;
}) {
  const isMobile = variant === 'mobile';
  return (
    <div {...stylex.props(chatStreamStyles.stack2)}>
      <div
        {...stylex.props([
          chatStreamComposition.part10,
          isMobile ? chatStreamComposition.part11 : chatStreamComposition.part12,
          !isMobile && chatStreamComposition.part13,
        ])}
        data-assistant-turn-actions
      >
        {isMobile ? (
          <span {...stylex.props(chatStreamStyles.label)} style={{ minWidth: 48 }} />
        ) : null}
        {hasCopyableText || hasConfig ? (
          <div {...stylex.props(chatStreamStyles.row4)}>
            {hasCopyableText ? (
              <Button
                variant="ghost"
                size="icon"
                xstyle={buttonStyles.copy}
                iconSize="calc(var(--spacing) * 3.5)"
                aria-label={t.copyResponse}
              >
                <Copy />
              </Button>
            ) : null}
            {hasConfig ? (
              <button
                type="button"
                {...stylex.props(chatStreamStylesNative.row)}
                aria-label={t.turnConfig}
              >
                <Info {...stylex.props(chatStreamStyles.glyph)} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantTurn({
  message,
  variant,
  t,
}: {
  message: ReplicaAssistantMessage;
  variant: Variant;
  t: Strings;
}) {
  // Empty assistant entries are dropped by buildChatStreamItems.
  if (message.items.length === 0) return null;
  const rows = buildTurnRows(message, t);
  return (
    <div data-message-role="assistant" data-message-id={message.id}>
      {rows.map((row, rowIndex) => {
        const isLast = rowIndex === rows.length - 1;
        // AssistantChatItem's sibling gaps: cards `pt-3`, prose/headers `pt-1`, footer flush.
        const vertical =
          row.kind === 'footer'
            ? streamLayout.footer
            : row.kind === 'content' && row.item.type === 'image'
              ? streamLayout.image
              : streamLayout.prose;
        const tone =
          row.kind === 'activity' || row.kind === 'worked'
            ? chatStreamComposition.part15
            : chatStreamComposition.part16;
        let body: ReactNode;
        switch (row.kind) {
          case 'content':
            body =
              row.item.type === 'text' ? (
                <ReplicaMarkdown text={row.item.text} />
              ) : (
                <AssistantImage image={row.item.image} />
              );
            break;
          case 'activity':
            body = <ProcessDisclosure label={row.label} variant={variant} />;
            break;
          case 'worked':
            body = <ProcessDisclosure label={t.finishedWorking} variant={variant} />;
            break;
          case 'footer':
            body = (
              <AssistantFooter
                hasCopyableText={row.hasCopyableText}
                hasConfig={Boolean(message.modelLabel)}
                variant={variant}
                t={t}
              />
            );
            break;
        }
        return (
          <div key={row.key} {...stylex.props(chatStreamStyles.section)}>
            <ConversationColumn
              xstyle={[vertical, isLast && streamLayout.last]}
              data-assistant-turn-id={message.id}
            >
              <div {...stylex.props(chatStreamStyles.frame)}>
                <div
                  {...stylex.props([chatStreamComposition.part14, tone])}
                  style={{ fontSize: '14px' }}
                >
                  {body}
                </div>
              </div>
            </ConversationColumn>
          </div>
        );
      })}
    </div>
  );
}

// ---- User rows -------------------------------------------------------------------

/** `VisualAnnotationReferenceCard` (truncateCommentBody at 72 chars). */
function AnnotationCard({ annotation }: { annotation: ReplicaVisualAnnotation }) {
  const truncate = (value: string) => {
    const firstLine = value.split('\n')[0] ?? value;
    return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 71)}…`;
  };
  const targetText = annotation.targetText ? truncate(annotation.targetText) : '';
  return (
    <button
      type="button"
      {...stylex.props([
        chatStreamComposition.part17,
        chatStreamComposition.part18,
        chatStreamComposition.part19,
      ])}
    >
      <div {...stylex.props(chatStreamStyles.row5)}>
        <MousePointer2 {...stylex.props(chatStreamStyles.glyph2)} />
        <span {...stylex.props(chatStreamStyles.label2)}>
          {annotation.pagePath ?? '/'} · {annotation.tag.toLowerCase()}
        </span>
      </div>
      <div {...stylex.props(chatStreamStyles.caption)}>
        &ldquo;{truncate(annotation.body)}&rdquo;
      </div>
      <div {...stylex.props(chatStreamStyles.caption2)}>
        {targetText ? `${annotation.selector} · ${targetText}` : annotation.selector}
      </div>
    </button>
  );
}

/** `UserAvatar` with `showIcon` (Radix Avatar markup). */
function UserAvatar({ user, xstyle }: { user: ReplicaChatUser; xstyle: stylex.StyleXStyles }) {
  return (
    <span data-slot="avatar" {...stylex.props(streamLayout.avatar, xstyle)}>
      {user.avatarUrl ? (
        <img
          data-slot="avatar-image"
          src={user.avatarUrl}
          alt={user.name || 'User'}
          {...stylex.props(chatStreamStyles.frame2)}
        />
      ) : (
        <span data-slot="avatar-fallback" {...stylex.props(chatStreamStyles.row6)}>
          <UserIcon {...stylex.props(chatStreamStyles.glyph3)} />
        </span>
      )}
    </span>
  );
}

function UserRow({
  message,
  user,
  variant,
  locale,
  t,
}: {
  message: ReplicaUserMessage;
  user: ReplicaChatUser;
  variant: Variant;
  locale: ReplicaLocale;
  t: Strings;
}) {
  const isMobile = variant === 'mobile';
  const timestampLabel = formatConversationTimestamp(message.timestamp, locale);
  const hasText = Boolean(message.text?.trim());
  return (
    <div
      {...stylex.props(chatStreamStyles.section)}
      data-message-role="user"
      data-message-id={message.id}
    >
      <ConversationColumn xstyle={streamLayout.user}>
        <div
          {...stylex.props([
            chatStreamComposition.part21,
            isMobile ? chatStreamComposition.part22 : chatStreamComposition.part23,
          ])}
        >
          <div {...stylex.props(chatStreamStyles.caption3)}>
            <UserAvatar
              user={user}
              xstyle={isMobile ? streamLayout.mobileAvatar : streamLayout.desktopAvatar}
            />
          </div>
          <div
            className={[
              stylex.props([
                chatStreamComposition.part24,
                isMobile ? chatStreamComposition.part25 : chatStreamComposition.part26,
              ]).className,
              'group/usermsg',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div {...stylex.props(chatStreamStyles.row7)} data-testid="user-message-metadata">
              {timestampLabel ? (
                <span {...stylex.props(chatStreamStyles.label3)}>{timestampLabel}</span>
              ) : null}
              <span>
                <CheckCircle2 {...stylex.props(chatStreamStyles.glyph4)} strokeWidth={2} />
              </span>
            </div>
            <div {...stylex.props(chatStreamStyles.row8)}>
              <div {...stylex.props(chatStreamStyles.row9)}>
                <div {...stylex.props(chatStreamStyles.frame3)}>
                  <div {...stylex.props(chatStreamStyles.frame4)}>
                    {/* UserChatBubble: attachments (the annotation card) above the text. */}
                    <div {...stylex.props(chatStreamStyles.stack3)}>
                      {message.annotation ? (
                        <div {...stylex.props(chatStreamStyles.row10)}>
                          <AnnotationCard annotation={message.annotation} />
                        </div>
                      ) : null}
                      {hasText ? (
                        <div {...stylex.props(chatStreamStyles.row11)}>
                          <div {...stylex.props(chatStreamStyles.surface)}>
                            <div
                              {...stylex.props(chatStreamStyles.caption4)}
                              style={{ fontSize: '14px' }}
                            >
                              {message.text}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            {hasText ? (
              <div {...stylex.props(chatStreamStyles.row12)}>
                <Button
                  variant="ghost"
                  size="icon"
                  xstyle={[
                    buttonStyles.copy,
                    buttonStyles.fade,
                    !isMobile && buttonStyles.desktopCopy,
                  ]}
                  iconSize="calc(var(--spacing) * 3.5)"
                  aria-label={t.copyMessage}
                >
                  <Copy />
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </ConversationColumn>
    </div>
  );
}

// ---- Stream ------------------------------------------------------------------------

export function ReplicaChatStream({
  messages,
  user,
  variant,
  locale,
  className,
  xstyle,
}: {
  messages: readonly ReplicaMessage[];
  user: ReplicaChatUser;
  variant: Variant;
  locale: ReplicaLocale;
  className?: string;
  xstyle?: stylex.StyleXStyles;
}) {
  const t = STRINGS[locale];
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrolledFromTop, setScrolledFromTop] = useState(false);

  // The app's sticky list follows the output; the inert frame can never scroll
  // away from the bottom, so the replica simply stays pinned there.
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setScrolledFromTop(el.scrollTop > 0);
  }, []);

  useLayoutEffect(pinToBottom, [messages, variant, pinToBottom]);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(pinToBottom);
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [pinToBottom]);

  return (
    <div
      className={[stylex.props(streamLayout.root, xstyle).className, className]
        .filter(Boolean)
        .join(' ')}
      style={stylex.props(streamLayout.root, xstyle).style}
    >
      <div
        ref={scrollRef}
        data-slot="scroll-area"
        className={[stylex.props(chatStreamStyles.frame5).className, 'chat-scrollbar']
          .filter(Boolean)
          .join(' ')}
        // `--conversation-top-inset` (set by the mobile session shell) lets the
        // first message clear its floating header; unset it is a no-op.
        style={{
          display: 'block',
          overflowY: 'auto',
          contain: 'strict',
          width: '100%',
          height: '100%',
          paddingTop: 'calc(var(--conversation-top-inset, 0px) + 1.5rem)',
        }}
      >
        <div ref={contentRef}>
          {messages.map((message) =>
            message.role === 'user' ? (
              <UserRow
                key={message.id}
                message={message}
                user={user}
                variant={variant}
                locale={locale}
                t={t}
              />
            ) : (
              <AssistantTurn key={message.id} message={message} variant={variant} t={t} />
            )
          )}
        </div>
      </div>
      {/* Top fade into the canvas once scrolled (desktop only). */}
      {variant === 'desktop' && scrolledFromTop ? (
        <div {...stylex.props(chatStreamStyles.overlay)} />
      ) : null}
    </div>
  );
}
