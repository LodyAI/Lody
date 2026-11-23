'use client';

import { memo } from 'react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { PrRemoteImageContext } from '@/components/ai-gui/pr-remote-image';

interface SessionCommentMarkdownProps {
  body: string;
  /** Enable raw HTML rendering (sanitized). Use for GitHub comment bodies. */
  allowHtml?: boolean;
  className?: string;
}

/**
 * Renders comment body as Markdown using the shared MarkdownRenderer.
 * Uses 'sm' size for compact display inside diff annotations.
 */
export const SessionCommentMarkdown = memo(function SessionCommentMarkdown({
  body,
  allowHtml = false,
  className,
}: SessionCommentMarkdownProps) {
  return (
    <PrRemoteImageContext.Provider value={true}>
      <MarkdownRenderer text={body} size="sm" allowHtml={allowHtml} flush className={className} />
    </PrRemoteImageContext.Provider>
  );
});
