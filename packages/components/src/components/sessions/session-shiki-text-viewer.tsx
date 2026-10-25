import { useAtomValue } from 'jotai';
import { Fragment, useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { TokensResult, ThemedToken } from 'shiki';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text as typography } from '@lody/ui/tokens/scales.stylex';
import { fileViewerWordWrapAtom } from '@/atoms/settings';
import { withClassName } from '@/lib/stylex';
import { highlightStandaloneFile } from '@/lib/standalone-file-highlighter';
import { useActiveVSCodeTheme, useResolvedTheme } from '../../theme-provider';

const styles = stylex.create({
  container: { height: '100%', minHeight: 240, width: '100%', overflow: 'auto' },
  code: {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    margin: 0,
    paddingBlock: space[2],
    fontFamily: 'var(--diffs-font-family, monospace)',
    fontSize: typography.subheadlineSize,
    lineHeight: typography.bodyLeading,
    color: colors.label,
    backgroundColor: colors.background,
    minWidth: '100%',
    width: 'max-content',
  },
  wrap: { width: '100%' },
  number: {
    userSelect: 'none',
    textAlign: 'right',
    paddingInline: space[3],
    color: colors.secondaryLabel,
  },
  line: { whiteSpace: 'pre', paddingRight: space[3], minWidth: 0 },
  wrappedLine: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
});

/** Explicit Coq/Lean grammars, independently owned from Diffs' Highlights backend. */
export function SessionShikiTextViewer({
  path,
  text,
  language,
  className,
}: {
  readonly path: string;
  readonly text: string;
  readonly language: 'coq' | 'lean';
  readonly className?: string;
}) {
  const wordWrap = useAtomValue(fileViewerWordWrapAtom);
  const mode = useResolvedTheme();
  const theme = useActiveVSCodeTheme();
  const [resolved, setResolved] = useState<{
    text: string;
    language: typeof language;
    theme: typeof theme;
    mode: typeof mode;
    result: TokensResult;
  }>();
  useEffect(() => {
    let cancelled = false;
    void highlightStandaloneFile(text, language, theme, mode).then(
      (result) => {
        if (!cancelled) setResolved({ text, language, theme, mode, result });
      },
      (error: unknown) => {
        console.warn('[SessionShikiTextViewer] Highlighting failed', error);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [text, language, theme, mode]);
  const result =
    resolved?.text === text &&
    resolved.language === language &&
    resolved.theme === theme &&
    resolved.mode === mode
      ? resolved.result
      : undefined;
  const lines: ThemedToken[][] =
    result?.tokens ?? text.split(/\r\n|\n|\r/u).map((content) => [{ content, offset: 0 }]);
  return (
    <div {...withClassName(stylex.props(styles.container), className)}>
      <pre
        {...stylex.props(styles.code, wordWrap && styles.wrap)}
        aria-label={path}
        style={{ color: result?.fg, backgroundColor: result?.bg }}
      >
        {lines.map((line, index) => (
          <Fragment key={index}>
            <span {...stylex.props(styles.number)} aria-hidden="true">
              {index + 1}
            </span>
            <code {...stylex.props(styles.line, wordWrap && styles.wrappedLine)}>
              {line.map((token, tokenIndex) => (
                <span
                  key={tokenIndex}
                  style={{
                    color: token.color,
                    fontStyle: (token.fontStyle ?? 0) & 1 ? 'italic' : undefined,
                    fontWeight: (token.fontStyle ?? 0) & 2 ? 'bold' : undefined,
                    textDecoration: (token.fontStyle ?? 0) & 4 ? 'underline' : undefined,
                  }}
                >
                  {token.content}
                </span>
              ))}
              {index < lines.length - 1 ? '\n' : null}
            </code>
          </Fragment>
        ))}
      </pre>
    </div>
  );
}
