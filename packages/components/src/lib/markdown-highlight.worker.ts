import type { BundledLanguage } from 'shiki';
import {
  createMarkdownHighlighter,
  tokenizeMarkdownCode,
  type MarkdownHighlighter,
} from './markdown-highlighter';
import type {
  MarkdownHighlightRequest,
  MarkdownHighlightResponse,
} from './markdown-highlight-client';

/**
 * Tokenizes markdown code blocks off the main thread. Requests are handled one
 * at a time in arrival order, so results for the same block arrive in the order
 * its versions were requested.
 */
let highlighter: Promise<MarkdownHighlighter> | null = null;

const post = (message: MarkdownHighlightResponse) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<MarkdownHighlightRequest>) => {
  const { id, code, language } = event.data;
  try {
    highlighter ??= createMarkdownHighlighter();
    const tokens = tokenizeMarkdownCode(await highlighter, code, language as BundledLanguage);
    post({ id, tokens });
  } catch (error) {
    post({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
