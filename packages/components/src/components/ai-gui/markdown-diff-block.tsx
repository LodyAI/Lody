import { memo, useMemo, useState } from 'react';
import {
  CodeBlockContainer,
  MarkdownCodeToolbar,
  parseMarkdownCodeBlockLabel,
  type MarkdownCodeBlockProps,
} from './markdown-code-block';

type MarkdownDiffLineKind = 'addition' | 'context' | 'deletion' | 'hunk' | 'metadata';

const DIFF_FILE_HEADER_PATTERN = /^(?:---|\+\+\+)(?:\s|$)/u;
const DIFF_METADATA_PATTERN =
  /^(?:diff --git |index |(?:new|deleted) file mode |(?:old|new) mode |similarity index |rename (?:from|to) |Binary files |GIT binary patch|\\ No newline at end of file)/u;

const getMarkdownDiffLineKind = (line: string): MarkdownDiffLineKind => {
  if (line.startsWith('@@')) return 'hunk';
  if (DIFF_FILE_HEADER_PATTERN.test(line) || DIFF_METADATA_PATTERN.test(line)) return 'metadata';
  if (line.startsWith('+')) return 'addition';
  if (line.startsWith('-')) return 'deletion';
  return 'context';
};

const getVisibleDiffLines = (code: string): string[] =>
  code.replace(/(?:\r?\n)+$/u, '').split(/\r?\n/u);

/**
 * Lightweight renderer for both full patches and the headerless, explanatory
 * diffs agents commonly write in chat. A full patch parser is intentionally not
 * used here: it rejects those snippets and is unnecessary work on every
 * streaming prefix.
 */
export const MarkdownDiffBlock = memo(function MarkdownDiffBlock({
  code,
  isIncomplete,
  language,
  meta,
}: MarkdownCodeBlockProps) {
  const [wrapped, setWrapped] = useState(false);
  const lines = useMemo(() => getVisibleDiffLines(code), [code]);
  const label = useMemo(() => parseMarkdownCodeBlockLabel(language, meta), [language, meta]);

  return (
    <CodeBlockContainer
      data-code-wrap={wrapped ? 'true' : undefined}
      data-markdown-diff-block="true"
      isIncomplete={isIncomplete}
      language={language}
    >
      <MarkdownCodeToolbar
        code={code}
        label={label}
        wrapped={wrapped}
        onToggleWrap={() => setWrapped((current) => !current)}
      />
      <div data-streamdown="code-block-body">
        <pre dir="ltr">
          <code>
            {lines.map((line, index) => (
              <span
                // A streamed block grows by appending lines, so its stable
                // source position is the least disruptive key available.
                key={index}
                data-markdown-diff-line={getMarkdownDiffLineKind(line)}
              >
                {line}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </CodeBlockContainer>
  );
});
