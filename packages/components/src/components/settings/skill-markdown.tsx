import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';

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

const MONO = 'var(--font-mono, ui-monospace, monospace)';

const styles = stylex.create({
  root: { color: colors.label },
  /** Inline code is a film of ink over the prose, the way a badge is: no edge. */
  inlineCode: {
    paddingInline: space[1],
    paddingBlock: '2px',
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 6%)`,
    color: colors.label,
    fontFamily: MONO,
    fontSize: '0.85em',
  },
  strong: { fontWeight: 400, color: colors.label },
  italic: { fontStyle: 'italic' },
  link: {
    color: colors.accent,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    opacity: { default: 1, ':hover': 0.8 },
  },
  /** A block inside the panel is the region rung: a fill with no edge. */
  codeBlock: {
    marginTop: space[2],
    marginBottom: 0,
    overflowX: 'auto',
    padding: space[3],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    color: colors.label,
    fontFamily: MONO,
    fontSize: '0.75em',
    lineHeight: 1.625,
  },
  heading: {
    marginTop: { default: space[4], ':first-child': 0 },
    marginBottom: 0,
    fontWeight: 400,
    color: colors.label,
  },
  headingMinor: { marginTop: { default: space[3], ':first-child': 0 } },
  h1: { fontSize: '1.125em', lineHeight: 1.55 },
  h2: { fontSize: '1em', lineHeight: 1.5 },
  h3: { fontSize: '0.875em', lineHeight: 1.43 },
  h4: { fontSize: '0.875em', lineHeight: 1.43, color: colors.secondaryLabel },
  rule: {
    height: '1px',
    marginBlock: space[3],
    borderWidth: 0,
    backgroundColor: colors.separator,
  },
  /** A quote is marked by the one structural line prose has, at its start. */
  quote: {
    marginTop: space[2],
    marginBottom: 0,
    marginInline: 0,
    paddingInlineStart: space[3],
    boxShadow: `inset 2px 0 0 ${colors.separator}`,
    fontSize: '0.875em',
    color: colors.secondaryLabel,
  },
  list: {
    marginTop: space[2],
    marginBottom: 0,
    paddingInlineStart: '20px',
    fontSize: '0.875em',
    color: colors.label,
  },
  bullets: { listStyleType: 'disc' },
  numbers: { listStyleType: 'decimal' },
  item: { marginTop: { default: space[1], ':first-child': 0 } },
  paragraph: {
    marginTop: { default: space[2], ':first-child': 0 },
    marginBottom: 0,
    fontSize: '0.875em',
    lineHeight: 1.625,
    color: colors.label,
  },
});

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
        <code key={key} {...stylex.props(styles.inlineCode)}>
          {best.m[1]}
        </code>
      );
    } else if (best.kind === 'bold') {
      nodes.push(
        <strong key={key} {...stylex.props(styles.strong)}>
          {renderInlineMarkdown(best.m[1] ?? '', key)}
        </strong>
      );
    } else if (best.kind === 'link') {
      const href = safeHref(best.m[2] ?? '');
      nodes.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            {...stylex.props(styles.link)}
          >
            {best.m[1]}
          </a>
        ) : (
          <React.Fragment key={key}>{best.m[1]}</React.Fragment>
        )
      );
    } else {
      nodes.push(
        <em key={key} {...stylex.props(styles.italic)}>
          {renderInlineMarkdown(best.m[1] ?? best.m[2] ?? '', key)}
        </em>
      );
    }

    remaining = remaining.slice(best.index + best.length);
  }

  return nodes;
}

const HEADING_STYLE = { 1: styles.h1, 2: styles.h2, 3: styles.h3, 4: styles.h4 } as const;

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
        <pre key={key++} {...stylex.props(styles.codeBlock)}>
          <code>{code.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1]!.length, 4) as 1 | 2 | 3 | 4;
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(
        <Tag
          key={key++}
          {...stylex.props(styles.heading, level > 2 && styles.headingMinor, HEADING_STYLE[level])}
        >
          {renderInlineMarkdown(heading[2] ?? '', `h${key}`)}
        </Tag>
      );
      index += 1;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} {...stylex.props(styles.rule)} />);
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
        <blockquote key={key++} {...stylex.props(styles.quote)}>
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
        <ul key={key++} {...stylex.props(styles.list, styles.bullets)}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex} {...stylex.props(styles.item)}>
              {renderInlineMarkdown(item, `ul${key}-${itemIndex}`)}
            </li>
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
        <ol key={key++} {...stylex.props(styles.list, styles.numbers)}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex} {...stylex.props(styles.item)}>
              {renderInlineMarkdown(item, `ol${key}-${itemIndex}`)}
            </li>
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
      <p key={key++} {...stylex.props(styles.paragraph)}>
        {renderInlineMarkdown(paragraph.join(' '), `p${key}`)}
      </p>
    );
  }

  return <div {...stylex.props(styles.root)}>{blocks}</div>;
}
