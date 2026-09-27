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

export function CodeBlockContainer({
  language,
  isIncomplete,
  ...props
}: ComponentProps<'div'> & { language: string; isIncomplete: boolean }) {
  return (
    <div
      data-incomplete={isIncomplete || undefined}
      data-language={language}
      data-streamdown="code-block"
      {...props}
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
      onClick={() => {
        void writeTextToClipboard(code).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
        });
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

const tokenStyle = ({ color, htmlStyle }: MarkdownCodeToken): CSSProperties | undefined => {
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
    <div data-streamdown="code-block-body" data-language={language}>
      <pre>
        <code>
          {lines.map((line, lineIndex) => (
            // Lines only append while a fence streams, so position is stable.
            <span key={lineIndex}>
              {line.length === 0 || (line.length === 1 && line[0]?.content === '')
                ? '\n'
                : line.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={tokenStyle(token)}>
                      {token.content}
                    </span>
                  ))}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
});

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
    <div data-streamdown="code-block-toolbar">
      <div data-streamdown="code-block-header">{label ? <span>{label}</span> : null}</div>
      <div data-streamdown="code-block-actions">
        {markdownPreview && onTogglePreview ? (
          <button
            type="button"
            aria-label={previewLabel}
            aria-pressed={previewing}
            title={previewLabel}
            onClick={onTogglePreview}
          >
            {previewing ? <EyeOff /> : <Eye />}
          </button>
        ) : null}
        {previewing ? null : (
          <button
            type="button"
            aria-label={wrapLabel}
            aria-pressed={wrapped}
            title={wrapLabel}
            onClick={onToggleWrap}
          >
            <WrapText />
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
        <div data-markdown-preview="true">
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
