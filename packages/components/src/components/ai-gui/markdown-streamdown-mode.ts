export function markdownHasUnclosedFence(text: string): boolean {
  let open = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) open = !open;
  }
  return open;
}

export function resolveMarkdownStreamdownMode(
  isStreaming: boolean,
  text = ''
): 'static' | 'streaming' {
  if (isStreaming || markdownHasUnclosedFence(text)) return 'streaming';
  return 'static';
}
