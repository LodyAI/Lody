/**
 * Conversation selection quotes are captured snapshots: they carry the quoted
 * prose and nothing that could re-resolve it after the message changes. The
 * capture itself lives in `components/ai-gui/selection-quote.tsx`; this module
 * keeps the shape and the prompt text that the composer draft expands to.
 */
export interface ConversationSelectionQuote {
  readonly text: string;
}

/** Matches the document-selection cap; longer selections do not offer the action. */
export const MAX_SELECTION_QUOTE_TEXT = 50_000;

export function formatSelectionQuote(quote: ConversationSelectionQuote): string {
  const text = quote.text.trim();
  if (!text || text.length > MAX_SELECTION_QUOTE_TEXT)
    throw new RangeError('Conversation selection quote is empty or too large');
  return [
    'Message selection',
    'Selected content:',
    ...text.split('\n').map((line) => (line ? `> ${line}` : '>')),
  ].join('\n');
}

/** The plain quote preview the bar shows; the chip builds its own label from it. */
export function selectionQuoteLabel(text: string, maxLength = 24): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

/**
 * The composer chip label: the quote itself, so several quotes stay tellable
 * apart. The brackets are geometry, not decoration — a pasted-text chip paints
 * its glyph over the leading `figure space + [` and covers the trailing
 * `] + figure space`, the same slots `[Pasted 4,182 chars]` pays for. An
 * undelimited label would lose the quote's own first and last character.
 */
export function selectionQuoteChipLabel(text: string, maxLength = 24): string {
  return `[${selectionQuoteLabel(text, maxLength)}]`;
}
