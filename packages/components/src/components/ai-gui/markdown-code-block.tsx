import { memo, useMemo, useState } from 'react';
import { WrapText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  CodeBlock,
  CodeBlockContainer,
  CodeBlockCopyButton,
  type CustomRendererProps,
} from 'streamdown';

const NAMED_PATH_PATTERN = /(?:title|filename|path|file)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/iu;
const HIGHLIGHT_LANG_PATTERN = /\bhighlight=(\S+)/iu;

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

export const MarkdownCodeToolbar = memo(function MarkdownCodeToolbar({
  code,
  label,
  wrapped,
  onToggleWrap,
}: {
  code: string;
  label: string;
  wrapped: boolean;
  onToggleWrap: () => void;
}) {
  const { t } = useTranslation();
  const wrapLabel = wrapped
    ? t('sessions.fileViewer.wordWrapDisable', 'Disable line wrap')
    : t('sessions.fileViewer.wordWrapEnable', 'Wrap long lines');

  return (
    <div data-streamdown="code-block-toolbar">
      <div data-streamdown="code-block-header">{label ? <span>{label}</span> : null}</div>
      <div data-streamdown="code-block-actions">
        <button
          type="button"
          aria-label={wrapLabel}
          aria-pressed={wrapped}
          title={wrapLabel}
          onClick={onToggleWrap}
        >
          <WrapText />
        </button>
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
  const label = useMemo(() => parseMarkdownCodeBlockLabel(language, meta), [language, meta]);
  const highlightLanguage = useMemo(
    () => parseMarkdownCodeHighlightLanguage(language, meta),
    [language, meta]
  );

  return (
    <CodeBlockContainer
      data-code-wrap={wrapped ? 'true' : undefined}
      isIncomplete={isIncomplete}
      language={language}
    >
      <MarkdownCodeToolbar
        code={code}
        label={label}
        wrapped={wrapped}
        onToggleWrap={() => setWrapped((current) => !current)}
      />
      <div className="lody-code-highlight">
        <CodeBlock
          code={code}
          isIncomplete={isIncomplete}
          language={highlightLanguage}
          lineNumbers={false}
        />
      </div>
    </CodeBlockContainer>
  );
});
