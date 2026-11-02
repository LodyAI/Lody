/** The wire representation is text so every ACP Agent receives the snapshot. */
export const MESSAGE_QUOTE_VERSION = 1 as const;
const HEADER = '<message-quote>\nQuoted message (context):\n';
const FOOTER = '\n</message-quote>';

export function formatMessageQuote(snapshot: string): string {
  return (
    HEADER +
    snapshot
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n') +
    FOOTER
  );
}

/** Only call for an explicitly versioned quote span, never to guess user Markdown. */
export function readMessageQuote(text: string, version: unknown): string | undefined {
  if (version !== MESSAGE_QUOTE_VERSION || !text.startsWith(HEADER) || !text.endsWith(FOOTER))
    return undefined;
  const lines = text.slice(HEADER.length, -FOOTER.length).split('\n');
  if (!lines.every((line) => line.startsWith('> '))) return undefined;
  return lines.map((line) => line.slice(2)).join('\n');
}
