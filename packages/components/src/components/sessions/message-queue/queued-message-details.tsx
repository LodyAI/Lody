import * as stylex from '@stylexjs/stylex';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import {
  NO_SCROLL_EDGE_OVERFLOW,
  buildScrollEdgeFadeMask,
  readScrollEdgeOverflow,
  scrollEdgeOverflowEquals,
} from '@/lib/scroll-edge-fade';
import { File as FileIcon, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageQueueItem, SessionId, SessionInputBlock } from '@lody/shared';
import { MessageTextWithChips } from '@/components/mentions/message-text-chips';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { toIntlLocale } from '@/lib/intl-locale';
import { QueuedImagePreview, type QueuedImageBlock } from './queued-image-preview';
import { queuedInputBlocksOf } from './queued-message-edit';

/** How a row's frozen run configuration reads, resolved by the host's selector catalog. */
export type QueuedRunConfigSummary = {
  agentLabel?: string | null;
  roleName?: string | null;
  modelLabel?: string | null;
  reasoningLabel?: string | null;
  modeLabel?: string | null;
  planOn?: boolean;
  fastOn?: boolean;
  /** Short label of what differs from the composer's current selection, if anything. */
  differenceTag?: string | null;
};

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  // The well is the rounded tray; its inner scroller carries the text. The fade
  // mask sits on a non-scrolling wrapper: on the scroller WKWebView paints black.
  messageWell: {
    borderRadius: radius.small,
    backgroundColor: colors.trayBackground,
    overflow: 'hidden',
  },
  message: {
    maxHeight: 220,
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.label,
    paddingInline: space[3],
    paddingBlock: space[2],
    userSelect: 'text',
  },
  paragraph: { margin: 0, marginBottom: { default: space[2], ':last-child': 0 } },
  attachments: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[1.5] },
  file: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1],
    maxWidth: 200,
    paddingInline: space[2],
    height: 24,
    borderRadius: radius.mini,
    backgroundColor: colors.trayBackground,
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
  },
  fileName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    columnGap: space[3],
    rowGap: space[1],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  term: { color: colors.secondaryLabel, whiteSpace: 'nowrap' },
  value: {
    color: colors.label,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sender: { display: 'inline-flex', alignItems: 'center', gap: space[1.5], minWidth: 0 },
  footer: { display: 'flex', justifyContent: 'flex-end' },
});

function useQueuedTime(timestamp: string | undefined): string | null {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const at = timestamp ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isFinite(at)) return null;
    return new Intl.DateTimeFormat(toIntlLocale(i18n.resolvedLanguage ?? i18n.language), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
  }, [i18n.language, i18n.resolvedLanguage, timestamp]);
}

const MESSAGE_FADE_PX = 24;

/** A long message scrolls inside its well, fading at whichever edge has more. */
function FadingMessage({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(NO_SCROLL_EDGE_OVERFLOW);
  const update = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const next = readScrollEdgeOverflow(element);
    setOverflow((current) => (scrollEdgeOverflowEquals(current, next) ? current : next));
  }, []);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    update();
    element.addEventListener('scroll', update, { passive: true });
    const stop = observeResizeOnAnimationFrame(element, update);
    return () => {
      element.removeEventListener('scroll', update);
      stop();
    };
  }, [update]);
  const mask = buildScrollEdgeFadeMask(overflow, MESSAGE_FADE_PX);
  return (
    <div {...stylex.props(styles.messageWell)}>
      <div style={{ maskImage: mask, WebkitMaskImage: mask }}>
        <div ref={scrollRef} {...stylex.props(styles.message)} data-text-selectable="">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Read-only details of one queued message: what it says and how it will run. */
export function QueuedMessageDetails({
  sessionId,
  item,
  summary,
  senderAvatar,
  onEdit,
  editDisabled,
}: {
  sessionId: SessionId;
  item: MessageQueueItem;
  summary?: QueuedRunConfigSummary;
  senderAvatar?: ReactNode;
  onEdit?: () => void;
  editDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const blocks = useMemo(() => queuedInputBlocksOf(item), [item]);
  const textBlocks = blocks.filter(
    (block): block is Extract<SessionInputBlock, { type: 'text' }> =>
      block.type === 'text' && block.text.trim().length > 0
  );
  const images = blocks.filter((block): block is QueuedImageBlock => block.type === 'image');
  const files = blocks.flatMap((block) =>
    block.type === 'file' || (block.type === 'local_attachment' && block.kind === 'file')
      ? [block.fileName]
      : []
  );
  const queuedAt = useQueuedTime(item.timestamp);
  const yes = t('sessions.messageQueue.details.on', 'On');
  const rows: { term: string; value: ReactNode }[] = [];
  if (item.userName || senderAvatar)
    rows.push({
      term: t('sessions.messageQueue.details.sender', 'From'),
      value: (
        <span {...stylex.props(styles.sender)}>
          {senderAvatar}
          <span {...stylex.props(styles.value)}>{item.userName ?? ''}</span>
        </span>
      ),
    });
  if (queuedAt)
    rows.push({ term: t('sessions.messageQueue.details.queuedAt', 'Queued'), value: queuedAt });
  if (summary?.roleName)
    rows.push({ term: t('sessions.messageQueue.details.role', 'Role'), value: summary.roleName });
  if (summary?.agentLabel)
    rows.push({
      term: t('sessions.messageQueue.details.agent', 'Agent'),
      value: summary.agentLabel,
    });
  if (summary?.modelLabel)
    rows.push({
      term: t('sessions.messageQueue.details.model', 'Model'),
      value: summary.modelLabel,
    });
  if (summary?.reasoningLabel)
    rows.push({
      term: t('sessions.messageQueue.details.reasoning', 'Reasoning'),
      value: summary.reasoningLabel,
    });
  if (summary?.modeLabel)
    rows.push({ term: t('sessions.messageQueue.details.mode', 'Mode'), value: summary.modeLabel });
  if (summary?.planOn)
    rows.push({ term: t('sessions.messageQueue.details.plan', 'Plan'), value: yes });
  if (summary?.fastOn)
    rows.push({ term: t('sessions.messageQueue.details.fast', 'Fast'), value: yes });

  return (
    <div {...stylex.props(styles.root)} data-queued-message-details="">
      {textBlocks.length > 0 ? (
        <FadingMessage>
          {/* Mentions read as the conversation shows them: chips, not their expansions. */}
          {textBlocks.map((block, index) => (
            <p key={index} {...stylex.props(styles.paragraph)}>
              <MessageTextWithChips text={block.text} spans={block.spans} />
            </p>
          ))}
        </FadingMessage>
      ) : null}
      {images.length > 0 || files.length > 0 ? (
        <div {...stylex.props(styles.attachments)}>
          {images.map((image, index) => (
            <QueuedImagePreview
              key={`${image.imageId}-${index}`}
              sessionId={sessionId}
              image={image}
              size={40}
            />
          ))}
          {files.map((name, index) => (
            <span key={`${name}-${index}`} {...stylex.props(styles.file)}>
              <FileIcon size={12} strokeWidth={1.75} aria-hidden="true" />
              <span {...stylex.props(styles.fileName)}>{name}</span>
            </span>
          ))}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <dl {...stylex.props(styles.grid)}>
          {rows.map((row) => (
            <div key={row.term} style={{ display: 'contents' }}>
              <dt {...stylex.props(styles.term)}>{row.term}</dt>
              <dd {...stylex.props(styles.value)}>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {onEdit ? (
        <div {...stylex.props(styles.footer)}>
          <Button variant="secondary" size="small" disabled={editDisabled} onClick={onEdit}>
            <Pencil size={13} strokeWidth={1.75} aria-hidden="true" />
            {t('common.edit', 'Edit')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
