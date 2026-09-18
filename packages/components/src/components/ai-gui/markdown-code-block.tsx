import { lazy, memo, Suspense, useMemo, useState } from 'react';
import { Eye, EyeOff, WrapText } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import {
  CodeBlock,
  CodeBlockContainer,
  CodeBlockCopyButton,
  type CustomRendererProps,
} from 'streamdown';
import { conversationFontSizeAtom } from '@/atoms/settings';

const NAMED_PATH_PATTERN = /(?:title|filename|path|file)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/iu;
const HIGHLIGHT_LANG_PATTERN = /\bhighlight=(\S+)/iu;
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

export function parseMarkdownCodeHighlightLanguage(
  language: string,
  meta: string | undefined
): string {
  const highlight = meta?.match(HIGHLIGHT_LANG_PATTERN)?.[1];
  if (highlight) return highlight;
  return language.trim() || 'text';
}

export function isMarkdownCodeFence(language: string, meta: string | undefined): boolean {
  const lang = language.trim().toLowerCase();
  if (MARKDOWN_FENCE_LANGUAGES.has(lang)) return true;
  const path = parseMarkdownCodeBlockPath(meta);
  return path != null && /\.(?:md|markdown|mdx|mdown|mkd)$/iu.test(path);
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
}: CustomRendererProps) {
  const [wrapped, setWrapped] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const conversationFontSize = useAtomValue(conversationFontSizeAtom);
  const markdownPreview = useMemo(() => isMarkdownCodeFence(language, meta), [language, meta]);
  const label = useMemo(() => parseMarkdownCodeBlockLabel(language, meta), [language, meta]);
  const highlightLanguage = useMemo(
    () => parseMarkdownCodeHighlightLanguage(language, meta),
    [language, meta]
  );
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
        <div className="lody-code-highlight">
          <CodeBlock
            code={code}
            isIncomplete={isIncomplete}
            language={highlightLanguage}
            lineNumbers={false}
          />
        </div>
      )}
    </CodeBlockContainer>
  );
});
