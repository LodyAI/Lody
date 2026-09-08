const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

export function markdownHasUnclosedFence(text: string): boolean {
  let open: { char: string; len: number } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const marker = match[2];
    const char = marker[0];
    const len = marker.length;
    const info = match[3];
    if (!open) {
      if (char === '`' && info.includes('`')) continue;
      open = { char, len };
      continue;
    }
    if (char === open.char && len >= open.len && info.trim() === '') {
      open = null;
    }
  }
  return open !== null;
}

export function resolveMarkdownStreamdownMode(
  isStreaming: boolean,
  text = ''
): 'static' | 'streaming' {
  if (isStreaming || markdownHasUnclosedFence(text)) return 'streaming';
  return 'static';
}
