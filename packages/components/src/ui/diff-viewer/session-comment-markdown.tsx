'use client';

import { memo } from 'react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { cn } from '@/lib/utils';

interface SessionCommentMarkdownProps {
  body: string;
  /** Enable raw HTML rendering (sanitized). Use for GitHub comment bodies. */
  allowHtml?: boolean;
  className?: string;
}

/**
 * Chat prose sits 4px inside its rail (`tailwind/index.css`). A comment sits
 * under its author's name instead, and a PR description under its title, so
 * its prose starts flush on the text edge above it. A descendant rule, which
 * StyleX cannot express.
 */
const FLUSH_PROSE = '[&_:is(p,h1,h2,h3,h4,h5,h6)]:px-0';

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
    <MarkdownRenderer
      text={body}
      size="sm"
      allowHtml={allowHtml}
      className={cn(FLUSH_PROSE, className)}
    />
  );
});
