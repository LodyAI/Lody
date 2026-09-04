import { memo, useMemo } from 'react';
import {
  CodeBlockContainer,
  CodeBlockCopyButton,
  CodeBlockHeader,
  type CustomRendererProps,
} from 'streamdown';

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
}: CustomRendererProps) {
  const lines = useMemo(() => getVisibleDiffLines(code), [code]);

  return (
    <CodeBlockContainer
      data-markdown-diff-block="true"
      isIncomplete={isIncomplete}
      language={language}
    >
      <CodeBlockHeader language={language} />
      <div className="pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end">
        <div
          className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur"
          data-streamdown="code-block-actions"
        >
          <CodeBlockCopyButton code={code} />
        </div>
      </div>
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
