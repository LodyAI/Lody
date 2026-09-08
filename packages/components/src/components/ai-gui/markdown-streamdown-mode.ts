export function resolveMarkdownStreamdownMode(isStreaming: boolean): 'static' | 'streaming' {
  return isStreaming ? 'streaming' : 'static';
}
