import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Quote } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { useSafeAreaCollisionPadding } from '@/hooks/use-safe-area-insets';

const styles = stylex.create({ floating: { position: 'fixed', zIndex: 80 } });
type Capture = {
  text: string;
  range: Range;
  multiplePassages: boolean;
  anchor: { center: number; top: number; bottom: number };
  bounds: { left: number; right: number; top: number; bottom: number };
};

/** A portal action, not a row or a composer bar: it cannot resize the viewport. */
export function MessageQuoteAction({
  root,
  enabled,
  onQuote,
}: {
  root: HTMLElement | null;
  enabled: boolean;
  onQuote: (text: string) => boolean;
}) {
  const { t } = useTranslation();
  const {
    top: safeTop,
    right: safeRight,
    bottom: safeBottom,
    left: safeLeft,
  } = useSafeAreaCollisionPadding();
  const [capture, setCapture] = useState<Capture | null>(null);
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
        multiplePassages: start !== end,
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
  if (!capture || !root || !enabled) return null;
  return createPortal(
    <div ref={actionRef} {...stylex.props(styles.floating)}>
      <Button
        type="button"
        variant="secondary"
        size="small"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (capture.multiplePassages) {
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
          if (onQuoteRef.current(capture.text)) {
            root.ownerDocument.getSelection()?.removeAllRanges();
            setCapture(null);
          }
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
