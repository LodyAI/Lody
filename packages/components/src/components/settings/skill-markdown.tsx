import * as React from 'react';

/**
 * A tiny, dependency-free Markdown renderer for the skill detail view.
 *
 * It is used as the resilient fallback when the app's full `MarkdownRenderer`
 * (Streamdown) fails to render — e.g. its lazy code-highlighter chunk can't be
 * fetched (a stale Vite dev optimize-deps chunk). It covers the SKILL.md subset
 * (headings, paragraphs, bold/italic/inline-code, links, ordered/unordered
 * lists, fenced code, blockquotes, horizontal rules). It renders React elements
 * directly (never `dangerouslySetInnerHTML`), so it is XSS-safe by construction,
 * and link hrefs are restricted to safe schemes.
 */

function safeHref(rawUrl: string): string | undefined {
  const url = rawUrl.trim();
  // Allow http(s), mailto, in-repo relative, anchors. Reject javascript:, data:, etc.
  if (/^(https?:\/\/|mailto:|\/|#|\.\/|\.\.\/)/i.test(url)) {
    return url;
  }
  return undefined;
}

const INLINE_CODE_CLASS =
  'rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground';
const LINK_CLASS = 'text-primary underline underline-offset-2 hover:opacity-80';

/** Parse a single line of inline Markdown into React nodes. */
export function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let counter = 0;

  while (remaining.length > 0) {
    const key = `${keyPrefix}-${counter++}`;
    // Earliest match across the supported inline patterns wins; order matters
    // so `**bold**` is matched before `*italic*` at the same index.
    const code = remaining.match(/`([^`]+)`/);
    const bold = remaining.match(/\*\*([^*]+)\*\*/);
    const link = remaining.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
    const italic = remaining.match(/\*([^*\s][^*]*)\*|_([^_\s][^_]*)_/);

    const candidates = [
      code && { index: code.index ?? -1, length: code[0].length, kind: 'code' as const, m: code },
      bold && { index: bold.index ?? -1, length: bold[0].length, kind: 'bold' as const, m: bold },
      link && { index: link.index ?? -1, length: link[0].length, kind: 'link' as const, m: link },
      italic && {
        index: italic.index ?? -1,
        length: italic[0].length,
        kind: 'italic' as const,
        m: italic,
      },
    ].filter((value): value is NonNullable<typeof value> => value != null && value.index >= 0);

    if (candidates.length === 0) {
      nodes.push(remaining);
      break;
    }

    candidates.sort((left, right) => left.index - right.index);
    const best = candidates[0]!;
    if (best.index > 0) {
      nodes.push(remaining.slice(0, best.index));
    }

    if (best.kind === 'code') {
      nodes.push(
        <code key={key} className={INLINE_CODE_CLASS}>
          {best.m[1]}
        </code>
      );
    } else if (best.kind === 'bold') {
      nodes.push(
        <strong key={key} className="font-normal text-foreground">
          {renderInlineMarkdown(best.m[1] ?? '', key)}
        </strong>
      );
    } else if (best.kind === 'link') {
      const href = safeHref(best.m[2] ?? '');
      nodes.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
            {best.m[1]}
          </a>
        ) : (
          <React.Fragment key={key}>{best.m[1]}</React.Fragment>
        )
      );
    } else {
      nodes.push(
        <em key={key} className="italic">
          {renderInlineMarkdown(best.m[1] ?? best.m[2] ?? '', key)}
        </em>
      );
    }

    remaining = remaining.slice(best.index + best.length);
  }

  return nodes;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-4 text-lg font-normal text-foreground first:mt-0',
  2: 'mt-4 text-base font-normal text-foreground first:mt-0',
  3: 'mt-3 text-sm font-normal text-foreground first:mt-0',
  4: 'mt-3 text-sm font-normal text-muted-foreground first:mt-0',
};

const SPECIAL_LINE = /^(#{1,6}\s|```|>|[-*]\s|\d+\.\s)|^(-{3,}|\*{3,}|_{3,})\s*$/;

/** Render the SKILL.md Markdown subset as React elements (no external deps). */
export function SkillMarkdownFallback({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Fenced code block.
    if (/^```/.test(line)) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !/^```/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // consume the closing fence
      blocks.push(
        <pre
          key={key++}
          className="mt-2 overflow-x-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground"
        >
          <code>{code.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1]!.length, 4);
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(
        <Tag key={key++} className={HEADING_CLASS[level]}>
          {renderInlineMarkdown(heading[2] ?? '', `h${key}`)}
        </Tag>
      );
      index += 1;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="my-3 border-border/60" />);
      index += 1;
      continue;
    }

    // Blockquote (grouped).
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote
          key={key++}
          className="mt-2 border-l-2 border-border pl-3 text-sm text-muted-foreground"
        >
          {renderInlineMarkdown(quoted.join(' '), `q${key}`)}
        </blockquote>
      );
      continue;
    }

    // Unordered list (grouped).
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={key++} className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item, `ul${key}-${itemIndex}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list (grouped).
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={key++} className="mt-2 list-decimal space-y-1 pl-5 text-sm text-foreground">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item, `ol${key}-${itemIndex}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Blank line.
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Paragraph (group consecutive non-special, non-blank lines).
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !SPECIAL_LINE.test(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push(
      <p key={key++} className="mt-2 text-sm leading-relaxed text-foreground first:mt-0">
        {renderInlineMarkdown(paragraph.join(' '), `p${key}`)}
      </p>
    );
  }

  return <div className="text-foreground">{blocks}</div>;
}
