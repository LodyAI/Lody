import {
  type ComponentProps,
  type CSSProperties,
  lazy,
  memo,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check, Copy, Eye, EyeOff, WrapText } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { conversationFontSizeAtom } from '@/atoms/settings';
import * as stylex from '@stylexjs/stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';
import { conversation } from './conversation.tokens.stylex';
import { writeTextToClipboard } from '@/lib/clipboard';
import { useMarkdownCodeTokens, type MarkdownCodeToken } from './markdown-code-highlight';

export type MarkdownCodeBlockProps = {
  code: string;
  isIncomplete: boolean;
  language: string;
  meta: string | undefined;
};

const NAMED_PATH_PATTERN = /(?:title|filename|path|file)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/iu;
const MARKDOWN_FENCE_LANGUAGES = new Set(['md', 'markdown', 'mdx', 'gfm', 'mdown', 'mkd']);

const MarkdownPreview = lazy(() =>
  import('./markdown-renderer').then((mod) => ({ default: mod.MarkdownRenderer }))
);

export function parseMarkdownCodeBlockPath(meta: string | undefined): string | null {
  if (!meta) return null;
  const named = meta.match(NAMED_PATH_PATTERN);
  const fromNamed = named?.[1] ?? named?.[2] ?? named?.[3];
  if (fromNamed) return fromNamed;

  for (const token of meta.trim().split(/\s+/u)) {
    if (
      token.startsWith('{') ||
      token.startsWith('startLine') ||
      token === 'noLineNumbers' ||
      token.startsWith('highlight=')
    ) {
      continue;
    }
    if (token.includes('/') || /\.[A-Za-z0-9]+$/u.test(token)) return token;
  }
  return null;
}

export function parseMarkdownCodeBlockLabel(language: string, meta: string | undefined): string {
  return parseMarkdownCodeBlockPath(meta) ?? language.trim();
}

export function isMarkdownCodeFence(language: string, meta: string | undefined): boolean {
  const lang = language.trim().toLowerCase();
  if (MARKDOWN_FENCE_LANGUAGES.has(lang)) return true;
  const path = parseMarkdownCodeBlockPath(meta);
  return path != null && /\.(?:md|markdown|mdx|mdown|mkd)$/iu.test(path);
}

const COPY_FEEDBACK_MS = 2000;

const typography = stylex.create({
  block: {
    '--markdown-code-block-bg': {
      default: conversation.codeFill,
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        conversation.codeDarkFill,
    },
    '--markdown-code-block-border': conversation.codeBorder,
    '--markdown-code-block-foreground': conversation.codeText,
    '--markdown-code-block-language': conversation.codeMeta,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    marginBlock: conversation.surfaceGap,
    overflow: 'hidden',
    gap: 0,
    border: 0,
    borderRadius: radius.small,
    backgroundColor: 'var(--markdown-code-block-bg)',
    padding: 0,
    color: conversation.codeText,
  },
  toolbar: {
    display: 'flex',
    minHeight: '28px',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: space[2],
    paddingInline: space[3],
    borderBottom: `0.5px solid ${conversation.codeBorder}`,
    color: conversation.codeMeta,
  },
  header: {
    display: 'flex',
    minWidth: 0,
    flex: 1,
    alignItems: 'center',
    overflow: 'hidden',
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.02em',
    pointerEvents: 'none',
  },
  label: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  actions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    columnGap: `calc(${space[1]} / 2)`,
  },
  action: {
    display: 'inline-flex',
    width: space[6],
    height: space[6],
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    borderRadius: radius.mini,
    color: {
      default: conversation.codeMeta,
      ':hover': conversation.codeText,
      ':is([aria-pressed="true"])': conversation.codeText,
    },
    backgroundColor: {
      default: 'transparent',
      ':is([aria-pressed="true"])': `color-mix(in srgb, ${conversation.codeText} 12%, transparent)`,
    },
  },
  icon: { width: '14px', height: '14px' },
  body: {
    overflowX: { default: 'auto', ':is([data-code-wrap="true"] *)': 'hidden' },
    paddingBlock: space[3],
    paddingInline: space[4],
    color: conversation.codeText,
  },
  pre: {
    minWidth: { default: 'max-content', ':is([data-code-wrap="true"] *)': 0 },
    margin: 0,
    backgroundColor: 'transparent',
    whiteSpace: { default: 'pre', ':is([data-code-wrap="true"] *)': 'pre-wrap' },
    overflowWrap: { default: 'normal', ':is([data-code-wrap="true"] *)': 'anywhere' },
    width: { default: 'auto', ':is([data-code-wrap="true"] *)': '100%' },
  },
  line: { display: 'block' },
  preview: {
    paddingTop: space[2],
    paddingInline: space[1.5],
    paddingBottom: space[3],
    backgroundColor: 'transparent',
  },
  code: {
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: `var(--markdown-code-font-size, ${text.subheadlineSize})`,
    lineHeight: `var(--markdown-code-line-height, ${text.subheadlineLeading})`,
  },
  caption: {
    fontSize: `var(--markdown-caption-font-size, ${text.captionSize})`,
    lineHeight: `var(--markdown-caption-line-height, ${text.captionLeading})`,
  },
});

export function CodeBlockContainer({
  language,
  isIncomplete,
  className,
  ...props
}: ComponentProps<'div'> & { language: string; isIncomplete: boolean }) {
  return (
    <div
      data-incomplete={isIncomplete || undefined}
      data-language={language}
      data-streamdown="code-block"
      {...props}
      {...withClassName(stylex.props(typography.block), className)}
    />
  );
}

export function CodeBlockCopyButton({ code }: { code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef(0);
  const label = t('common.copyCode', 'Copy code');

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  return (
    <button
      type="button"
      data-streamdown="code-block-copy-button"
      aria-label={label}
      title={copied ? t('common.copied', 'Copied') : label}
      {...stylex.props(typography.action)}
      onClick={() => {
        void writeTextToClipboard(code).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
        });
      }}
    >
      {copied ? (
        <Check {...stylex.props(typography.icon)} />
      ) : (
        <Copy {...stylex.props(typography.icon)} />
      )}
    </button>
  );
}

export const markdownCodeTokenStyle = ({
  color,
  htmlStyle,
}: MarkdownCodeToken): CSSProperties | undefined => {
  if (!htmlStyle) return color ? { color } : undefined;
  return {
    color: htmlStyle.color ?? color,
    fontStyle: htmlStyle['font-style'],
    fontWeight: htmlStyle['font-weight'],
    textDecoration: htmlStyle['text-decoration'],
  };
};

const MarkdownCodeBody = memo(function MarkdownCodeBody({
  code,
  language,
  isIncomplete,
}: {
  code: string;
  language: string;
  isIncomplete: boolean;
}) {
  const trimmed = useMemo(() => code.replace(/\n+$/u, ''), [code]);
  const lines = useMarkdownCodeTokens(trimmed, language, isIncomplete);

  return (
    <CodeBlockBody data-language={language}>
      {lines.map((line, lineIndex) => (
        // Lines only append while a fence streams, so position is stable.
        <span key={lineIndex} {...stylex.props(typography.line)}>
          {line.length === 0 || (line.length === 1 && line[0]?.content === '')
            ? '\n'
            : line.map((token, tokenIndex) => (
                <span key={tokenIndex} style={markdownCodeTokenStyle(token)}>
                  {token.content}
                </span>
              ))}
        </span>
      ))}
    </CodeBlockBody>
  );
});

export function CodeBlockBody({ children, className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      data-streamdown="code-block-body"
      {...withClassName(stylex.props(typography.body), className)}
    >
      <pre dir="ltr" {...stylex.props(typography.pre)}>
        <code {...stylex.props(typography.code)}>{children}</code>
      </pre>
    </div>
  );
}

export const MarkdownCodeToolbar = memo(function MarkdownCodeToolbar({
  code,
  label,
  wrapped,
  onToggleWrap,
  markdownPreview = false,
  previewing = false,
  onTogglePreview,
}: {
  code: string;
  label: string;
  wrapped: boolean;
  onToggleWrap: () => void;
  markdownPreview?: boolean;
  previewing?: boolean;
  onTogglePreview?: () => void;
}) {
  const { t } = useTranslation();
  const wrapLabel = wrapped
    ? t('sessions.fileViewer.wordWrapDisable', 'Disable line wrap')
    : t('sessions.fileViewer.wordWrapEnable', 'Wrap long lines');
  const previewLabel = previewing
    ? t('sessions.fileViewer.preview.hide', 'Hide preview')
    : t('sessions.fileViewer.preview.show', 'Preview');

  return (
    <div data-streamdown="code-block-toolbar" {...stylex.props(typography.toolbar)}>
      <div
        data-streamdown="code-block-header"
        {...stylex.props(typography.header, typography.caption)}
      >
        {label ? <span {...stylex.props(typography.label)}>{label}</span> : null}
      </div>
      <div data-streamdown="code-block-actions" {...stylex.props(typography.actions)}>
        {markdownPreview && onTogglePreview ? (
          <button
            type="button"
            aria-label={previewLabel}
            aria-pressed={previewing}
            title={previewLabel}
            {...stylex.props(typography.action)}
            onClick={onTogglePreview}
          >
            {previewing ? (
              <EyeOff {...stylex.props(typography.icon)} />
            ) : (
              <Eye {...stylex.props(typography.icon)} />
            )}
          </button>
        ) : null}
        {previewing ? null : (
          <button
            type="button"
            aria-label={wrapLabel}
            aria-pressed={wrapped}
            title={wrapLabel}
            {...stylex.props(typography.action)}
            onClick={onToggleWrap}
          >
            <WrapText {...stylex.props(typography.icon)} />
          </button>
        )}
        <CodeBlockCopyButton code={code} />
      </div>
    </div>
  );
});

export const MarkdownFencedCodeBlock = memo(function MarkdownFencedCodeBlock({
  code,
  isIncomplete,
  language,
  meta,
}: MarkdownCodeBlockProps) {
  const [wrapped, setWrapped] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const conversationFontSize = useAtomValue(conversationFontSizeAtom);
  const markdownPreview = useMemo(() => isMarkdownCodeFence(language, meta), [language, meta]);
  const label = useMemo(() => parseMarkdownCodeBlockLabel(language, meta), [language, meta]);
  const showPreview = markdownPreview && previewing;

  return (
    <CodeBlockContainer
      data-code-wrap={!showPreview && wrapped ? 'true' : undefined}
      data-markdown-preview={showPreview ? 'true' : undefined}
      isIncomplete={isIncomplete}
      language={language}
    >
      <MarkdownCodeToolbar
        code={code}
        label={label}
        wrapped={wrapped}
        onToggleWrap={() => setWrapped((current) => !current)}
        markdownPreview={markdownPreview}
        previewing={showPreview}
        onTogglePreview={() => setPreviewing((current) => !current)}
      />
      {showPreview ? (
        <div data-markdown-preview="true" {...stylex.props(typography.preview)}>
          <Suspense fallback={null}>
            <MarkdownPreview text={code} size={conversationFontSize} isStreaming={isIncomplete} />
          </Suspense>
        </div>
      ) : (
        <MarkdownCodeBody code={code} language={language} isIncomplete={isIncomplete} />
      )}
    </CodeBlockContainer>
  );
});
