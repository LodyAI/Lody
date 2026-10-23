import { useCallback, useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text as textTokens } from '@lody/ui/tokens/scales.stylex';
import {
  MAX_SELECTION_QUOTE_TEXT,
  selectionQuoteLabel,
} from '@/lib/conversation-selection-quote';
import { useIsMobile } from '@/hooks/use-mobile';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { ConversationColumn } from '@/components/shared/conversation-column';

const styles = stylex.create({
  bar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    // Longhand, not `paddingBlock`: the bottom inset must not be re-shortened.
    paddingTop: space[3],
    // The bar sits on the composer's bottom edge, so it owns that inset too.
    paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  preview: {
    // Yields to the controls rather than widening the bar past its container.
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '12em',
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    fontSize: textTokens.footnoteSize,
    lineHeight: textTokens.footnoteLeading,
    color: colors.secondaryLabel,
  },
  // The three controls never share one handset row, and left to wrap the quote
  // would strand the primary action under it. Give the quote its own line
  // instead, so the actions stay together on the next one.
  previewStacked: { flexBasis: '100%' },
  // Trails the actions on that second row. Desktop is unaffected: the growing
  // quote already owns the free space, so the auto margin resolves to zero.
  dismiss: { marginInlineStart: 'auto' },
});

/**
 * Reads the live native range when it is prose inside a conversation row this
 * surface owns. Several conversation surfaces can be mounted at once (a side
 * chat beside the main conversation) and the document holds one selection, so
 * the turn id is checked against this surface's own history.
 */
function readQuoteText(
  doc: Document,
  history: { indexOf(id: string): number } | null | undefined
): string | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const row = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
    '[data-conversation-row-key]'
  );
  const turnId = row?.dataset.conversationTurnId;
  if (!turnId || !history || history.indexOf(turnId) < 0) return null;
  const text = selection.toString().trim();
  if (!text || text.length > MAX_SELECTION_QUOTE_TEXT) return null;
  return text;
}

/**
 * Captures a native selection inside one conversation's rows as a quote.
 *
 * The capture is deliberately sticky: a collapsed caret (typing, or a click
 * into the composer) is not a new selection, so the quote survives until the
 * person presses outside this bar. That keeps `pointerdown` on our own controls
 * from racing the browser's own selection teardown, which is the one thing an
 * OS long-press selection does not report in a fixed order.
 */
export function useSelectionQuote({
  scopeId,
  enabled,
  history,
}: {
  scopeId: string;
  enabled: boolean;
  /** Only turn lookup is needed to prove the range belongs to this surface. */
  history?: { indexOf(id: string): number } | null;
}) {
  const [quoteText, setQuoteText] = useState<string | null>(null);
  const [scope, setScope] = useState(scopeId);
  const current = useLatestRef({ enabled, history });
  if (scope !== scopeId) {
    setScope(scopeId);
    setQuoteText(null);
  }

  useEffect(() => {
    const doc = document;
    const sync = () => {
      const next = current.current.enabled ? readQuoteText(doc, current.current.history) : null;
      if (next) {
        setQuoteText(next);
        return;
      }
      // Only a different real range retires the quote; a caret does not.
      const selection = doc.getSelection();
      if (selection && !selection.isCollapsed) setQuoteText(null);
    };
    // A press on this bar's own controls is not a dismissal; `data-selection-quote-bar`
    // marks them so neither side holds a ref to the other.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-selection-quote-bar]')) return;
      setQuoteText(null);
    };
    doc.addEventListener('selectionchange', sync);
    doc.addEventListener('pointerdown', onPointerDown, true);
    // A pane can mount with a native range already present.
    sync();
    return () => {
      doc.removeEventListener('selectionchange', sync);
      doc.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [current]);

  const clear = useCallback(() => setQuoteText(null), []);
  return { quoteText, clear };
}

export function SelectionQuoteBar({
  quote,
  onQuote,
  onDismiss,
}: {
  quote: string | null;
  onQuote: (text: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  useEffect(() => {
    if (!quote) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest('[role="dialog"], [role="alertdialog"]'))
      )
        return;
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [quote, onDismiss]);
  if (!quote) return null;
  // These are the primary touch targets on a handset, so they keep the default
  // size there — the same call the share preview's action row makes.
  const actionSize = isMobile ? 'medium' : 'small';
  return (
    <ConversationColumn>
      <div {...stylex.props(styles.bar)} data-selection-quote-bar="">
        <span
          {...stylex.props(styles.preview, isMobile && styles.previewStacked)}
          role="status"
        >
          {t('sessions.selectionQuote.preview', 'Quoted: {{text}}', {
            text: selectionQuoteLabel(quote, 80),
          })}
        </span>
        <Button
          variant="ghost"
          size={actionSize}
          onClick={onDismiss}
          {...stylex.props(isMobile && styles.dismiss)}
        >
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button size={actionSize} onClick={() => onQuote(quote)}>
          {t('sessions.selectionQuote.action', 'Quote and comment')}
        </Button>
      </div>
    </ConversationColumn>
  );
}
