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
import { cn } from './utils';

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
export function ConversationColumn({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mx-auto w-full max-w-[46rem] px-[14px] sm:px-[18px]', className)}
      {...props}
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
      className={cn(
        'inline-flex flex-none shrink-0 origin-center text-muted-foreground',
        !isMobile &&
          'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100'
      )}
    >
      <span className="inline-flex origin-center">
        <ChevronRight
          className={isMobile ? 'h-3.5 w-3.5 shrink-0 text-muted-foreground' : 'h-[1em] w-[1em]'}
        />
      </span>
    </span>
  );
  const title = (
    <span
      className={cn(
        'min-w-0',
        isMobile
          ? 'flex-1 text-[12.5px] font-medium leading-snug text-muted-foreground'
          : 'text-[length:var(--markdown-body-font-size,1em)] font-normal leading-[1.75]'
      )}
    >
      {label}
    </span>
  );
  return (
    <button
      type="button"
      aria-expanded={false}
      className={cn(
        'group flex w-full items-center py-0.5 text-left',
        isMobile
          ? 'gap-1.5 rounded-md pr-1 hover:bg-hover/40 text-[12.5px] font-medium leading-snug text-muted-foreground'
          : 'justify-start gap-0.5 px-[4px] text-muted-foreground'
      )}
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
    <div className="flex w-full justify-start">
      <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/20 inline-flex max-w-full flex-col">
        <button type="button" className="inline-flex max-w-full">
          <img
            src={image.src}
            alt={image.fileName}
            width={width}
            height={height}
            className="block max-h-[10.5rem] max-w-full object-contain"
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
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          'flex flex-wrap items-center justify-start text-[11px] text-muted-foreground',
          isMobile ? 'min-h-6 gap-1' : 'min-h-7 gap-2',
          !isMobile && 'opacity-0 transition-opacity duration-150 focus-within:opacity-100'
        )}
        data-assistant-turn-actions
      >
        {isMobile ? <span className="shrink-0 tabular-nums" style={{ minWidth: 48 }} /> : null}
        {hasCopyableText || hasConfig ? (
          <div className="flex items-center gap-0.5 -mr-[7px]">
            {hasCopyableText ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:bg-hover hover:text-foreground"
                aria-label={t.copyResponse}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            {hasConfig ? (
              <button
                type="button"
                className="inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring h-7 w-7"
                aria-label={t.turnConfig}
              >
                <Info className="h-3.5 w-3.5" strokeWidth={2} />
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
            ? 'pt-0 pb-0'
            : row.kind === 'content' && row.item.type === 'image'
              ? 'pt-3 pb-0'
              : 'pt-1 pb-0';
        const tone =
          row.kind === 'activity' || row.kind === 'worked'
            ? 'text-muted-foreground'
            : 'text-foreground';
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
          <div key={row.key} className="relative">
            <ConversationColumn
              className={cn(vertical, isLast && 'pb-2 sm:pb-3')}
              data-assistant-turn-id={message.id}
            >
              <div className="w-full">
                <div className={cn('max-w-[800px] break-words', tone)} style={{ fontSize: '14px' }}>
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
      className={cn(
        'flex w-full max-w-sm flex-col gap-1 rounded-lg border px-3 py-2 text-left text-xs',
        'bg-muted/40 transition-colors hover:bg-muted/70',
        'cursor-default'
      )}
    >
      <div className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <MousePointer2 className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {annotation.pagePath ?? '/'} · {annotation.tag.toLowerCase()}
        </span>
      </div>
      <div className="truncate text-foreground/75">&ldquo;{truncate(annotation.body)}&rdquo;</div>
      <div className="truncate font-mono text-[10px] text-muted-foreground">
        {targetText ? `${annotation.selector} · ${targetText}` : annotation.selector}
      </div>
    </button>
  );
}

/** `UserAvatar` with `showIcon` (Radix Avatar markup). */
function UserAvatar({ user, className }: { user: ReplicaChatUser; className: string }) {
  return (
    <span
      data-slot="avatar"
      className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full', className)}
    >
      {user.avatarUrl ? (
        <img
          data-slot="avatar-image"
          src={user.avatarUrl}
          alt={user.name || 'User'}
          className="aspect-square size-full"
        />
      ) : (
        <span
          data-slot="avatar-fallback"
          className="bg-muted flex size-full items-center justify-center rounded-full"
        >
          <UserIcon className="h-4 w-4" />
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
    <div className="relative" data-message-role="user" data-message-id={message.id}>
      <ConversationColumn className="py-2 sm:py-3">
        <div className={cn('flex w-full flex-row-reverse', isMobile ? 'gap-2 pl-7' : 'gap-2.5')}>
          <div className="mt-0.5 shrink-0 text-muted-foreground">
            <UserAvatar user={user} className={isMobile ? 'h-7 w-7' : 'h-8 w-8'} />
          </div>
          <div
            className={cn(
              'group/usermsg flex min-w-0 flex-1 flex-col items-end text-left',
              isMobile
                ? 'max-w-[min(100%,28rem)] gap-1'
                : 'max-w-full gap-1.5 @[520px]:max-w-[80%] @[720px]:max-w-[70%]'
            )}
          >
            <div
              className="flex flex-row-reverse items-center gap-1.5 text-[11px] text-muted-foreground"
              data-testid="user-message-metadata"
            >
              {timestampLabel ? <span className="tabular-nums">{timestampLabel}</span> : null}
              <span>
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" strokeWidth={2} />
              </span>
            </div>
            <div className="flex w-full min-w-0 items-start justify-end">
              <div className="flex w-full min-w-0 justify-end max-w-full">
                <div className="relative min-w-0 max-w-full w-fit">
                  <div className="min-w-0 max-w-full text-foreground w-fit sm:max-w-[800px]">
                    {/* UserChatBubble: attachments (the annotation card) above the text. */}
                    <div className="flex min-w-0 max-w-full flex-col items-end gap-2">
                      {message.annotation ? (
                        <div className="flex w-full justify-end px-2 pt-1">
                          <AnnotationCard annotation={message.annotation} />
                        </div>
                      ) : null}
                      {hasText ? (
                        <div className="flex max-w-full justify-end sm:pl-2">
                          <div className="min-w-0 max-w-full rounded-[1.15rem] bg-foreground/[0.05] px-3.5 py-2 sm:rounded-2xl sm:px-4 sm:py-2.5">
                            <div
                              className="min-w-0 max-w-full whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
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
              <div className="flex gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    'h-7 w-7 text-muted-foreground hover:bg-hover hover:text-foreground transition-opacity',
                    !isMobile &&
                      'opacity-0 group-hover/usermsg:opacity-100 focus-visible:opacity-100'
                  )}
                  aria-label={t.copyMessage}
                >
                  <Copy className="h-3.5 w-3.5" />
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
}: {
  messages: readonly ReplicaMessage[];
  user: ReplicaChatUser;
  variant: Variant;
  locale: ReplicaLocale;
  className?: string;
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
    <div className={cn('h-full @container relative bg-background', className)}>
      <div
        ref={scrollRef}
        data-slot="scroll-area"
        className="chat-scrollbar relative h-full overflow-x-hidden py-5 sm:py-6"
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
        <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-background to-transparent" />
      ) : null}
    </div>
  );
}
