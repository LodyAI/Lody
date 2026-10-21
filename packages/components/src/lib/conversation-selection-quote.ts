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

/** The composer chip label: the quote itself, so several quotes stay tellable apart. */
export function selectionQuoteLabel(text: string, maxLength = 24): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}
