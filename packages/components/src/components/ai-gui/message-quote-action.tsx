import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Popover } from '@lody/ui/popover';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text as textScale } from '@lody/ui/tokens/scales.stylex';
import { ArrowUp, Quote } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { useIsMobile } from '@/hooks/use-mobile';
import { useSafeAreaCollisionPadding } from '@/hooks/use-safe-area-insets';
import { selectedMessageMarkdown } from './message-quote-markdown';

const styles = stylex.create({
  floating: { position: 'fixed', zIndex: 80 },
  reply: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    width: 'min(360px, calc(100vw - 32px))',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space[2] },
  excerpt: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 3,
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    color: colors.secondaryLabel,
    fontSize: textScale.footnoteSize,
    lineHeight: textScale.footnoteLeading,
  },
});

export type MessageQuoteOptions = {
  /** The question asked about the quote, appended right after it. */
  comment?: string;
  /** Send the composer once the quote and comment are in it. */
  send?: boolean;
};
type Reply = { markdown: string; anchor: Capture['anchor'] };
type Capture = {
  text: string;
  range: Range;
  multiplePassages: boolean;
  anchor: { center: number; top: number; bottom: number };
  bounds: { left: number; right: number; top: number; bottom: number };
};

// A turn can render consecutive text entries as separate virtual rows. Do not
// mistake those rows for separate messages, or snapshot a gap in a virtualized
// selection while its intervening rows are still unavailable.
function isSinglePassage(root: HTMLElement, start: Element, end: Element): boolean {
  if (start === end) return true;
  const startRow = start.closest<HTMLElement>('[data-conversation-row-key]');
  const endRow = end.closest<HTMLElement>('[data-conversation-row-key]');
  const turnId = startRow?.dataset.conversationTurnId;
  const first = Number(startRow?.dataset.virtualIndex);
  const last = Number(endRow?.dataset.virtualIndex);
  if (
    !turnId ||
    turnId !== endRow?.dataset.conversationTurnId ||
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first > last
  )
    return false;
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-conversation-row-key]')).filter(
    (row) => {
      const index = Number(row.dataset.virtualIndex);
      return index >= first && index <= last;
    }
  );
  return (
    rows.length === last - first + 1 &&
    rows.every(
      (row) =>
        row.dataset.conversationTurnId === turnId && row.querySelector('[data-message-quote-text]')
    )
  );
}

/** A portal action, not a row or a composer bar: it cannot resize the viewport. */
export function MessageQuoteAction({
  root,
  enabled,
  onQuote,
}: {
  root: HTMLElement | null;
  enabled: boolean;
  onQuote: (text: string, options?: MessageQuoteOptions) => boolean;
}) {
  const { t } = useTranslation();
  const {
    top: safeTop,
    right: safeRight,
    bottom: safeBottom,
    left: safeLeft,
  } = useSafeAreaCollisionPadding();
  const [capture, setCapture] = useState<Capture | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);
  const [comment, setComment] = useState('');
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const isMobile = useIsMobile();
  const actionRef = useRef<HTMLDivElement>(null);
  const onQuoteRef = useRef(onQuote);
  onQuoteRef.current = onQuote;
  useLayoutEffect(() => {
    const action = actionRef.current;
    if (!capture || !action) return;
    const { width, height } = action.getBoundingClientRect();
    const { anchor, bounds } = capture;
    const above = anchor.top - height - 6;
    const top = above >= bounds.top ? above : anchor.bottom + 6;
    action.style.left = `${Math.max(
      bounds.left,
      Math.min(anchor.center - width / 2, bounds.right - width)
    )}px`;
    action.style.top = `${Math.max(bounds.top, Math.min(top, bounds.bottom - height))}px`;
  }, [capture]);
  useEffect(() => {
    setCapture(null);
    setReply(null);
    if (!root || !enabled) return undefined;
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    if (!win) return undefined;
    let dragging = false;
    let frame: number | undefined;
    let dismissed = false;
    const update = () => {
      frame = undefined;
      if (dragging || dismissed) return;
      const selection = doc.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) {
        if (!actionRef.current?.contains(doc.activeElement)) setCapture(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const element = (node: Node) => (node instanceof win.Element ? node : node.parentElement);
      const start = element(range.startContainer)?.closest('[data-message-quote-text]');
      const end = element(range.endContainer)?.closest('[data-message-quote-text]');
      if (!start || !end || !root.contains(start) || !root.contains(end)) {
        setCapture(null);
        return;
      }
      if (
        element(range.startContainer)?.closest('button,input,textarea,[contenteditable="true"]') ||
        element(range.endContainer)?.closest('button,input,textarea,[contenteditable="true"]')
      ) {
        setCapture(null);
        return;
      }
      const text = selection.toString();
      if (!text.trim()) {
        setCapture(null);
        return;
      }
      const rects = Array.from(range.getClientRects());
      const rootBounds = root.getBoundingClientRect();
      const viewport = win.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? win.innerWidth;
      const height = viewport?.height ?? win.innerHeight;
      const bounds = {
        left: Math.max(rootBounds.left, leftEdge + safeLeft),
        right: Math.min(rootBounds.right, leftEdge + width - safeRight),
        top: Math.max(rootBounds.top, topEdge + safeTop),
        bottom: Math.min(rootBounds.bottom, topEdge + height - safeBottom),
      };
      const visible = rects.filter(
        (rect) =>
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom &&
          rect.right > bounds.left &&
          rect.left < bounds.right
      );
      const first = visible[0];
      const last = visible.at(-1);
      if (!first || !last) {
        setCapture(null);
        return;
      }
      setCapture({
        text,
        range: range.cloneRange(),
        multiplePassages: !isSinglePassage(root, start, end),
        anchor: { center: (first.left + first.right) / 2, top: first.top, bottom: last.bottom },
        bounds,
      });
    };
    const schedule = () => {
      if (frame === undefined) frame = win.requestAnimationFrame(update);
    };
    const down = (event: PointerEvent) => {
      if (actionRef.current?.contains(event.target as Node)) return;
      dismissed = false;
      dragging = root.contains(event.target as Node);
      setCapture(null);
    };
    const up = () => {
      dragging = false;
      schedule();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismissed = true;
        setCapture(null);
      } else if (event.shiftKey) {
        dismissed = false;
        schedule();
      }
    };
    doc.addEventListener('selectionchange', schedule);
    doc.addEventListener('pointerdown', down, true);
    doc.addEventListener('pointerup', up, true);
    doc.addEventListener('pointercancel', up, true);
    doc.addEventListener('keydown', key);
    doc.addEventListener('scroll', schedule, true);
    win.addEventListener('resize', schedule);
    win.visualViewport?.addEventListener('resize', schedule);
    win.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      doc.removeEventListener('selectionchange', schedule);
      doc.removeEventListener('pointerdown', down, true);
      doc.removeEventListener('pointerup', up, true);
      doc.removeEventListener('pointercancel', up, true);
      doc.removeEventListener('keydown', key);
      doc.removeEventListener('scroll', schedule, true);
      win.removeEventListener('resize', schedule);
      win.visualViewport?.removeEventListener('resize', schedule);
      win.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [enabled, root, safeBottom, safeLeft, safeRight, safeTop]);
  if (!root || !enabled) return null;
  const closeReply = () => {
    setReply(null);
    setComment('');
  };
  const submitReply = (send: boolean) => {
    if (!reply) return;
    const question = comment.trim();
    if (send && !question) return;
    if (onQuoteRef.current(reply.markdown, { comment: question, send })) {
      root.ownerDocument.getSelection()?.removeAllRanges();
      closeReply();
    }
  };
  if (reply) {
    const field = (
      <Textarea
        ref={replyInputRef}
        rows={isMobile ? 3 : 2}
        resize="none"
        value={comment}
        aria-label={t('composer.messageQuoteReplyLabel', 'Question about the quote')}
        placeholder={t('composer.messageQuoteReplyPlaceholder', 'Ask about this quote…')}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          // A phone keyboard's return key writes a line; the button sends.
          if (
            isMobile ||
            event.key !== 'Enter' ||
            event.shiftKey ||
            isImeComposingKeyboardEvent(event)
          )
            return;
          event.preventDefault();
          submitReply(true);
        }}
      />
    );
    const actions = (
      <div {...stylex.props(styles.actions)}>
        <Button
          type="button"
          variant="ghost"
          size="small"
          data-testid="message-quote-add"
          onClick={() => submitReply(false)}
        >
          {t('composer.messageQuoteAddToComposer', 'Add to message')}
        </Button>
        <Button
          type="button"
          size="small"
          data-testid="message-quote-send"
          disabled={!comment.trim()}
          onClick={() => submitReply(true)}
        >
          <ArrowUp size={14} />
          {t('composer.messageQuoteSend', 'Send')}
        </Button>
      </div>
    );
    if (isMobile)
      return (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open) closeReply();
          }}
        >
          <Dialog.Content initialFocus={replyInputRef} finalFocus={false}>
            <Dialog.Header>
              <Dialog.Title>{t('composer.quoteMessage', 'Quote')}</Dialog.Title>
              <Dialog.Description {...stylex.props(styles.excerpt)}>
                {reply.markdown}
              </Dialog.Description>
            </Dialog.Header>
            {field}
            <Dialog.Footer>{actions}</Dialog.Footer>
          </Dialog.Content>
        </Dialog.Root>
      );
    const { anchor } = reply;
    return (
      <Popover.Root
        open
        onOpenChange={(open) => {
          if (!open) closeReply();
        }}
      >
        <Popover.Content
          side="top"
          collisionPadding={{ top: safeTop, right: safeRight, bottom: safeBottom, left: safeLeft }}
          anchor={{
            getBoundingClientRect: () =>
              ({
                x: anchor.center,
                y: anchor.top,
                left: anchor.center,
                right: anchor.center,
                top: anchor.top,
                bottom: anchor.bottom,
                width: 0,
                height: anchor.bottom - anchor.top,
                toJSON: () => ({}),
              }) as DOMRect,
          }}
          initialFocus={replyInputRef}
          finalFocus={false}
        >
          <div {...stylex.props(styles.reply)} data-testid="message-quote-reply">
            {field}
            {actions}
          </div>
        </Popover.Content>
      </Popover.Root>
    );
  }
  if (!capture) return null;
  return createPortal(
    <div ref={actionRef} {...stylex.props(styles.floating)}>
      <Button
        type="button"
        variant="secondary"
        size="small"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          const start = (
            capture.range.startContainer.nodeType === Node.ELEMENT_NODE
              ? (capture.range.startContainer as Element)
              : capture.range.startContainer.parentElement
          )?.closest('[data-message-quote-text]');
          const end = (
            capture.range.endContainer.nodeType === Node.ELEMENT_NODE
              ? (capture.range.endContainer as Element)
              : capture.range.endContainer.parentElement
          )?.closest('[data-message-quote-text]');
          if (capture.multiplePassages || !start || !end || !isSinglePassage(root, start, end)) {
            toast.error(
              t(
                'composer.messageQuoteSeparatePassages',
                'Select one passage at a time; you can add several quotes.'
              )
            );
            return;
          }
          if (capture.text.length > 50_000) {
            toast.error(
              t('composer.messageQuoteTooLong', 'Select up to 50,000 characters to quote.')
            );
            return;
          }
          if (
            !capture.range.startContainer.isConnected ||
            !root.contains(capture.range.startContainer)
          ) {
            setCapture(null);
            return;
          }
          let markdown: string;
          try {
            markdown = selectedMessageMarkdown(capture.range, root);
            if (!markdown.trim()) throw new Error('Empty quote');
          } catch {
            toast.error(
              t(
                'composer.messageQuoteFormatFailed',
                'Could not preserve this selection. Try selecting it again.'
              )
            );
            return;
          }
          if (markdown.length > 50_000) {
            toast.error(
              t('composer.messageQuoteTooLong', 'Select up to 50,000 characters to quote.')
            );
            return;
          }
          setComment('');
          setReply({ markdown, anchor: capture.anchor });
          setCapture(null);
        }}
      >
        <Quote size={14} />
        {capture.multiplePassages
          ? t('composer.messageQuoteSeparateAction', 'Quote passages separately')
          : t('composer.quoteMessage', 'Quote')}
      </Button>
    </div>,
    root.ownerDocument.body
  );
}
