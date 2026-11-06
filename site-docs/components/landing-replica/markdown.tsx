import type { CSSProperties, ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { FileIcon } from './icons';
import { cn } from './utils';
import * as stylex from '@stylexjs/stylex';

/* Display-only replica of the app's ai-gui `MarkdownRenderer` (Streamdown) for the
   subset the landing demo copy uses: paragraphs, `- ` bullet lists, `**bold**`,
   `` `code` ``, inline code that is a file path (file chip), bare URLs. Text may be
   a character-level streaming prefix, so unclosed `**` / `` ` `` render like
   Streamdown's `remend` closes them. */

const styles = stylex.create({
  root: { maxWidth: 'none', color: 'hsl(var(--foreground))', lineHeight: '1.75' },
  stream: { whiteSpace: 'normal' },
  paragraph: { marginTop: '0 !important', marginBottom: 'calc(var(--spacing) * 3) !important' },
  paragraphBeforeList: { marginBottom: 'calc(var(--spacing) * 2) !important' },
  lastParagraph: { marginBottom: '0 !important' },
  list: {
    marginBlock: 'calc(var(--spacing) * 2) !important',
    paddingLeft: 0,
    listStyleType: 'none',
    listStylePosition: 'inside',
    whiteSpace: 'normal',
  },
  item: {
    position: 'relative',
    paddingBlock: '0 !important',
    paddingLeft: 'calc(var(--spacing) * 6)',
    marginTop: '0 !important',
    marginBottom: '0 !important',
    '::before': {
      position: 'absolute',
      left: '10px',
      top: '0.75em',
      width: 'calc(var(--spacing) * 1)',
      height: 'calc(var(--spacing) * 1)',
      translate: '0 -50%',
      borderRadius: 'calc(infinity * 1px)',
      backgroundColor: 'currentColor',
      content: '""',
    },
  },
  followingItem: { marginTop: 'calc(var(--spacing) * 1) !important' },
  fileChip: {
    margin: 0,
    display: 'inline-flex',
    maxWidth: '100%',
    alignItems: 'baseline',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'var(--radius-sm)',
    borderWidth: 0,
    backgroundColor: 'transparent',
    padding: 0,
    verticalAlign: 'baseline',
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    textDecorationLine: { default: 'none', '@media (hover: hover)': { ':hover': 'underline' } },
    textUnderlineOffset: '2px',
    boxShadow: { default: 'none', ':focus-visible': '0 0 0 2px #fff, 0 0 0 4px hsl(var(--ring))' },
    outlineStyle: { default: null, ':focus-visible': 'solid' },
    outlineWidth: { default: null, ':focus-visible': '2px' },
    outlineColor: { default: null, ':focus-visible': 'transparent' },
    outlineOffset: { default: null, ':focus-visible': '2px' },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
  },
  fileGlyph: {
    width: '1.38em',
    height: '1.38em',
    flexShrink: 0,
    alignSelf: 'center',
    ':is(*) path[fill]': { fill: 'currentColor' },
    ':is(*) path[stroke]': { stroke: 'currentColor' },
  },
  fileName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  copyGlyph: { width: '0.85em', height: '0.85em', flexShrink: 0, alignSelf: 'center' },
  inlineCode: {
    borderRadius: 'var(--radius-sm)',
    backgroundColor: {
      default: 'color-mix(in oklab, hsl(var(--foreground)) 8%, transparent)',
      ':where(.dark, .dark *)': 'color-mix(in oklab, hsl(var(--foreground)) 14%, transparent)',
    },
    paddingInline: 'calc(var(--spacing) * 1)',
    paddingBlock: '1px',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
    color: 'hsl(var(--foreground))',
    boxShadow: 'none',
  },
  strong: { fontWeight: 'var(--font-weight-semibold)' },
  link: {
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    textDecorationColor: {
      default: 'color-mix(in oklab, currentColor 35%, transparent)',
      ':hover': 'color-mix(in oklab, currentColor 70%, transparent)',
    },
  },
});

// markdownFontSizeStyle(DEFAULT_CONVERSATION_FONT_SIZE = 14).
const MARKDOWN_FONT_SIZE_STYLE = {
  fontSize: '14px',
  '--markdown-body-font-size': '14px',
  '--markdown-h1-font-size': '18px',
  '--markdown-h2-font-size': '16px',
  '--markdown-small-heading-font-size': '12px',
} as CSSProperties;

type MarkdownBlock = { type: 'p'; text: string } | { type: 'ul'; items: string[] };

function parseBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let current: MarkdownBlock | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      current = null;
      continue;
    }
    const bullet = /^\s*-(?:\s+(.*))?$/.exec(line);
    if (bullet) {
      if (current?.type !== 'ul') {
        current = { type: 'ul', items: [] };
        blocks.push(current);
      }
      current.items.push(bullet[1] ?? '');
      continue;
    }
    if (current?.type === 'ul') {
      // Lazy continuation line of the last list item.
      current.items[current.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    if (current?.type === 'p') {
      current.text += `\n${line}`;
      continue;
    }
    current = { type: 'p', text: line };
    blocks.push(current);
  }
  return blocks;
}

// `lib/linkify-file-paths.ts`: inline code is a file chip only when its WHOLE
// content is one path — with a separator it needs an extension, without one the
// extension must be a recognized file type.
const RECOGNIZED_FILE_EXTENSION =
  /\.(?:tsx?|jsx?|mjs|cjs|json|md|mdx|css|scss|html|ya?ml|toml|rs|go|py|sh|txt|lock|svg)$/i;

function matchWholeFilePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) || /^[a-z]+:\/\//i.test(trimmed)) return null;
  const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const dot = lastSegment.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < lastSegment.length - 1;
  if (trimmed.includes('/')) return hasExtension ? trimmed : null;
  return hasExtension && RECOGNIZED_FILE_EXTENSION.test(lastSegment) ? trimmed : null;
}

const AUTOLINK_PATTERN = /https?:\/\/[^\s<]+/gu;
// CJK punctuation never appears unencoded in a URL; the app ends the URL there.
const NON_ASCII_URL_BOUNDARY = /(?!\p{ASCII})[\p{P}\p{Z}]/u;
const TRAILING_URL_PUNCT = /[.,;:!?'")\]]+$/;

function linkify(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(AUTOLINK_PATTERN)) {
    const start = match.index ?? 0;
    let url = match[0];
    const boundary = NON_ASCII_URL_BOUNDARY.exec(url);
    if (boundary) url = url.slice(0, boundary.index);
    url = url.replace(TRAILING_URL_PUNCT, '');
    if (!/^https?:\/\/./.test(url)) continue;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <a
        {...stylex.props(styles.link)}
        key={`${key}-a${start}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {url}
      </a>
    );
    cursor = start + url.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

// AgentFileLink with no open handler: icon + name + copy glyph.
function FileChip({ path }: { path: string }) {
  return (
    <button type="button" title={path} {...stylex.props(styles.fileChip)}>
      {/* The app masks the file icon with `bg-current` (MonochromeFileIcon). */}
      <FileIcon path={path} xstyle={styles.fileGlyph} />
      <span {...stylex.props(styles.fileName)}>{path}</span>
      <Copy {...stylex.props(styles.copyGlyph)} />
    </button>
  );
}

function InlineCode({ value }: { value: string }) {
  const path = matchWholeFilePath(value);
  if (path) return <FileChip path={path} />;
  return <code {...stylex.props(styles.inlineCode)}>{value}</code>;
}

function renderInline(text: string, key = 'i'): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = '';
  const flush = (at: number) => {
    if (buffer) nodes.push(...linkify(buffer, `${key}-${at}`));
    buffer = '';
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '`') {
      const close = text.indexOf('`', index + 1);
      const value = close === -1 ? text.slice(index + 1) : text.slice(index + 1, close);
      flush(index);
      if (value) nodes.push(<InlineCode key={`${key}-c${index}`} value={value} />);
      index = close === -1 ? text.length : close + 1;
      continue;
    }
    if (text.startsWith('**', index)) {
      const close = text.indexOf('**', index + 2);
      const inner = close === -1 ? text.slice(index + 2) : text.slice(index + 2, close);
      flush(index);
      if (inner) {
        nodes.push(
          <span key={`${key}-s${index}`} {...stylex.props(styles.strong)} data-streamdown="strong">
            {renderInline(inner, `${key}-s${index}`)}
          </span>
        );
      }
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    // A lone trailing `*` is half of a `**` still streaming in.
    if (char === '*' && index === text.length - 1) break;
    buffer += char;
    index += 1;
  }
  flush(index);
  return nodes;
}

export function ReplicaMarkdown({
  text,
  className,
  xstyle,
}: {
  text: string;
  className?: string;
  xstyle?: stylex.StyleXStyles;
}) {
  const blocks = parseBlocks(text);
  const sx = stylex.props(styles.root, xstyle);
  return (
    <div
      className={cn('markdown-renderer', sx.className, className)}
      style={{ ...sx.style, ...MARKDOWN_FONT_SIZE_STYLE }}
    >
      <div {...stylex.props(styles.stream)}>
        {blocks.map((block, blockIndex) =>
          block.type === 'p' ? (
            <p
              key={blockIndex}
              {...stylex.props(
                styles.paragraph,
                blocks[blockIndex + 1]?.type === 'ul' && styles.paragraphBeforeList,
                blockIndex === blocks.length - 1 && styles.lastParagraph
              )}
            >
              {renderInline(block.text, `b${blockIndex}`)}
            </p>
          ) : (
            <ul key={blockIndex} {...stylex.props(styles.list)} data-streamdown="unordered-list">
              {block.items.map((item, itemIndex) => (
                <li
                  key={itemIndex}
                  {...stylex.props(styles.item, itemIndex > 0 && styles.followingItem)}
                  data-streamdown="list-item"
                >
                  {renderInline(item, `b${blockIndex}-${itemIndex}`)}
                </li>
              ))}
            </ul>
          )
        )}
      </div>
    </div>
  );
}
