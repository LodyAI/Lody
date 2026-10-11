import { useSelectionStableValue } from '@/hooks/use-conversation-text-selection';
import { text as textScale } from '@lody/ui/tokens/scales.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';
import { withClassName } from '@/lib/stylex';
import { conversation } from './conversation.tokens.stylex';
import { conversationTextToken } from './conversation-font-size-classes';
import {
  type ComponentPropsWithoutRef,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  createContext,
  lazy,
  useState,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  memo,
  Suspense,
} from 'react';
import { createPortal } from 'react-dom';
import type { SessionId } from '@lody/shared';
import { useAtomValue } from 'jotai';
import type { StreamdownProps } from '@lobehub/streamdown';
import Markdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
  type UrlTransform,
} from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly';
import remarkMath from 'remark-math';
import { Check, Copy, MessagesSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_CONVERSATION_FONT_SIZE, inlineMathEnabledAtom } from '@/atoms/settings';
import { MonochromeFileIcon } from '@/components/icons/file-icons';
import { writeTextToClipboard } from '@/lib/clipboard';
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
import { parseSessionLinkHref, useSessionLinkNavigator } from './session-link-context';
import { parseSessionLink, type SessionLink } from '@lody/shared/session-link';
import {
  SEARCH_HIGHLIGHT_ACTIVE_MARK_CLASS_NAME,
  SEARCH_HIGHLIGHT_MARK_CLASS_NAME,
  useSessionSearch,
  useSessionSearchBlock,
} from '@/components/sessions/session-search-context';
import { findSessionSearchOccurrences } from '@/lib/session-chat-search';
import { useResolvedTheme, type ResolvedTheme } from '../../theme-provider';
import type { ConversationFontSize } from '@/atoms/settings';
import { MarkdownFencedCodeBlock } from './markdown-code-block';
import { MarkdownDiffBlock } from './markdown-diff-block';
import { MarkdownMermaidBlock } from './markdown-mermaid-block';
import {
  GitHubReferenceChip,
  isGitHubReferenceLabel,
  markdownLinkText,
  parseGitHubReferenceUrl,
} from './github-reference-link';
import { MarkdownTable } from './markdown-table';
import { MermaidDiagramViewer } from './mermaid-diagram-viewer';
import { MermaidFullscreenButton, useMermaidDiagramCanvas } from './use-mermaid-diagram-canvas';
import { SessionReadonlyContext } from './session-readonly-context';
import type { MarkdownAgentFileLinkMenuItem } from '@/hooks/use-session-file-actions';
import { ContextMenu } from '@/ui/armed-overlays';
import { MarkdownFileImage, MarkdownFileResourcesContext } from './markdown-file-image';
import { resolveMarkdownImagePath } from '@/lib/session-file-open-target';
import { rehypeHeadingAnchors } from './markdown-heading-anchors';

export { createMarkdownMermaidConfig } from './markdown-mermaid';

/**
 * Conversation surfaces provide this capability at their boundary. Rendering
 * Markdown elsewhere (shared pages, file previews) deliberately has no native
 * file-actions menu.
 */
export const AgentFileLinkContextMenuItemsContext = createContext<
  ((href: string) => readonly MarkdownAgentFileLinkMenuItem[]) | undefined
>(undefined);

type MarkdownCodeProps = ComponentPropsWithoutRef<'code'> & {
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
  data?: { hProperties?: Record<string, unknown> };
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

const markdownStyles = stylex.create({
  root: { maxWidth: 'none', color: conversation.reading },
  paragraph: {
    marginTop: 0,
    marginBottom: { default: conversation.paragraphGap, ':has(+ ul)': space[2], ':last-child': 0 },
    textAlign: 'start',
    display: { default: 'block', ':is(li > p)': 'inline' },
    paddingInline: {
      default: conversation.railInset,
      ':is(li > p, table *, [data-streamdown] *, [data-tool-detail-sheet] *)': 0,
    },
  },
  compactParagraph: { marginBottom: { default: space[1], ':last-child': 0 } },
  list: {
    marginBlock: { default: space[2], ':is(li > ul, li > ol)': space[1] },
    paddingLeft: { default: 0, ':is(.contains-task-list)': space[3] },
    listStyleType: { default: 'none', ':is(.contains-task-list)': 'disc' },
  },
  listItem: {
    position: 'relative',
    marginTop: { default: 0, ':not(:first-child)': conversation.listItemGap },
    marginBottom: 0,
    paddingBlock: 0,
    paddingLeft: { default: space[6], ':is(.task-list-item)': 0 },
    '::before': {
      position: 'absolute',
      content: "''",
      left: '10px',
      top: '0.75em',
      width: space[1],
      height: space[1],
      transform: 'translateY(-50%)',
      borderRadius: radius.full,
      backgroundColor: 'currentColor',
      whiteSpace: 'nowrap',
      textAlign: 'right',
    },
  },
  orderedItem: {
    '::before': {
      content: 'counter(list-item) "."',
      left: 0,
      top: 0,
      width: '18px',
      height: 'auto',
      transform: 'none',
      backgroundColor: 'transparent',
    },
  },
  compactListItem: { marginTop: { default: 0, ':not(:first-child)': `calc(${space[1]} / 2)` } },
  taskItem: { '::before': { content: 'none' } },
  quote: {
    marginTop: conversation.paragraphGap,
    marginBottom: { default: conversation.paragraphGap, ':last-child': 0 },
    borderLeft: `2px solid ${colors.separator}`,
    paddingLeft: space[3],
    color: colors.secondaryLabel,
  },
  strong: { color: conversation.strong, fontWeight: 600 },
  rule: {
    marginBlock: conversation.surfaceGap,
    border: 0,
    borderTop: `1px solid ${colors.separator}`,
  },
  heading: {
    marginTop: { default: conversation.surfaceGap, ':first-child': 0 },
    marginBottom: space[2],
    paddingInline: {
      default: conversation.railInset,
      ':is(table *, [data-streamdown] *, [data-tool-detail-sheet] *)': 0,
    },
    fontWeight: 600,
    color: conversation.strong,
    fontSize: 'var(--markdown-body-font-size)',
  },
  h1: {
    marginTop: { default: space[6], ':first-child': 0 },
    fontSize: 'var(--markdown-h1-font-size)',
    lineHeight: 'var(--markdown-heading-line-height)',
    letterSpacing: '-0.025em',
  },
  h2: {
    marginTop: { default: `calc(${space[4]} + ${space[1]})`, ':first-child': 0 },
    fontSize: 'var(--markdown-h2-font-size)',
    lineHeight: 'var(--markdown-heading-line-height)',
    letterSpacing: '-0.025em',
  },
  h4: { marginBottom: space[1.5] },
  smallHeading: {
    marginTop: { default: conversation.paragraphGap, ':first-child': 0 },
    marginBottom: space[1.5],
    fontSize: 'var(--markdown-small-heading-font-size)',
    lineHeight: 'var(--markdown-small-heading-line-height)',
    textTransform: 'uppercase',
    letterSpacing: '0.025em',
  },
  muted: { color: colors.secondaryLabel },
  compactHeading: {
    marginTop: { default: space[1], ':first-child': 0 },
    marginBottom: space[1],
    fontSize: 'var(--markdown-body-font-size)',
    fontWeight: 500,
    color: colors.secondaryLabel,
  },
  inlineCode: {
    borderRadius: radius.mini,
    backgroundColor: `color-mix(in srgb, ${colors.label} 6%, transparent)`,
    paddingInline: space[1],
    paddingBlock: '1px',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--markdown-code-font-size)',
    lineHeight: 'var(--markdown-code-line-height)',
    color: conversation.reading,
  },
});

const MarkdownListKindContext = createContext<'unordered' | 'ordered' | 'task'>('unordered');
const MarkdownCompactContext = createContext(false);

function MarkdownListItem({
  node: _node,
  className,
  ...props
}: ComponentPropsWithoutRef<'li'> & ExtraProps) {
  const kind = useContext(MarkdownListKindContext);
  const compact = useContext(MarkdownCompactContext);
  return (
    <li
      {...props}
      {...withClassName(
        stylex.props(
          markdownStyles.listItem,
          compact && markdownStyles.compactListItem,
          kind === 'ordered' && markdownStyles.orderedItem,
          kind === 'task' && markdownStyles.taskItem
        ),
        className
      )}
    />
  );
}

const MARKDOWN_BASE_CLASSNAME =
  'markdown-renderer ' +
  // Color marks a link; the underline appears on hover only (a standing one
  // made dense CJK prose read as crowded).
  '[&_a]:no-underline [&_a]:underline-offset-2 [&_a]:decoration-current/60 [&_a:hover]:underline ' +
  '[&_.katex-display]:!my-5 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-1 ' +
  '[&_[data-streamdown="mermaid-block"]]:!my-5 ' +
  '[&_[data-streamdown="mermaid"]]:overflow-hidden ' +
  '[&_table]:!my-0 [&_table]:border-collapse ' +
  // Lines are foreground tints (the theme border melts into the canvas). No
  // column or row is assumed to be a label: cells share one color and weight;
  // only the header row, which Markdown always has, gets a faint band.
  '[&_thead]:bg-muted/80 ' +
  '[&_th]:border-b [&_th]:border-foreground/[0.14] [&_th]:bg-foreground/[0.035] [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-normal [&_th]:align-top ' +
  '[&_td]:border-b [&_td]:border-foreground/[0.08] [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top ' +
  '[&_:is(th,td)+:is(th,td)]:border-l [&_:is(th,td)+:is(th,td)]:border-l-foreground/[0.08] ' +
  '[&_tbody_tr:last-child_td]:border-b-0 ' +
  '[&_table_code]:!bg-foreground/[0.08] [&_table_code]:!ring-0 dark:[&_table_code]:!bg-foreground/[0.14]';

type MarkdownFontSizeStyle = CSSProperties & {
  '--markdown-body-font-size': string;
  '--markdown-h1-font-size': string;
  '--markdown-h2-font-size': string;
  '--markdown-small-heading-font-size': string;
  '--markdown-heading-line-height': string;
  '--markdown-small-heading-line-height': string;
  '--markdown-code-font-size': string;
  '--markdown-code-line-height': string;
  '--markdown-caption-font-size': string;
  '--markdown-caption-line-height': string;
};

function markdownFontSizeStyle(
  fontSize: ConversationFontSize,
  compact: boolean
): MarkdownFontSizeStyle {
  const body = compact ? textScale.subheadlineSize : textScale.bodySize;
  const leading = compact ? textScale.subheadlineLeading : conversation.readingLeading;
  return {
    fontSize: conversationTextToken(body, fontSize),
    lineHeight: conversationTextToken(leading, fontSize),
    '--markdown-body-font-size': conversationTextToken(body, fontSize),
    '--markdown-h1-font-size': conversationTextToken(textScale.titleSize, fontSize),
    '--markdown-h2-font-size': conversationTextToken(textScale.headlineSize, fontSize),
    '--markdown-small-heading-font-size': conversationTextToken(textScale.footnoteSize, fontSize),
    '--markdown-heading-line-height': conversationTextToken(textScale.titleLeading, fontSize),
    '--markdown-small-heading-line-height': conversationTextToken(
      textScale.footnoteLeading,
      fontSize
    ),
    '--markdown-code-font-size': conversationTextToken(textScale.subheadlineSize, fontSize),
    '--markdown-code-line-height': conversationTextToken(textScale.subheadlineLeading, fontSize),
    '--markdown-caption-font-size': conversationTextToken(textScale.captionSize, fontSize),
    '--markdown-caption-line-height': conversationTextToken(textScale.captionLeading, fontSize),
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

const SESSION_LINK_CHIP_CLASS_NAME =
  'markdown-reference-chip mx-[0.1em] inline-flex max-w-full items-center gap-[0.35em] rounded-md px-[0.4em] align-[-0.12em] text-[0.92em] leading-[1.55] transition-colors';

/**
 * A session resource link as a conversation chip, using in-app navigation
 * instead of sending the URI to the OS. Without navigation (read-only surfaces) the
 * chip still names the conversation but does nothing.
 */
function MarkdownSessionLink({
  target,
  children,
  inert,
}: {
  target: SessionLink;
  children: ReactNode;
  inert: boolean;
}) {
  const navigate = useSessionLinkNavigator();
  const sessionId = target.sessionId;
  // Composer mentions label the link `@Title`; the glyph already says "session".
  const title = markdownLinkText(children).trim().replace(/^@/u, '') || sessionId;
  const body = (
    <>
      <MessagesSquare className="h-[0.95em] w-[0.95em] shrink-0 self-center" aria-hidden="true" />
      <span className="min-w-0 truncate">{title}</span>
    </>
  );
  if (!navigate || inert) {
    return (
      <span data-session-link={sessionId} title={title} className={SESSION_LINK_CHIP_CLASS_NAME}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-session-link={sessionId}
      title={title}
      className={cn(SESSION_LINK_CHIP_CLASS_NAME, 'cursor-pointer')}
      onClick={() =>
        navigate({
          ...target,
          sessionId: sessionId as SessionId,
          tabSessionId: target.tabSessionId as SessionId | undefined,
        })
      }
    >
      {body}
    </button>
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

const FENCE_OPEN_PATTERN = /^[ \t]*(`{3,}|~{3,})/u;
const FENCE_CLOSE_PATTERN = /\n[\t >]*(`{3,}|~{3,})[ \t]*$/u;

const isUnclosedFence = (raw: string) => {
  const open = FENCE_OPEN_PATTERN.exec(raw)?.[1];
  if (!open) return false;
  const close = FENCE_CLOSE_PATTERN.exec(raw)?.[1];
  return !close || close[0] !== open[0] || close.length < open.length;
};

const remarkMarkUnclosedFences = () => (tree: unknown, file: MarkdownFile) => {
  const source = file.toString();
  const walk = (node: MdastNode) => {
    if (node.type === 'code') {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (
        typeof start === 'number' &&
        typeof end === 'number' &&
        isUnclosedFence(source.slice(start, end))
      ) {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, dataIncomplete: true },
        };
      }
    }
    node.children?.forEach(walk);
  };
  if (typeof tree === 'object' && tree !== null) walk(tree as MdastNode);
};

const MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkCjkFriendly,
  remarkRepairMalformedGfmAutolinks,
  remarkLinkifyPlainUrls,
  remarkLinkifyFilePaths,
  remarkMarkUnclosedFences,
  [remarkMath, { singleDollarTextMath: false }],
] satisfies StreamdownProps['remarkPlugins'];
const INLINE_MATH_REMARK_PLUGINS = [
  ...MARKDOWN_REMARK_PLUGINS,
  remarkSingleDollarTextMath,
] satisfies StreamdownProps['remarkPlugins'];

const KATEX_REHYPE_PLUGIN = [
  rehypeKatex,
  { errorColor: 'var(--color-muted-foreground)' },
] satisfies NonNullable<StreamdownProps['rehypePlugins']>[number];
const MARKDOWN_REHYPE_PLUGINS = [KATEX_REHYPE_PLUGIN];
const HTML_MARKDOWN_REHYPE_PLUGINS = [rehypeRaw, rehypeSanitize, KATEX_REHYPE_PLUGIN];
const ANCHORED_MARKDOWN_REHYPE_PLUGINS = [...MARKDOWN_REHYPE_PLUGINS, rehypeHeadingAnchors];
const ANCHORED_HTML_MARKDOWN_REHYPE_PLUGINS = [
  ...HTML_MARKDOWN_REHYPE_PLUGINS,
  rehypeHeadingAnchors,
];

const STREAMING_HANDOFF_DELAY_MS = 1000;

// Remend reads `<q` in a formula such as `p<q` as an unfinished HTML tag and
// drops the rest of the stream. Raw HTML is opt-in and sanitized, so tags are
// left to the Markdown parser.
const STREAMING_REMEND_OPTIONS = { htmlTags: false };

// The engine is loaded only for a turn that is streaming. Its bundle carries
// lookbehind regex literals, a parse error in Safari < 16.4, so a failed load
// falls back to rendering the stream statically instead of breaking the turn.
const StreamingMarkdown = lazy<ComponentType<StreamdownProps>>(() =>
  import('@lobehub/streamdown').then(
    ({ Streamdown }) => ({ default: Streamdown }),
    () => ({
      default: ({
        content,
        components,
        remarkPlugins,
        rehypePlugins,
        urlTransform,
      }: StreamdownProps) => (
        <Markdown
          components={components}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={urlTransform}
        >
          {content}
        </Markdown>
      ),
    })
  )
);

/** Matches a fenced ```mermaid block, so blocks without one skip the observer. */
const MERMAID_FENCE_PATTERN = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*mermaid\b/mu;

const markdownUrlTransform: UrlTransform = (value) =>
  isMarkdownAgentFileHref(value) || parseSessionLinkHref(value)
    ? value
    : defaultUrlTransform(value);

type HastElement = NonNullable<ExtraProps['node']>;

const readCodeElement = (pre: HastElement | undefined) => {
  const code = pre?.children[0];
  if (code?.type !== 'element' || code.tagName !== 'code') return null;
  const className = code.properties.className;
  const language =
    (Array.isArray(className) ? className : [])
      .map(String)
      .find((name) => name.startsWith('language-'))
      ?.slice('language-'.length) ?? '';
  return {
    code: code.children.map((child) => (child.type === 'text' ? child.value : '')).join(''),
    language: language || 'text',
    meta: (code.data as { meta?: string | null } | undefined)?.meta ?? undefined,
    isIncomplete: code.properties.dataIncomplete === true,
  };
};

function MarkdownPre({
  node,
  theme,
  ...props
}: ComponentPropsWithoutRef<'pre'> & ExtraProps & { theme: ResolvedTheme }) {
  const block = readCodeElement(node);
  if (!block) return <pre {...props} />;
  if (block.language === 'mermaid' && !block.isIncomplete) {
    return <MarkdownMermaidBlock code={block.code} theme={theme} />;
  }
  if (block.language === 'diff') return <MarkdownDiffBlock {...block} />;
  return <MarkdownFencedCodeBlock {...block} />;
}

const AgentFileLink = ({
  href,
  children,
  onFilePathClick,
  copyAgentFileLabel,
  openAgentFileLabel,
  getContextMenuItems,
}: {
  href: string;
  children: ReactNode;
  onFilePathClick?: (href: string) => void;
  copyAgentFileLabel: string;
  openAgentFileLabel: string;
  getContextMenuItems?: (href: string) => readonly MarkdownAgentFileLinkMenuItem[];
}) => {
  const [didCopy, setDidCopy] = useState(false);
  const hasOpenAction = Boolean(onFilePathClick);
  const iconPath = parseMarkdownAgentFileHref(href)?.filePath ?? href;
  const contextMenuItems = getContextMenuItems?.(href) ?? [];

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

  const link = (
    <button
      type="button"
      onClick={() => {
        void handleClick();
      }}
      title={href}
      aria-label={`${hasOpenAction ? openAgentFileLabel : copyAgentFileLabel}: ${href}`}
      className={cn(
        'm-0 inline-flex max-w-full items-baseline gap-1 rounded-sm border-0 bg-transparent p-0 align-baseline font-[inherit] leading-[inherit] text-markdown-link no-underline shadow-none transition-colors',
        'hover:underline underline-offset-2 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        // In a table cell the chip flows as inline text so the cell decides
        // whether the path wraps (see `markdown-table.tsx`); a truncated path
        // there would dictate the column's minimum width.
        '[:is(th,td)_&]:inline [:is(th,td)_&]:text-start'
      )}
    >
      <MonochromeFileIcon
        filePath={iconPath}
        className="h-[1.38em] w-[1.38em] shrink-0 self-center [:is(th,td)_&]:mr-1 [:is(th,td)_&]:inline-block [:is(th,td)_&]:align-[-0.33em]"
      />
      <span
        className={cn(
          'min-w-0 truncate',
          '[:is(th,td)_&]:overflow-visible [:is(th,td)_&]:text-clip [:is(th,td)_&]:[white-space:inherit] [:is(th,td)_&]:[line-break:anywhere]'
        )}
      >
        {children}
      </span>
      {!hasOpenAction ? (
        didCopy ? (
          <Check className="h-[0.85em] w-[0.85em] shrink-0 self-center [:is(th,td)_&]:ml-1 [:is(th,td)_&]:inline-block [:is(th,td)_&]:align-[-0.1em]" />
        ) : (
          <Copy className="h-[0.85em] w-[0.85em] shrink-0 self-center [:is(th,td)_&]:ml-1 [:is(th,td)_&]:inline-block [:is(th,td)_&]:align-[-0.1em]" />
        )
      ) : null}
    </button>
  );

  if (contextMenuItems.length === 0) return link;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{link}</ContextMenu.Trigger>
      <ContextMenu.Content className="min-w-[190px]">
        {contextMenuItems.map((item) => {
          const ItemIcon = item.icon;
          if (item.kind === 'submenu') {
            return (
              <ContextMenu.Submenu key={item.id}>
                <ContextMenu.SubmenuTrigger icon={<ItemIcon className="h-3.5 w-3.5" />}>
                  {item.label}
                </ContextMenu.SubmenuTrigger>
                <ContextMenu.SubmenuContent className="min-w-[190px]">
                  {item.items.map((child) => {
                    const ChildIcon = child.icon;
                    return (
                      <ContextMenu.Item
                        key={child.id}
                        icon={<ChildIcon className="h-3.5 w-3.5" />}
                        onClick={child.run}
                      >
                        {child.label}
                      </ContextMenu.Item>
                    );
                  })}
                </ContextMenu.SubmenuContent>
              </ContextMenu.Submenu>
            );
          }
          return (
            <ContextMenu.Item
              key={item.id}
              icon={<ItemIcon className="h-3.5 w-3.5" />}
              onClick={item.run}
            >
              {item.label}
            </ContextMenu.Item>
          );
        })}
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
};

function isWorkspaceResourceHref(href: string): boolean {
  try {
    return (
      isMarkdownAgentFileHref(href) ||
      /\/(?:api\/)?workspaces\/|\/session-(?:images|files)\//i.test(decodeURIComponent(href))
    );
  } catch {
    return true;
  }
}

const createMarkdownComponents = ({
  copyAgentFileLabel,
  openAgentFileLabel,
  onAgentFileLinkClick,
  getAgentFileLinkContextMenuItems,
  readonly,
  theme,
  headingAnchors,
  compact,
}: {
  copyAgentFileLabel: string;
  openAgentFileLabel: string;
  onAgentFileLinkClick?: (href: string) => void;
  getAgentFileLinkContextMenuItems?: (href: string) => readonly MarkdownAgentFileLinkMenuItem[];
  readonly: boolean;
  theme: ResolvedTheme;
  headingAnchors: boolean;
  compact: boolean;
}): Components => ({
  p: ({ children, className, node: _node, ...props }) => (
    <p
      {...props}
      {...withClassName(
        stylex.props(markdownStyles.paragraph, compact && markdownStyles.compactParagraph),
        className
      )}
    >
      {children}
    </p>
  ),
  ul: ({ node: _node, className, ...props }) => (
    <MarkdownListKindContext.Provider
      value={className?.split(' ').includes('contains-task-list') ? 'task' : 'unordered'}
    >
      <ul {...props} {...withClassName(stylex.props(markdownStyles.list), className)} />
    </MarkdownListKindContext.Provider>
  ),
  ol: ({ node: _node, className, ...props }) => (
    <MarkdownListKindContext.Provider value="ordered">
      <ol {...props} {...withClassName(stylex.props(markdownStyles.list), className)} />
    </MarkdownListKindContext.Provider>
  ),
  li: MarkdownListItem,
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote {...props} {...withClassName(stylex.props(markdownStyles.quote), className)} />
  ),
  strong: ({ node: _node, className, ...props }) => (
    <strong {...props} {...withClassName(stylex.props(markdownStyles.strong), className)} />
  ),
  hr: ({ node: _node, className, ...props }) => (
    <hr {...props} {...withClassName(stylex.props(markdownStyles.rule), className)} />
  ),
  h1: ({ node: _node, className, ...props }) => (
    <h1
      {...props}
      {...withClassName(
        stylex.props(
          markdownStyles.heading,
          markdownStyles.h1,
          compact && markdownStyles.compactHeading
        ),
        className
      )}
    />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2
      {...props}
      {...withClassName(
        stylex.props(
          markdownStyles.heading,
          markdownStyles.h2,
          compact && markdownStyles.compactHeading
        ),
        className
      )}
    />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3
      {...props}
      {...withClassName(
        stylex.props(markdownStyles.heading, compact && markdownStyles.compactHeading),
        className
      )}
    />
  ),
  h4: ({ node: _node, className, ...props }) => (
    <h4
      {...props}
      {...withClassName(
        stylex.props(
          markdownStyles.heading,
          markdownStyles.h4,
          compact && markdownStyles.compactHeading
        ),
        className
      )}
    />
  ),
  h5: ({ node: _node, className, ...props }) => (
    <h5
      {...props}
      {...withClassName(
        stylex.props(
          markdownStyles.heading,
          markdownStyles.smallHeading,
          compact && markdownStyles.compactHeading
        ),
        className
      )}
    />
  ),
  h6: ({ node: _node, className, ...props }) => (
    <h6
      {...props}
      {...withClassName(
        stylex.props(
          markdownStyles.heading,
          markdownStyles.smallHeading,
          markdownStyles.muted,
          compact && markdownStyles.compactHeading
        ),
        className
      )}
    />
  ),
  pre: (props) => <MarkdownPre {...props} theme={theme} />,
  code: (props: MarkdownCodeProps) => {
    const { className, children, style: _style, node: _node, ...rest } = props;
    return (
      <code {...withClassName(stylex.props(markdownStyles.inlineCode), className)} {...rest}>
        {children}
      </code>
    );
  },
  table: (props) => <MarkdownTable {...props} />,
  a: (props: MarkdownLinkProps) => {
    const { children, href, node: _node, rel, ...rest } = props;
    if (!href) return <span>{children}</span>;
    if (headingAnchors && href.startsWith('#')) {
      return (
        <a {...rest} href={href}>
          {children}
        </a>
      );
    }
    const linkedSession = parseSessionLink(href);
    if (linkedSession) {
      return (
        <MarkdownSessionLink target={linkedSession} inert={readonly}>
          {children}
        </MarkdownSessionLink>
      );
    }
    // Workspace resource links are display-only in a publication, not a second
    // download API. Ordinary article/GitHub links remain explicit external navigation.
    if (readonly && href && isWorkspaceResourceHref(href)) {
      return <span>{children}</span>;
    }

    if (isMarkdownAgentFileHref(href)) {
      return (
        <AgentFileLink
          href={href}
          onFilePathClick={onAgentFileLinkClick}
          copyAgentFileLabel={copyAgentFileLabel}
          openAgentFileLabel={openAgentFileLabel}
          getContextMenuItems={getAgentFileLinkContextMenuItems}
        >
          {children}
        </AgentFileLink>
      );
    }

    // A link that only names a GitHub pull request or issue renders as a small
    // reference label; one with its own wording stays an ordinary link.
    const githubReference = parseGitHubReferenceUrl(href);
    if (githubReference && isGitHubReferenceLabel(markdownLinkText(children), githubReference)) {
      return (
        <MarkdownExternalLink
          href={href}
          rel={rel}
          {...rest}
          className={cn(
            rest.className,
            'markdown-reference-chip mx-[0.1em] inline-flex max-w-full items-baseline rounded-md px-[0.4em] align-baseline text-[1em] leading-[1.55] transition-colors'
          )}
        >
          <GitHubReferenceChip reference={githubReference} />
        </MarkdownExternalLink>
      );
    }

    return (
      <MarkdownExternalLink href={href} rel={rel} {...rest}>
        {children}
      </MarkdownExternalLink>
    );
  },
  img: ConversationMarkdownImage,
  // <picture> just passes through its children (the <img> fallback);
  // <source> is suppressed since it's only meaningful inside a real browser <picture>.
  source: () => null,
  picture: (props: MarkdownPictureProps) => <>{props.children}</>,
});

function ConversationMarkdownImage(props: MarkdownImageProps) {
  const readonly = useContext(SessionReadonlyContext);
  const resources = useContext(MarkdownFileResourcesContext);
  // No workspace URI fetch is mounted for an anonymous publication.
  // Typed share images are handled separately through the manifest attachment reader.
  if (readonly) {
    const inline =
      typeof props.src === 'string' &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(props.src);
    return inline ? (
      <img
        src={props.src}
        alt={props.alt ?? ''}
        className="my-2 max-h-[32rem] max-w-full rounded-md object-contain"
      />
    ) : (
      <span
        role="img"
        aria-label={props.alt || 'Image'}
        className="my-2 block text-sm text-muted-foreground"
      >
        {props.alt || 'Image'}
      </span>
    );
  }
  if (
    resources &&
    typeof props.src === 'string' &&
    resolveMarkdownImagePath(resources.documentPath, props.src) !== null
  ) {
    return <MarkdownFileImage src={props.src} alt={props.alt} />;
  }
  return <SizedMarkdownImage {...props} />;
}

type ImageOutcome = { width: number; height: number } | 'failed';

/**
 * What each image source did the last time it mounted. Virtua unmounts rows
 * outside the overscan, and an image without known dimensions renders at 0px
 * until it loads, so every remount changed its row's height after mount and
 * moved the conversation. Known sizes are reserved up front; a source that
 * failed (an agent-local path the page cannot reach) renders its alt text.
 */
const imageOutcomes = new Map<string, ImageOutcome>();
const IMAGE_OUTCOME_LIMIT = 500;

function rememberImageOutcome(src: string, outcome: ImageOutcome): void {
  imageOutcomes.delete(src);
  imageOutcomes.set(src, outcome);
  if (imageOutcomes.size > IMAGE_OUTCOME_LIMIT) {
    const oldest = imageOutcomes.keys().next().value;
    if (oldest !== undefined) imageOutcomes.delete(oldest);
  }
}

function SizedMarkdownImage(props: MarkdownImageProps) {
  const { node: _node, src, alt, onLoad, onError, ...rest } = props;
  const key = typeof src === 'string' ? src : undefined;
  const [outcome, setOutcome] = useState(() =>
    key === undefined ? undefined : imageOutcomes.get(key)
  );
  if (outcome === 'failed') {
    return (
      <span
        role="img"
        aria-label={alt || 'Image'}
        className="my-2 block text-sm text-muted-foreground"
      >
        {alt || 'Image'}
      </span>
    );
  }
  return (
    <img
      {...rest}
      src={src}
      alt={alt ?? ''}
      // With `height: auto`, these reserve the image's aspect ratio before it loads.
      width={outcome?.width ?? rest.width}
      height={outcome?.height ?? rest.height}
      className={cn('my-2 max-h-[32rem] max-w-full rounded-md object-contain', rest.className)}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (key !== undefined && image.naturalWidth > 0) {
          rememberImageOutcome(key, { width: image.naturalWidth, height: image.naturalHeight });
        }
        onLoad?.(event);
      }}
      onError={(event) => {
        if (key !== undefined) {
          rememberImageOutcome(key, 'failed');
          setOutcome('failed');
        }
        onError?.(event);
      }}
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

/** A React-owned text node cut short by search marks, and how to restore it. */
type SearchTextSplit = { node: Text; value: string; head: string; inserted: ChildNode[] };

export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  size = DEFAULT_CONVERSATION_FONT_SIZE,
  className,
  allowHtml = false,
  isStreaming = false,
  onAgentFileLinkClick,
  searchBlockId,
  headingAnchors = false,
  compact = false,
}: {
  text: string;
  size?: MarkdownRendererSize;
  className?: string;
  /** Enable raw HTML rendering (sanitized). Use for GitHub comment bodies. */
  allowHtml?: boolean;
  /** Renders through the smoothing, fading stream engine while a turn is still streaming. */
  isStreaming?: boolean;
  onAgentFileLinkClick?: (href: string) => void;
  searchBlockId?: string;
  /** Generate document heading ids and leave fragment clicks to the owning surface. */
  headingAnchors?: boolean;
  /** Tool prose shares the control role without scaling nested code a second time. */
  compact?: boolean;
}) {
  ({ text, size, allowHtml, isStreaming, searchBlockId } = useSelectionStableValue({
    text,
    size,
    allowHtml,
    isStreaming,
    searchBlockId,
  }));
  const { t } = useTranslation();
  const resolvedTheme = useSelectionStableValue(useResolvedTheme());
  const readonly = useContext(SessionReadonlyContext);
  const getAgentFileLinkContextMenuItems = useContext(AgentFileLinkContextMenuItemsContext);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Text nodes split for search marks in this block, with what to undo. */
  const searchSplitsRef = useRef<SearchTextSplit[]>([]);
  const search = useSelectionStableValue(useSessionSearch());
  const searchMatch = useSelectionStableValue(useSessionSearchBlock(searchBlockId ?? ''));
  const copyAgentFileLabel = t('sessions.copyAgentFilePath', 'Copy agent file path');
  const openAgentFileLabel = t('sessions.openAgentFile', 'Open agent file');
  const canvasLabel = t('sessions.diagram.canvas', 'Zoom and pan diagram');
  const openDiagramLabel = t('sessions.diagramViewer.open', 'Open diagram');
  const inlineMathEnabled = useAtomValue(inlineMathEnabledAtom);
  // Both scans below re-run over the whole accumulated answer on every streamed
  // delta. A substring test settles the common case before the line-anchored
  // pattern runs.
  const hasMermaidBlock = useMemo(
    () => text.includes('mermaid') && MERMAID_FENCE_PATTERN.test(text),
    [text]
  );
  const normalizedText = useMemo(
    () => normalizeTexMathDelimiters(text, inlineMathEnabled),
    [inlineMathEnabled, text]
  );
  const {
    blocks: mermaidBlocks,
    selection: diagramSelection,
    closeDiagram,
    openDiagram,
    handleContainerClick,
    handleContainerKeyDown,
  } = useMermaidDiagramCanvas({
    containerRef,
    enabled: hasMermaidBlock,
    canvasLabel,
  });

  const currentComponents = useMemo(
    () =>
      createMarkdownComponents({
        copyAgentFileLabel,
        openAgentFileLabel,
        onAgentFileLinkClick,
        getAgentFileLinkContextMenuItems,
        readonly: readonly !== null,
        theme: resolvedTheme,
        headingAnchors,
        compact,
      }),
    [
      copyAgentFileLabel,
      getAgentFileLinkContextMenuItems,
      onAgentFileLinkClick,
      openAgentFileLabel,
      readonly,
      resolvedTheme,
      headingAnchors,
      compact,
    ]
  );

  const components = useSelectionStableValue(currentComponents);
  const remarkPlugins = inlineMathEnabled ? INLINE_MATH_REMARK_PLUGINS : MARKDOWN_REMARK_PLUGINS;
  const rehypePlugins = headingAnchors
    ? allowHtml
      ? ANCHORED_HTML_MARKDOWN_REHYPE_PLUGINS
      : ANCHORED_MARKDOWN_REHYPE_PLUGINS
    : allowHtml
      ? HTML_MARKDOWN_REHYPE_PLUGINS
      : MARKDOWN_REHYPE_PLUGINS;
  const normalizedSize = normalizeMarkdownRendererSize(size);
  // The engine keeps revealing its buffered tail after the stream ends. Staying
  // mounted briefly lets that reveal finish instead of jumping to the full text.
  const [streamingRendererActive, setStreamingRendererActive] = useState(isStreaming);
  if (isStreaming && !streamingRendererActive) {
    setStreamingRendererActive(true);
  }
  useEffect(() => {
    if (isStreaming || !streamingRendererActive) return undefined;
    const timeout = window.setTimeout(
      () => setStreamingRendererActive(false),
      STREAMING_HANDOFF_DELAY_MS
    );
    return () => window.clearTimeout(timeout);
  }, [isStreaming, streamingRendererActive]);

  // Search needs the complete current text in the same commit as its index.
  // The stream engine reveals buffered text asynchronously and can replace marks.
  const showStreamingMarkdown = streamingRendererActive && !(search?.isOpen && search.query);

  const staticMarkdown = (
    <Markdown
      components={components}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={markdownUrlTransform}
    >
      {normalizedText}
    </Markdown>
  );

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) {
      return undefined;
    }

    const clearSearchHighlights = () => {
      // This effect re-runs on every streamed delta; a block without marks
      // has nothing to undo.
      const splits = searchSplitsRef.current;
      if (!splits.length) return;
      searchSplitsRef.current = [];
      for (const { node, value, head, inserted } of splits) {
        for (const child of inserted) child.remove();
        // React may have rewritten the node since it was split; its text wins.
        if (node.nodeValue === head) node.nodeValue = value;
      }
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

      const parent = node.parentNode;
      if (!parent) {
        return;
      }

      // React owns `node` and inserts or removes its siblings relative to it,
      // so it stays in place holding the text before the first match; marks
      // and the remaining text follow it. Replacing it would leave React an
      // anchor outside the DOM (`insertBefore` throws once a link arms).
      const head = value.slice(0, Math.max(0, overlaps[0]!.start - start));
      const fragment = document.createDocumentFragment();
      let localCursor = head.length;

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

      searchSplitsRef.current.push({
        node,
        value,
        head,
        inserted: [...fragment.childNodes],
      });
      node.nodeValue = head;
      parent.insertBefore(fragment, node.nextSibling);
    });

    return clearSearchHighlights;
  }, [search?.isOpen, search?.query, searchBlockId, searchMatch, text, showStreamingMarkdown]);

  return (
    <MarkdownCompactContext.Provider value={compact}>
      <div
        ref={containerRef}
        data-search-block-id={searchBlockId}
        {...withClassName(
          stylex.props(markdownStyles.root, compact && markdownStyles.muted),
          cn(MARKDOWN_BASE_CLASSNAME, className)
        )}
        style={markdownFontSizeStyle(normalizedSize, compact)}
        onClick={handleContainerClick}
        onKeyDown={handleContainerKeyDown}
      >
        {showStreamingMarkdown ? (
          <Suspense fallback={staticMarkdown}>
            <StreamingMarkdown
              animateOnMount={false}
              content={normalizedText}
              remend={STREAMING_REMEND_OPTIONS}
              components={components}
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              urlTransform={markdownUrlTransform}
            />
          </Suspense>
        ) : (
          staticMarkdown
        )}
        {/* Filled by portal into each diagram block's action bar, beside copy
            and download: the button opens `MermaidDiagramViewer`. */}
        {mermaidBlocks.map((block) =>
          createPortal(
            <MermaidFullscreenButton
              label={openDiagramLabel}
              onOpen={() => openDiagram(block.diagram)}
            />,
            block.actions,
            block.id
          )
        )}
      </div>
      {/* A sibling of the markdown, not a child: a portal's events bubble
          through the React tree, and inside the container the viewer's own
          clicks would reach the delegated open handler above. */}
      <MermaidDiagramViewer selection={diagramSelection} onClose={closeDiagram} />
    </MarkdownCompactContext.Provider>
  );
});
