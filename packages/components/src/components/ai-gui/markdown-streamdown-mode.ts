import { markdownHasUnclosedFence } from '@/lib/markdown-single-dollar-math';

export { markdownHasUnclosedFence };

export function resolveMarkdownStreamdownMode(
  isStreaming: boolean,
  text = ''
): 'static' | 'streaming' {
  if (isStreaming || markdownHasUnclosedFence(text)) return 'streaming';
  return 'static';
}
