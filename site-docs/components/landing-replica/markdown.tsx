import type { CSSProperties, ReactNode } from 'react';
import { Copy } from 'lucide-react';
import { FileIcon } from './icons';
import { cn } from './utils';

/* Display-only replica of the app's ai-gui `MarkdownRenderer` (Streamdown) for the
   subset the landing demo copy uses: paragraphs, `- ` bullet lists, `**bold**`,
   `` `code` ``, inline code that is a file path (file chip), bare URLs. Text may be
   a character-level streaming prefix, so unclosed `**` / `` ` `` render like
   Streamdown's `remend` closes them. */

// The app's MARKDOWN_BASE_CLASSNAME, trimmed to the elements this parser emits.
const MARKDOWN_BASE_CLASSNAME =
  'markdown-renderer max-w-none text-foreground leading-[1.75] ' +
  '[&_p]:!mt-0 [&_p]:!mb-3 [&_p:has(+ul)]:!mb-2 [&_p:last-child]:!mb-0 [&_p:first-child]:!mt-0 ' +
  '[&_ul]:!my-2 [&_ul]:pl-3 [&_ul]:list-disc ' +
  '[&_ul:not(.contains-task-list)]:pl-0 [&_ul:not(.contains-task-list)]:list-none ' +
  '[&_ul:not(.contains-task-list)>li]:relative [&_ul:not(.contains-task-list)>li]:pl-6 ' +
  "[&_ul:not(.contains-task-list)>li]:before:absolute [&_ul:not(.contains-task-list)>li]:before:left-[10px] [&_ul:not(.contains-task-list)>li]:before:top-[0.75em] [&_ul:not(.contains-task-list)>li]:before:size-1 [&_ul:not(.contains-task-list)>li]:before:-translate-y-1/2 [&_ul:not(.contains-task-list)>li]:before:rounded-full [&_ul:not(.contains-task-list)>li]:before:bg-current [&_ul:not(.contains-task-list)>li]:before:content-[''] " +
  '[&_li]:!my-0 [&_li]:!py-0 [&_li:not(:first-child)]:!mt-2 [&_ul>li:not(:first-child)]:!mt-1 ' +
  '[&_a]:text-markdown-link ' +
  '[&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-current/35 [&_a:hover]:decoration-current/70';

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
      <a key={`${key}-a${start}`} href={url} target="_blank" rel="noopener noreferrer">
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
    <button
      type="button"
      title={path}
      className={cn(
        'm-0 inline-flex max-w-full items-baseline gap-1 rounded-sm border-0 bg-transparent p-0 align-baseline font-[inherit] leading-[inherit] text-markdown-link no-underline shadow-none transition-colors',
        'hover:underline underline-offset-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
      )}
    >
      {/* The app masks the file icon with `bg-current` (MonochromeFileIcon). */}
      <FileIcon
        path={path}
        className="h-[1.38em] w-[1.38em] shrink-0 self-center [&_path[fill]]:fill-current [&_path[stroke]]:stroke-current"
      />
      <span className="min-w-0 truncate">{path}</span>
      <Copy className="h-[0.85em] w-[0.85em] shrink-0 self-center" />
    </button>
  );
}

function InlineCode({ value }: { value: string }) {
  const path = matchWholeFilePath(value);
  if (path) return <FileChip path={path} />;
  return (
    <code className="rounded-sm bg-foreground/[0.08] px-1 py-px font-mono text-[0.85em] text-foreground ring-0 dark:bg-foreground/[0.14]">
      {value}
    </code>
  );
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
          <span key={`${key}-s${index}`} className="font-semibold" data-streamdown="strong">
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

export function ReplicaMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn(MARKDOWN_BASE_CLASSNAME, className)} style={MARKDOWN_FONT_SIZE_STYLE}>
      {/* Streamdown's root, with the app's `className="space-y-0"` swap. */}
      <div className="space-y-0 whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {parseBlocks(text).map((block, blockIndex) =>
          block.type === 'p' ? (
            <p key={blockIndex}>{renderInline(block.text, `b${blockIndex}`)}</p>
          ) : (
            <ul
              key={blockIndex}
              className="list-inside list-disc whitespace-normal [li_&]:pl-6"
              data-streamdown="unordered-list"
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="py-1 [&>p]:inline" data-streamdown="list-item">
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
