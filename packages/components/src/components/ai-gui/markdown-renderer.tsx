import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  memo,
} from 'react';
import { createMathPlugin } from '@streamdown/math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import {
  Streamdown,
  defaultUrlTransform,
  type CodeHighlighterPlugin,
  type Components,
  type ControlsConfig,
  type HighlightOptions,
  type MermaidOptions,
  type PluginConfig,
  type StreamdownTranslations,
  type ThemeInput,
  type UrlTransform,
} from 'streamdown';
import type { BundledLanguage } from 'shiki';
import { Check, Copy } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { parseTaskImageMarkdownUrl } from '@lody/shared';
import { DEFAULT_CONVERSATION_FONT_SIZE, tasksFeatureEnabledAtom } from '@/atoms/settings';
import { FileIcon } from '@/components/icons/file-icons';
import {
  isMarkdownAgentFileHref,
  parseMarkdownAgentFileHref,
} from '@/lib/markdown-agent-file-link';
import { matchWholeFilePath, splitTextIntoFilePathSegments } from '@/lib/linkify-file-paths';
import {
  normalizeTexMathDelimiters,
  remarkSingleDollarTextMath,
} from '@/lib/markdown-single-dollar-math';
import { cn } from '@/lib/utils';
import { usePrLinkInterceptor } from './pr-link-context';
import {
  SEARCH_HIGHLIGHT_ACTIVE_MARK_CLASS_NAME,
  SEARCH_HIGHLIGHT_MARK_CLASS_NAME,
  useSessionSearch,
  useSessionSearchBlock,
} from '@/components/sessions/session-search-context';
import { findSessionSearchOccurrences } from '@/lib/session-chat-search';
import { useResolvedTheme } from '../../theme-provider';
import type { ConversationFontSize } from '@/atoms/settings';
import { useTaskImageUrl } from '@/hooks/use-task-image';
import { MarkdownDiffBlock } from './markdown-diff-block';
import { createMarkdownMermaidConfig, createMarkdownMermaidPlugin } from './markdown-mermaid';
import { MermaidDiagramViewer, type MermaidDiagramSelection } from './mermaid-diagram-viewer';

export { createMarkdownMermaidConfig } from './markdown-mermaid';

type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
  inline?: boolean;
  className?: string;
  node?: unknown;
};

type MarkdownLinkProps = ComponentPropsWithoutRef<'a'> & {
  node?: unknown;
};

type MarkdownPictureProps = ComponentPropsWithoutRef<'picture'> & {
  node?: unknown;
};

type MarkdownImageProps = ComponentPropsWithoutRef<'img'> & {
  node?: unknown;
};

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  url?: string;
  title?: string | null;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

type MdastChildReplacement = {
  nodes: MdastNode[];
  consumedSiblings?: number;
};

type MdastChildTransformer = (
  child: MdastNode,
  nextChild: MdastNode | undefined
) => MdastChildReplacement | undefined;

const transformMdastChildren = (tree: unknown, transform: MdastChildTransformer) => {
  if (typeof tree !== 'object' || tree === null) return;
  const root = tree as MdastNode;
  if (typeof root.type !== 'string') return;

  const walk = (node: MdastNode) => {
    if (node.type === 'link' || node.type === 'linkReference' || node.type === 'code') return;

    const children = node.children;
    if (!Array.isArray(children) || children.length === 0) return;

    const nextChildren: MdastNode[] = [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const replacement = transform(child, children[index + 1]);
      if (replacement) {
        nextChildren.push(...replacement.nodes);
        index += replacement.consumedSiblings ?? 0;
        continue;
      }

      walk(child);
      nextChildren.push(child);
    }

    node.children = nextChildren;
  };

  walk(root);
};

// `!` prefixes are load-bearing: Streamdown wraps its output in a div with
// `space-y-4` (which our `className="space-y-0"` swap below replaces). Either
// way that compiles to `.space-y-N > :not([hidden]) ~ :not([hidden])` which
// has specificity (0,5,0) per Chromium DevTools and wins against plain
// `[&_h1]:mt-5` arbitrary variants — zeroing margin-top AND margin-bottom on
// every block. `!` flips on `!important` so per-element margins survive.
const MARKDOWN_BASE_CLASSNAME =
  'markdown-renderer max-w-none text-foreground leading-[1.75] ' +
  '[&_p]:!mt-0 [&_p]:!mb-3 [&_p:has(+ul)]:!mb-2 [&_p:last-child]:!mb-0 [&_p:first-child]:!mt-0 ' +
  '[&_ul]:!my-2 [&_ul]:pl-3 [&_ul]:list-disc ' +
  '[&_ul:not(.contains-task-list)]:pl-0 [&_ul:not(.contains-task-list)]:list-none ' +
  '[&_ul:not(.contains-task-list)>li]:relative [&_ul:not(.contains-task-list)>li]:pl-6 ' +
  "[&_ul:not(.contains-task-list)>li]:before:absolute [&_ul:not(.contains-task-list)>li]:before:left-[10px] [&_ul:not(.contains-task-list)>li]:before:top-[0.75em] [&_ul:not(.contains-task-list)>li]:before:size-1 [&_ul:not(.contains-task-list)>li]:before:-translate-y-1/2 [&_ul:not(.contains-task-list)>li]:before:rounded-full [&_ul:not(.contains-task-list)>li]:before:bg-current [&_ul:not(.contains-task-list)>li]:before:content-[''] " +
  // Ordered lists mirror the unordered custom-marker layout above so both list
  // types share the same text indent and marker lane. `counter(list-item)` is
  // the UA built-in: `display: list-item` keeps incrementing it under
  // `list-none`, and it honors <ol start> / <li value> (mdast emits `start`).
  '[&_ol]:!my-2 [&_ol]:pl-0 [&_ol]:list-none ' +
  '[&_ol>li]:relative [&_ol>li]:pl-6 ' +
  // Keep the counter and period on one line even when the conversation uses a
  // wide font. The 18px marker lane is intentionally narrower than some
  // glyph pairs; wrapping here drops the period beside the following item.
  "[&_ol>li]:before:absolute [&_ol>li]:before:left-0 [&_ol>li]:before:w-[18px] [&_ol>li]:before:whitespace-nowrap [&_ol>li]:before:text-right [&_ol>li]:before:content-[counter(list-item)'.'] " +
  // Streamdown sets `[&>p]:inline` on every <li>, collapsing loose lists into
  // single inline runs — so between-item spacing must come from the <li> box
  // itself, not the inner <p>. `mt-2` on non-first items keeps list edges
  // flush with the `ul`/`ol` margins.
  '[&_li]:!my-0 [&_li]:!py-0 [&_li:not(:first-child)]:!mt-2 [&_ul>li:not(:first-child)]:!mt-1 [&_ol>li:not(:first-child)]:!mt-1 [&_li>ul]:!my-1 [&_li>ol]:!my-1 ' +
  // Streamdown's default blockquote class adds `italic`; override it so quoted
  // body text stays upright (explicit `*emphasis*` inside still renders italic
  // via the descendant <em>'s own font-style). The `[&_blockquote]` descendant
  // selector outranks Streamdown's plain `.italic` utility, so no `!` is needed.
  '[&_blockquote]:!my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:not-italic [&_blockquote]:text-muted-foreground ' +
  '[&_hr]:!my-4 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-border ' +
  '[&_h1]:!mt-6 [&_h1]:!mb-2 [&_h1]:font-semibold [&_h1]:tracking-tight ' +
  '[&_h2]:!mt-5 [&_h2]:!mb-2 [&_h2]:font-semibold [&_h2]:tracking-tight ' +
  '[&_h3]:!mt-4 [&_h3]:!mb-2 [&_h3]:font-semibold ' +
  '[&_h4]:!mt-4 [&_h4]:!mb-1.5 [&_h4]:font-semibold ' +
  '[&_h5]:!mt-3 [&_h5]:!mb-1.5 [&_h5]:font-semibold [&_h5]:uppercase [&_h5]:tracking-wide ' +
  '[&_h6]:!mt-3 [&_h6]:!mb-1.5 [&_h6]:font-semibold [&_h6]:uppercase [&_h6]:tracking-wide [&_h6]:text-muted-foreground ' +
  '[&_:is(h1,h2,h3,h4,h5,h6):first-child]:!mt-0 ' +
  '[&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-muted-foreground/40 [&_a:hover]:decoration-muted-foreground ' +
  '[&_.katex-display]:!my-5 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1 ' +
  '[&_[data-streamdown="mermaid-block"]]:!my-5 ' +
  '[&_[data-streamdown="code-block"]]:!my-4 ' +
  '[&_table]:!my-0 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[0.92em] [&_table]:leading-[1.5] ' +
  '[&_th]:border-b [&_th]:border-border/70 [&_th]:bg-muted/45 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-foreground/80 ' +
  '[&_td]:border-b [&_td]:border-border/45 [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top ' +
  '[&_tbody_tr:nth-child(even)]:bg-muted/15 [&_tbody_tr:last-child_td]:border-b-0 ' +
  '[&_:is(th,td):first-child]:w-px [&_:is(th,td):first-child]:whitespace-nowrap ' +
  '[&_tbody_td:first-child]:font-medium [&_tbody_td:first-child]:text-foreground/75 ' +
  '[&_table_code]:!bg-muted/55 [&_table_code]:!ring-0';

const MARKDOWN_SIZE_CLASSNAME =
  '[&_h1]:text-[length:var(--markdown-h1-font-size)] ' +
  '[&_h2]:text-[length:var(--markdown-h2-font-size)] ' +
  '[&_h3]:text-[length:var(--markdown-body-font-size)] ' +
  '[&_h4]:text-[length:var(--markdown-body-font-size)] ' +
  '[&_h5]:text-[length:var(--markdown-small-heading-font-size)] ' +
  '[&_h6]:text-[length:var(--markdown-small-heading-font-size)]';

type MarkdownFontSizeStyle = CSSProperties & {
  '--markdown-body-font-size': string;
  '--markdown-h1-font-size': string;
  '--markdown-h2-font-size': string;
  '--markdown-small-heading-font-size': string;
};

function markdownFontSizeStyle(fontSize: ConversationFontSize): MarkdownFontSizeStyle {
  return {
    fontSize: `${fontSize}px`,
    '--markdown-body-font-size': `${fontSize}px`,
    '--markdown-h1-font-size': `${fontSize + 4}px`,
    '--markdown-h2-font-size': `${fontSize + 2}px`,
    '--markdown-small-heading-font-size': `${Math.max(1, fontSize - 2)}px`,
  };
}

const ensureLinkRel = (rel?: string) => {
  const parts = new Set((rel ?? '').split(/\s+/).filter(Boolean));
  parts.add('noopener');
  parts.add('noreferrer');
  return Array.from(parts).join(' ');
};

type MarkdownExternalLinkProps = ComponentPropsWithoutRef<'a'> & {
  href?: string;
};

/**
 * Renders an `<a>` for markdown output, with an escape hatch: if the href
 * matches the currently-active session's Pull Request URL, clicking the link
 * opens the in-app PR tab instead of navigating away. Falls back to the
 * default new-tab external link when no interceptor matches.
 */
function MarkdownExternalLink({
  href,
  rel,
  children,
  onClick,
  ...rest
}: MarkdownExternalLinkProps) {
  const prHandler = usePrLinkInterceptor(href);
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (!prHandler) return;
      // Respect modifier-click / non-primary clicks — let the browser do its thing.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.button !== 0) return;
      event.preventDefault();
      prHandler();
    },
    [onClick, prHandler]
  );
  return (
    <a {...rest} href={href} target="_blank" rel={ensureLinkRel(rel)} onClick={handleClick}>
      {children}
    </a>
  );
}

const AUTOLINK_PATTERN = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/giu;

// Both autolinkers end a bare URL at whitespace, but CJK prose is written
// without one, so `见 https://example.com/a。然后` swallows the rest of the
// sentence into the destination. Non-ASCII punctuation and separators
// (，。、）「」…　) never appear unencoded in a URL, so end the URL there.
// Non-ASCII letters still may (`/wiki/中文`), and symbols are left alone
// because they are not Markdown punctuation for strong-closer purposes.
const NON_ASCII_URL_BOUNDARY = /(?!\p{ASCII})[\p{P}\p{Z}]/u;

const countChar = (value: string, char: string) =>
  Array.from(value).reduce((count, current) => count + (current === char ? 1 : 0), 0);

const splitAutolinkTrailing = (value: string) => {
  const boundary = value.search(NON_ASCII_URL_BOUNDARY);
  let url = boundary >= 0 ? value.slice(0, boundary) : value;
  let trailing = boundary >= 0 ? value.slice(boundary) : '';

  while (url.length > 0) {
    const last = url[url.length - 1];
    if (!last) break;

    if (last === ')' && countChar(url, ')') <= countChar(url, '(')) break;
    if (last === ']' && countChar(url, ']') <= countChar(url, '[')) break;
    if (last === '}' && countChar(url, '}') <= countChar(url, '{')) break;

    if (!/[\]})"'.,:;!?]/u.test(last)) break;

    trailing = `${last}${trailing}`;
    url = url.slice(0, -1);
  }

  return { url, trailing };
};

const createTextLinkNode = (url: string, text: string, title: string | null = null): MdastNode => ({
  type: 'link',
  url,
  title,
  children: [{ type: 'text', value: text }],
});

const linkifyTextValue = (value: string): MdastNode[] => {
  const result: MdastNode[] = [];
  AUTOLINK_PATTERN.lastIndex = 0;

  let cursor = 0;
  let match = AUTOLINK_PATTERN.exec(value);
  if (!match) {
    return [{ type: 'text', value }];
  }

  while (match) {
    const rawUrl = match[0];
    const matchStart = match.index;
    const matchEnd = matchStart + rawUrl.length;

    if (matchStart > cursor) {
      result.push({ type: 'text', value: value.slice(cursor, matchStart) });
    }

    const { url, trailing } = splitAutolinkTrailing(rawUrl);
    if (url.length === 0) {
      result.push({ type: 'text', value: rawUrl });
    } else {
      const href = url.startsWith('www.') ? `https://${url}` : url;
      result.push(createTextLinkNode(href, url));

      if (trailing.length > 0) {
        result.push({ type: 'text', value: trailing });
      }
    }

    cursor = matchEnd;
    match = AUTOLINK_PATTERN.exec(value);
  }

  if (cursor < value.length) {
    result.push({ type: 'text', value: value.slice(cursor) });
  }

  return result;
};

type MarkdownParser = {
  parse: (value: string) => MdastNode;
};

type MarkdownFile = {
  toString: () => string;
};

const isExactDoubleAsterisk = (value: string, offset: number) =>
  offset >= 0 &&
  value.slice(offset, offset + 2) === '**' &&
  value[offset - 1] !== '*' &&
  value[offset + 2] !== '*';

const isUnescapedDoubleAsterisk = (source: string, offset: number) => {
  if (!isExactDoubleAsterisk(source, offset)) return false;

  let precedingBackslashes = 0;
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 0;
};

const isMarkdownPunctuation = (value: string) =>
  /[!-/:-@[-`{-~]/u.test(value) || /\p{P}/u.test(value);

const isValidStrongCloser = (value: string, offset: number) => {
  if (!isExactDoubleAsterisk(value, offset)) return false;

  const precedingCharacter = value[offset - 1];
  const followingCodePoint = value.codePointAt(offset + 2);
  const followingCharacter =
    followingCodePoint === undefined ? undefined : String.fromCodePoint(followingCodePoint);
  if (!precedingCharacter || /\s/u.test(precedingCharacter)) return false;

  return (
    followingCharacter === undefined ||
    /\s/u.test(followingCharacter) ||
    isMarkdownPunctuation(followingCharacter)
  );
};

const findValidStrongCloser = (value: string, start = 0, end = value.length) => {
  for (let offset = start; offset + 1 < end; offset += 1) {
    if (isValidStrongCloser(value, offset)) return offset;
  }
  return -1;
};

const hasUnescapedValidCloser = (source: string, start: number, end: number) => {
  for (let offset = start; offset + 1 < end; offset += 1) {
    if (isUnescapedDoubleAsterisk(source, offset) && isValidStrongCloser(source, offset)) {
      return true;
    }
  }
  return false;
};

const isLiteralGfmAutolink = (source: string, link: MdastNode, linkText: MdastNode) => {
  const linkStartOffset = link.position?.start?.offset;
  const linkTextStartOffset = linkText.position?.start?.offset;
  return (
    typeof linkStartOffset === 'number' &&
    typeof linkTextStartOffset === 'number' &&
    linkStartOffset === linkTextStartOffset &&
    source[linkStartOffset] !== '['
  );
};

// The destination is the normalized form of the link text, so a tail cut from
// the text may appear percent-encoded in the destination. Refuse the repair
// when neither form matches rather than guess at a truncation point.
const truncateAutolinkUrl = (url: string, tail: string) => {
  if (url.endsWith(tail)) return url.slice(0, -tail.length);

  const encodedTail = encodeURI(tail);
  if (encodedTail !== tail && url.endsWith(encodedTail)) {
    return url.slice(0, -encodedTail.length);
  }

  return undefined;
};

// GFM can consume a closing strong delimiter and the following inline markup
// into an autolink. Repair that AST shape after GFM by truncating the already
// normalized destination, while keeping ordinary URL and email autolinks.
const remarkRepairMalformedGfmAutolinks = function (this: MarkdownParser) {
  const parse = this.parse.bind(this);

  const parseInlineSuffix = (value: string): MdastNode[] => {
    if (!value) return [];

    const parsed = parse(value);
    const [first] = parsed.children ?? [];
    if (parsed.children?.length === 1 && first?.type === 'paragraph' && first.children) {
      return first.children;
    }

    return [{ type: 'text', value }];
  };

  const splitMalformedAutolink = (link: MdastNode, source: string) => {
    if (link.type !== 'link' || typeof link.url !== 'string') return undefined;

    const linkText = link.children?.[0];
    if (linkText?.type !== 'text' || typeof linkText.value !== 'string') return undefined;
    if (!isLiteralGfmAutolink(source, link, linkText)) return undefined;

    const textCloser = findValidStrongCloser(linkText.value);
    const urlCloser = findValidStrongCloser(link.url);
    if (textCloser <= 0 || urlCloser <= 0) return undefined;

    const linkStart = link.position?.start?.offset;
    const linkEnd = link.position?.end?.offset;
    if (
      typeof linkStart !== 'number' ||
      typeof linkEnd !== 'number' ||
      !hasUnescapedValidCloser(source, linkStart, linkEnd)
    ) {
      return undefined;
    }

    const url = linkText.value.slice(0, textCloser);
    if (!/^(?:https?:\/\/|www\.)/iu.test(url)) return undefined;

    const suffix = linkText.value.slice(textCloser + 2);
    const suffixNodes = suffix ? parseInlineSuffix(suffix) : [];

    return {
      href: link.url.slice(0, urlCloser),
      url,
      suffixNodes,
    };
  };

  const wrapRepairedAutolink = (
    link: MdastNode,
    split: { href: string; url: string }
  ): MdastNode => ({
    type: 'strong' as const,
    children: [createTextLinkNode(split.href, split.url, link.title ?? null)],
  });

  const tryRepairMalformedBoldAutolink = (
    child: MdastNode,
    nextChild: MdastNode | undefined,
    source: string
  ): MdastChildReplacement | undefined => {
    if (child.type === 'strong' && child.children?.length === 1) {
      const strongStart = child.position?.start?.offset;
      if (!isUnescapedDoubleAsterisk(source, typeof strongStart === 'number' ? strongStart : -1)) {
        return undefined;
      }

      const split = splitMalformedAutolink(child.children[0], source);
      if (!split) return undefined;
      return {
        nodes: [wrapRepairedAutolink(child.children[0], split), ...split.suffixNodes],
      };
    }

    if (child.type !== 'text' || typeof child.value !== 'string' || !child.value.endsWith('**')) {
      return undefined;
    }
    if (!nextChild) return undefined;

    const precedingEndOffset = child.position?.end?.offset;
    if (
      !isUnescapedDoubleAsterisk(
        source,
        typeof precedingEndOffset === 'number' ? precedingEndOffset - 2 : -1
      )
    ) {
      return undefined;
    }

    const split = splitMalformedAutolink(nextChild, source);
    if (!split) return undefined;

    const repaired: MdastNode[] = [];
    const textBeforeStrong = child.value.slice(0, -2);
    if (textBeforeStrong) {
      repaired.push({ ...child, value: textBeforeStrong });
    }
    repaired.push(wrapRepairedAutolink(nextChild, split), ...split.suffixNodes);
    return { nodes: repaired, consumedSiblings: 1 };
  };

  // Runs before the bold repair. Every boundary character is Markdown
  // punctuation or whitespace, so a `**` that becomes text-final here was
  // already a valid strong closer in the source.
  const trimNonAsciiAutolinkTail = (
    child: MdastNode,
    source: string
  ): MdastChildReplacement | undefined => {
    if (child.type !== 'link' || typeof child.url !== 'string') return undefined;
    if (child.children?.length !== 1) return undefined;

    const linkText = child.children[0];
    if (linkText?.type !== 'text' || typeof linkText.value !== 'string') return undefined;
    if (!isLiteralGfmAutolink(source, child, linkText)) return undefined;

    const boundary = linkText.value.search(NON_ASCII_URL_BOUNDARY);
    if (boundary <= 0) return undefined;

    const tail = linkText.value.slice(boundary);
    const url = truncateAutolinkUrl(child.url, tail);
    if (url === undefined) return undefined;

    return {
      nodes: [
        // Positions stay on the original source span so the bold repair can
        // still tell this apart from an explicit `[text](url)` link.
        { ...child, url, children: [{ ...linkText, value: linkText.value.slice(0, boundary) }] },
        ...parseInlineSuffix(tail),
      ],
    };
  };

  return (tree: unknown, file: MarkdownFile) => {
    const source = file.toString();
    transformMdastChildren(tree, (child) => trimNonAsciiAutolinkTail(child, source));
    transformMdastChildren(tree, (child, nextChild) =>
      tryRepairMalformedBoldAutolink(child, nextChild, source)
    );
  };
};

const remarkLinkifyPlainUrls = () => {
  return (tree: unknown) => {
    transformMdastChildren(tree, (child) => {
      if (child.type === 'text' && typeof child.value === 'string') {
        return { nodes: linkifyTextValue(child.value) };
      }

      if (child.type === 'inlineCode' && typeof child.value === 'string') {
        const value = child.value;
        AUTOLINK_PATTERN.lastIndex = 0;
        if (AUTOLINK_PATTERN.test(value)) {
          const linkified = linkifyTextValue(value);
          const wrappedChildren: MdastNode[] = linkified.map((n) => {
            if (n.type === 'link') {
              return {
                ...n,
                children: [{ type: 'inlineCode', value: (n.children?.[0] as MdastNode)?.value }],
              };
            }
            return { type: 'inlineCode', value: n.value };
          });
          return { nodes: wrappedChildren };
        }
      }

      return undefined;
    });
  };
};

// Auto-link bare file paths (text + whole-content inline code) into the same
// `link` nodes that explicit markdown file links use, so they flow through the
// `a` -> AgentFileLink renderer. Runs AFTER URL linkify so URLs are already
// `link` nodes (which this walk skips) and can't be re-grabbed as paths.
const remarkLinkifyFilePaths = () => {
  return (tree: unknown) => {
    transformMdastChildren(tree, (child) => {
      if (child.type === 'text' && typeof child.value === 'string') {
        const segments = splitTextIntoFilePathSegments(child.value);
        if (segments.length === 1 && segments[0]?.type === 'text') return undefined;

        return {
          nodes: segments.map((segment) =>
            segment.type === 'path'
              ? createTextLinkNode(segment.value, segment.value)
              : { type: 'text', value: segment.value }
          ),
        };
      }

      if (child.type === 'inlineCode' && typeof child.value === 'string') {
        const path = matchWholeFilePath(child.value);
        return path ? { nodes: [createTextLinkNode(path, path)] } : undefined;
      }

      return undefined;
    });
  };
};

const MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkRepairMalformedGfmAutolinks,
  remarkLinkifyPlainUrls,
  remarkLinkifyFilePaths,
  remarkSingleDollarTextMath,
];

const MARKDOWN_MATH_PLUGIN = createMathPlugin();

type ShikiHighlighter = Awaited<ReturnType<(typeof import('shiki/core'))['createHighlighterCore']>>;
type MarkdownHighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>;

const MARKDOWN_CODE_THEME_NAME = 'lody-css-variables';
// Streamdown's type does not model registered custom theme names, but Shiki accepts
// them after createHighlighterCore() registers the matching theme object.
const MARKDOWN_CODE_THEME_INPUT = MARKDOWN_CODE_THEME_NAME as unknown as ThemeInput;
const MARKDOWN_CODE_THEMES = [MARKDOWN_CODE_THEME_INPUT, MARKDOWN_CODE_THEME_INPUT] as const;

const MARKDOWN_CODE_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'bash',
  'shellscript',
  'markdown',
  'python',
  'rust',
  'go',
  'yaml',
  'html',
  'css',
] as const satisfies readonly BundledLanguage[];

const MARKDOWN_CODE_LANGUAGE_ALIASES: Partial<Record<string, BundledLanguage>> = {
  js: 'javascript',
  ts: 'typescript',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  sh: 'shellscript',
  shell: 'shellscript',
  yml: 'yaml',
};

const MARKDOWN_CODE_LANGUAGE_SET = new Set<string>([
  ...MARKDOWN_CODE_LANGUAGES,
  ...Object.keys(MARKDOWN_CODE_LANGUAGE_ALIASES),
]);

const normalizeCodeLanguage = (language: BundledLanguage): BundledLanguage | null => {
  const normalized = String(language).trim().toLowerCase();
  if (!normalized) return null;

  const alias = MARKDOWN_CODE_LANGUAGE_ALIASES[normalized];
  if (alias) return alias;

  return MARKDOWN_CODE_LANGUAGE_SET.has(normalized) ? (normalized as BundledLanguage) : null;
};

const createPlainHighlightResult = (code: string): MarkdownHighlightResult => ({
  bg: 'transparent',
  fg: 'inherit',
  tokens: code.split('\n').map((line) => [
    {
      color: 'inherit',
      content: line,
    },
  ]),
});

// Tokenizing is pure over (language, code): the registered theme is Shiki's
// CSS-variables theme, so the tokens carry `var(--shiki-*)` colors and do not
// change with the app theme. Re-rendering a conversation therefore re-derived
// identical tokens — a measurable cost on session switch, where every code
// block in the newly mounted transcript is highlighted from scratch.
//
// Bounded twice over: by entry count and by total cached source length, because
// a streaming turn feeds a new prefix of the same block on every chunk and
// would otherwise fill the cache with strings nobody reads again. Insertion
// order gives LRU: a hit is re-inserted at the end, eviction takes the front.
const HIGHLIGHT_CACHE_MAX_ENTRIES = 256;
const HIGHLIGHT_CACHE_MAX_TOTAL_CHARS = 1_000_000;
/** Skip blocks large enough that caching them costs more than re-tokenizing. */
const HIGHLIGHT_CACHE_MAX_CODE_CHARS = 20_000;

const highlightCache = new Map<string, MarkdownHighlightResult>();
let highlightCacheChars = 0;

const readHighlightCache = (key: string): MarkdownHighlightResult | undefined => {
  const cached = highlightCache.get(key);
  if (cached === undefined) return undefined;
  highlightCache.delete(key);
  highlightCache.set(key, cached);
  return cached;
};

const writeHighlightCache = (
  key: string,
  codeLength: number,
  result: MarkdownHighlightResult
): void => {
  highlightCache.set(key, result);
  highlightCacheChars += codeLength;
  while (
    highlightCache.size > HIGHLIGHT_CACHE_MAX_ENTRIES ||
    highlightCacheChars > HIGHLIGHT_CACHE_MAX_TOTAL_CHARS
  ) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey === undefined) break;
    highlightCache.delete(oldestKey);
    // The key is `${language}\0${code}`, so its length bounds the code length
    // it contributed; close enough to keep the budget from drifting upward.
    highlightCacheChars = Math.max(0, highlightCacheChars - oldestKey.length);
  }
};

const highlightCode = (
  highlighter: ShikiHighlighter,
  options: HighlightOptions
): MarkdownHighlightResult => {
  const language = normalizeCodeLanguage(options.language);
  if (!language) {
    return createPlainHighlightResult(options.code);
  }

  const cacheable = options.code.length <= HIGHLIGHT_CACHE_MAX_CODE_CHARS;
  const cacheKey = `${language}\0${options.code}`;
  if (cacheable) {
    const cached = readHighlightCache(cacheKey);
    if (cached !== undefined) return cached;
  }

  try {
    const result = highlighter.codeToTokens(options.code, {
      lang: language,
      themes: {
        light: MARKDOWN_CODE_THEMES[0],
        dark: MARKDOWN_CODE_THEMES[1],
      },
    });
    if (cacheable) {
      writeHighlightCache(cacheKey, options.code.length, result);
    }
    return result;
  } catch {
    return createPlainHighlightResult(options.code);
  }
};

const createLazyShikiCodePlugin = (): CodeHighlighterPlugin => {
  let highlighter: ShikiHighlighter | null = null;
  let highlighterPromise: Promise<ShikiHighlighter> | null = null;

  const loadHighlighter = async () => {
    // @pierre/diffs already imports shiki's bundledLanguages catalog. Reuse it
    // instead of a second shiki/langs/*.mjs graph (duplicate grammar chunks).
    highlighterPromise ??= Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki'),
    ]).then(
      ([
        { createCssVariablesTheme, createHighlighterCore },
        { createJavaScriptRegexEngine },
        shiki,
      ]) =>
        createHighlighterCore({
          engine: createJavaScriptRegexEngine(),
          langs: MARKDOWN_CODE_LANGUAGES.map((id) => {
            const language = shiki.bundledLanguages[id];
            if (!language) {
              throw new Error(`Missing bundled shiki language: ${id}`);
            }
            return language;
          }),
          themes: [
            createCssVariablesTheme({
              name: MARKDOWN_CODE_THEME_NAME,
              variablePrefix: '--lody-shiki-',
            }),
          ],
        }).then((loadedHighlighter) => {
          highlighter = loadedHighlighter;
          return loadedHighlighter;
        })
    );

    return highlighterPromise;
  };

  return {
    name: 'shiki',
    type: 'code-highlighter',
    getSupportedLanguages: () => [...MARKDOWN_CODE_LANGUAGES],
    getThemes: () => [...MARKDOWN_CODE_THEMES],
    highlight: (options, callback) => {
      if (highlighter) {
        return highlightCode(highlighter, options);
      }

      void loadHighlighter()
        .then((loadedHighlighter) => {
          callback?.(highlightCode(loadedHighlighter, options));
        })
        .catch(() => {
          callback?.(createPlainHighlightResult(options.code));
        });

      return null;
    },
    supportsLanguage: (language) => normalizeCodeLanguage(language) !== null,
  };
};

const MARKDOWN_CODE_PLUGIN = createLazyShikiCodePlugin();

const MARKDOWN_MERMAID_PLUGIN = createMarkdownMermaidPlugin();

const STREAMDOWN_PLUGINS = {
  code: MARKDOWN_CODE_PLUGIN,
  math: MARKDOWN_MATH_PLUGIN,
  mermaid: MARKDOWN_MERMAID_PLUGIN,
  renderers: [
    {
      language: 'diff',
      component: MarkdownDiffBlock,
    },
  ],
} satisfies PluginConfig;

const STREAMDOWN_CONTROLS = {
  code: {
    copy: true,
    download: false,
  },
  mermaid: {
    copy: true,
    download: true,
    // Streamdown's own full-screen overlay is off because its only exit is a
    // 32px button at a raw `top-4 right-4`, which on a phone sits inside the
    // status-bar inset while its content layer swallows every backdrop tap —
    // an overlay a touch user cannot leave. `MermaidDiagramViewer` replaces it.
    fullscreen: false,
    panZoom: false,
  },
  table: false,
} satisfies ControlsConfig;

/** Streamdown's wrapper around one rendered diagram, inside a `mermaid-block`. */
const MERMAID_DIAGRAM_SELECTOR = '[data-streamdown="mermaid"]';

/** Matches a fenced ```mermaid block, so blocks without one skip the observer. */
const MERMAID_FENCE_PATTERN = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*mermaid\b/mu;

const writeTextToClipboard = async (text: string): Promise<boolean> => {
  if (!text.trim()) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.top = '0';
      el.style.left = '0';
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
};

const markdownUrlTransform: UrlTransform = (value, key, node) =>
  isMarkdownAgentFileHref(value) || (key === 'src' && parseTaskImageMarkdownUrl(value))
    ? value
    : defaultUrlTransform(value, key, node);

type MarkdownTableProps = ComponentPropsWithoutRef<'table'> & {
  node?: unknown;
};

const AgentFileLink = ({
  href,
  children,
  onFilePathClick,
  copyAgentFileLabel,
  openAgentFileLabel,
}: {
  href: string;
  children: ReactNode;
  onFilePathClick?: (href: string) => void;
  copyAgentFileLabel: string;
  openAgentFileLabel: string;
}) => {
  const [didCopy, setDidCopy] = useState(false);
  const hasOpenAction = Boolean(onFilePathClick);
  const iconPath = parseMarkdownAgentFileHref(href)?.filePath ?? href;

  const handleClick = useCallback(async () => {
    if (onFilePathClick) {
      onFilePathClick(href);
      return;
    }

    const ok = await writeTextToClipboard(href);
    if (!ok) return;

    setDidCopy(true);
    window.setTimeout(() => setDidCopy(false), 1200);
  }, [href, onFilePathClick]);

  return (
    <button
      type="button"
      onClick={() => {
        void handleClick();
      }}
      title={href}
      aria-label={`${hasOpenAction ? openAgentFileLabel : copyAgentFileLabel}: ${href}`}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-px align-[-0.15em] font-mono text-[0.92em] leading-tight text-foreground no-underline shadow-none transition-colors',
        'hover:border-border hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
      )}
    >
      <FileIcon filePath={iconPath} className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
      {!hasOpenAction ? (
        didCopy ? (
          <Check className="h-3 w-3 shrink-0 text-emerald-600" />
        ) : (
          <Copy className="h-3 w-3 shrink-0 text-muted-foreground" />
        )
      ) : null}
    </button>
  );
};

const createMarkdownComponents = ({
  copyAgentFileLabel,
  openAgentFileLabel,
  onAgentFileLinkClick,
}: {
  copyAgentFileLabel: string;
  openAgentFileLabel: string;
  onAgentFileLinkClick?: (href: string) => void;
}): Components => ({
  inlineCode: (props: MarkdownCodeProps) => {
    const { className, children, style: _style, node: _node, inline: _inline, ...rest } = props;
    return (
      <code
        className={cn(
          'rounded-sm bg-code px-1 py-px font-mono text-[0.85em] text-code-foreground ring-1 ring-inset ring-border/50',
          className
        )}
        {...rest}
      >
        {children}
      </code>
    );
  },
  table: (props: MarkdownTableProps) => {
    const { node: _node, ...rest } = props;
    return (
      <div
        data-markdown-table
        className="scrollbar-pro my-3 overflow-x-auto rounded-lg border border-border/70 bg-background"
      >
        <table {...rest} />
      </div>
    );
  },
  a: (props: MarkdownLinkProps) => {
    const { children, href, node: _node, rel, ...rest } = props;

    if (isMarkdownAgentFileHref(href)) {
      return (
        <AgentFileLink
          href={href}
          onFilePathClick={onAgentFileLinkClick}
          copyAgentFileLabel={copyAgentFileLabel}
          openAgentFileLabel={openAgentFileLabel}
        >
          {children}
        </AgentFileLink>
      );
    }

    return (
      <MarkdownExternalLink href={href} rel={rel} {...rest}>
        {children}
      </MarkdownExternalLink>
    );
  },
  img: TaskMarkdownImage,
  // <picture> just passes through its children (the <img> fallback);
  // <source> is suppressed since it's only meaningful inside a real browser <picture>.
  source: () => null,
  picture: (props: MarkdownPictureProps) => <>{props.children}</>,
});

function TaskMarkdownImage(props: MarkdownImageProps) {
  const { node: _node, src, alt, ...rest } = props;
  const taskImageId = src ? parseTaskImageMarkdownUrl(src) : null;
  const tasksEnabled = useAtomValue(tasksFeatureEnabledAtom);
  const resolvedUrl = useTaskImageUrl(taskImageId && tasksEnabled ? src : undefined);

  if (taskImageId && !tasksEnabled) return null;

  if (taskImageId && !resolvedUrl) {
    return (
      <span
        role="img"
        aria-label={alt || 'Task image'}
        className="my-2 block h-24 w-full max-w-sm animate-pulse rounded-md bg-muted"
      />
    );
  }

  return (
    <img
      {...rest}
      src={taskImageId ? resolvedUrl : src}
      alt={alt ?? ''}
      className={cn('my-2 max-h-[32rem] max-w-full rounded-md object-contain', rest.className)}
    />
  );
}

export type MarkdownRendererSize =
  | ConversationFontSize
  | 'small'
  | 'default'
  | 'large'
  | 'sm'
  | 'base';

function normalizeMarkdownRendererSize(size: MarkdownRendererSize): ConversationFontSize {
  if (size === 'small') return 12;
  if (size === 'default' || size === 'sm') return DEFAULT_CONVERSATION_FONT_SIZE;
  if (size === 'large' || size === 'base') return 16;
  return size;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  size = DEFAULT_CONVERSATION_FONT_SIZE,
  className,
  allowHtml = false,
  isStreaming = false,
  onAgentFileLinkClick,
  searchBlockId,
}: {
  text: string;
  size?: MarkdownRendererSize;
  className?: string;
  /** Enable raw HTML rendering (sanitized). Use for GitHub comment bodies. */
  allowHtml?: boolean;
  /** Enables Streamdown's incremental animation while a turn is still streaming. */
  isStreaming?: boolean;
  onAgentFileLinkClick?: (href: string) => void;
  searchBlockId?: string;
}) {
  const { t } = useTranslation();
  const resolvedTheme = useResolvedTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const search = useSessionSearch();
  const searchMatch = useSessionSearchBlock(searchBlockId ?? '');
  const copyCodeLabel = t('common.copyCode', 'Copy code');
  const copyAgentFileLabel = t('sessions.copyAgentFilePath', 'Copy agent file path');
  const openAgentFileLabel = t('sessions.openAgentFile', 'Open agent file');
  const openDiagramLabel = t('sessions.diagramViewer.open', 'Open diagram');
  const [diagramSelection, setDiagramSelection] = useState<MermaidDiagramSelection | null>(null);
  const hasMermaidBlock = useMemo(() => MERMAID_FENCE_PATTERN.test(text), [text]);
  const normalizedText = useMemo(() => normalizeTexMathDelimiters(text), [text]);

  const closeDiagram = useCallback(() => setDiagramSelection(null), []);

  const openDiagram = useCallback((diagram: Element) => {
    const svg = diagram.querySelector('svg');
    if (!svg) {
      return;
    }
    // The rendered size of the copy in the message is the diagram's natural
    // size, and the viewer's opening zoom is expressed against it.
    const rect = svg.getBoundingClientRect();
    setDiagramSelection({
      svg: svg.cloneNode(true) as SVGSVGElement,
      naturalWidth: rect.width,
      naturalHeight: rect.height,
    });
  }, []);

  const handleMarkdownClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const diagram = event.target.closest(MERMAID_DIAGRAM_SELECTOR);
      if (!diagram) {
        return;
      }
      // Releasing a text selection over a diagram label is not a request to
      // open it.
      if (window.getSelection()?.toString()) {
        return;
      }
      openDiagram(diagram);
    },
    [openDiagram]
  );

  const handleMarkdownKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      if (!(event.target instanceof Element)) {
        return;
      }
      const diagram = event.target.closest(MERMAID_DIAGRAM_SELECTOR);
      if (!diagram) {
        return;
      }
      event.preventDefault();
      openDiagram(diagram);
    },
    [openDiagram]
  );

  // Streamdown owns the diagram markup, so the affordance that replaces its
  // removed full-screen button is applied to that markup here. A diagram
  // appears only after the lazily imported Mermaid runtime resolves — long
  // after this component commits — so a one-shot pass would miss it; the
  // observer is installed only for text that actually fences a diagram.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) {
      return undefined;
    }

    const markedDiagrams = new Map<
      HTMLElement,
      { role: string | null; tabIndex: string | null; ariaLabel: string | null }
    >();
    const clearMarkedDiagrams = () => {
      for (const [diagram, attributes] of markedDiagrams) {
        if (attributes.role == null) {
          diagram.removeAttribute('role');
        } else {
          diagram.setAttribute('role', attributes.role);
        }
        if (attributes.tabIndex == null) {
          diagram.removeAttribute('tabindex');
        } else {
          diagram.setAttribute('tabindex', attributes.tabIndex);
        }
        if (attributes.ariaLabel == null) {
          diagram.removeAttribute('aria-label');
        } else {
          diagram.setAttribute('aria-label', attributes.ariaLabel);
        }
      }
      markedDiagrams.clear();
    };
    if (!hasMermaidBlock) {
      clearMarkedDiagrams();
      return undefined;
    }

    const markDiagramsOpenable = () => {
      clearMarkedDiagrams();
      root.querySelectorAll<HTMLElement>(MERMAID_DIAGRAM_SELECTOR).forEach((diagram) => {
        markedDiagrams.set(diagram, {
          role: diagram.getAttribute('role'),
          tabIndex: diagram.getAttribute('tabindex'),
          ariaLabel: diagram.getAttribute('aria-label'),
        });
        diagram.setAttribute('role', 'button');
        diagram.setAttribute('tabindex', '0');
        diagram.setAttribute('aria-label', openDiagramLabel);
      });
    };

    markDiagramsOpenable();
    const observer = new MutationObserver(markDiagramsOpenable);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      clearMarkedDiagrams();
    };
  }, [hasMermaidBlock, openDiagramLabel]);
  const components = useMemo(
    () =>
      createMarkdownComponents({
        copyAgentFileLabel,
        openAgentFileLabel,
        onAgentFileLinkClick,
      }),
    [copyAgentFileLabel, onAgentFileLinkClick, openAgentFileLabel]
  );

  const rehypePlugins = useMemo(() => (allowHtml ? [rehypeRaw, rehypeSanitize] : []), [allowHtml]);
  const streamdownTranslations = useMemo(
    () =>
      ({
        copied: t('common.copied', 'Copied'),
        copyCode: copyCodeLabel,
      }) satisfies Partial<StreamdownTranslations>,
    [copyCodeLabel, t]
  );
  const mermaidOptions = useMemo(
    () =>
      ({
        config: createMarkdownMermaidConfig(resolvedTheme),
      }) satisfies MermaidOptions,
    [resolvedTheme]
  );
  const normalizedSize = normalizeMarkdownRendererSize(size);
  const streamdownKey = `${allowHtml ? 'html' : 'markdown'}-${resolvedTheme}`;

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) {
      return undefined;
    }

    root
      .querySelectorAll<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]')
      .forEach((button) => button.setAttribute('aria-label', copyCodeLabel));

    const clearSearchHighlights = () => {
      const existingMarks = root.querySelectorAll('mark[data-session-search-mark="true"]');
      existingMarks.forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) {
          return;
        }
        while (mark.firstChild) {
          parent.insertBefore(mark.firstChild, mark);
        }
        parent.removeChild(mark);
        parent.normalize();
      });
    };

    clearSearchHighlights();

    const query = search?.isOpen ? search.query : '';
    if (!query || !searchBlockId || !searchMatch) {
      return clearSearchHighlights;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (!(node instanceof Text)) {
          return NodeFilter.FILTER_REJECT;
        }
        const value = node.nodeValue ?? '';
        if (!value) {
          return NodeFilter.FILTER_REJECT;
        }
        const parentElement = node.parentElement;
        if (!parentElement) {
          return NodeFilter.FILTER_ACCEPT;
        }
        if (parentElement.closest('mark[data-session-search-mark="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Array<{ node: Text; start: number; end: number }> = [];
    let cursor = 0;
    let nextNode = walker.nextNode();
    while (nextNode) {
      const textNode = nextNode as Text;
      const value = textNode.nodeValue ?? '';
      textNodes.push({
        node: textNode,
        start: cursor,
        end: cursor + value.length,
      });
      cursor += value.length;
      nextNode = walker.nextNode();
    }

    if (!textNodes.length) {
      return clearSearchHighlights;
    }

    const rawMatches = findSessionSearchOccurrences(
      textNodes.map(({ node }) => node.nodeValue ?? '').join(''),
      query
    );
    const hasAlignedMatches = rawMatches.length === searchMatch.resultIds.length;
    const matches = rawMatches.map((match, index) => ({
      ...match,
      resultId: hasAlignedMatches ? (searchMatch.resultIds[index] ?? null) : null,
      isActive: hasAlignedMatches && searchMatch.activeOccurrenceIndex === index,
    }));

    if (!matches.length) {
      return clearSearchHighlights;
    }

    textNodes.forEach(({ node, start, end }) => {
      const value = node.nodeValue ?? '';
      const overlaps = matches.filter((match) => match.start < end && match.end > start);
      if (!overlaps.length) {
        return;
      }

      const fragment = document.createDocumentFragment();
      let localCursor = 0;

      overlaps.forEach((match) => {
        const localStart = Math.max(0, match.start - start);
        const localEnd = Math.min(value.length, match.end - start);
        if (localStart > localCursor) {
          fragment.appendChild(document.createTextNode(value.slice(localCursor, localStart)));
        }
        const mark = document.createElement('mark');
        mark.dataset.sessionSearchMark = 'true';
        if (match.resultId) {
          mark.dataset.searchResultId = match.resultId;
        }
        mark.className = cn(
          SEARCH_HIGHLIGHT_MARK_CLASS_NAME,
          match.isActive && SEARCH_HIGHLIGHT_ACTIVE_MARK_CLASS_NAME
        );
        mark.textContent = value.slice(localStart, localEnd);
        fragment.appendChild(mark);
        localCursor = localEnd;
      });

      if (localCursor < value.length) {
        fragment.appendChild(document.createTextNode(value.slice(localCursor)));
      }

      const parent = node.parentNode;
      if (!parent) {
        return;
      }
      parent.insertBefore(fragment, node);
      parent.removeChild(node);
    });

    return clearSearchHighlights;
  }, [copyCodeLabel, search?.isOpen, search?.query, searchBlockId, searchMatch, text]);

  return (
    <>
      <div
        ref={containerRef}
        data-search-block-id={searchBlockId}
        className={cn(MARKDOWN_BASE_CLASSNAME, MARKDOWN_SIZE_CLASSNAME, className)}
        style={markdownFontSizeStyle(normalizedSize)}
        onClick={handleMarkdownClick}
        onKeyDown={handleMarkdownKeyDown}
      >
        <Streamdown
          // Streamdown's memo comparator does not include every rendering prop;
          // remount when raw-HTML mode or Mermaid theme changes so sanitized
          // rendering and diagram colors update correctly.
          key={streamdownKey}
          mode="streaming"
          className="space-y-0"
          controls={STREAMDOWN_CONTROLS}
          isAnimating={isStreaming}
          lineNumbers={false}
          mermaid={mermaidOptions}
          plugins={STREAMDOWN_PLUGINS}
          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
          rehypePlugins={rehypePlugins}
          components={components}
          translations={streamdownTranslations}
          urlTransform={markdownUrlTransform}
        >
          {normalizedText}
        </Streamdown>
      </div>
      {/* A sibling of the markdown, not a child: a portal's events bubble
          through the React tree, and inside the container the viewer's own
          clicks would reach the delegated open handler above. */}
      <MermaidDiagramViewer selection={diagramSelection} onClose={closeDiagram} />
    </>
  );
});
