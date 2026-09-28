import { memo, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import type { ConversationFontSize } from '@/atoms/settings';
import { createVSCodeTerminalTheme } from '@/lib/vscode-theme';
import { useActiveVSCodeTheme } from '../../theme-provider';
import { terminalTextFontSizeStyle } from './conversation-font-size-classes';
import { markdownCodeTokenStyle } from './markdown-code-block';
import { useMarkdownCodeTokens } from './markdown-code-highlight';
import { renderAnsiToReactNodes } from './terminal-component';

/**
 * What an expanded tool step shows: ONE sheet holding what the step did and
 * what came back, in the order it happened.
 *
 * The step row already names the tool and its target, so the sheet carries no
 * header of its own — the old terminal panel repeated the title in a gray band
 * above the command. Its sections are rows of one record, divided by the
 * separator rule: the command, the output, any text result.
 *
 * The sheet is the conversation's card material — the composer's fill (white
 * in light themes, the input surface in dark) resting on the page with the card
 * shadow — not the terminal's own background, which drew a gray slab in the
 * light theme and a second, differently lit surface in dark.
 *
 * Only the command is highlighted, and only off the main thread (the shared
 * Shiki worker behind `useMarkdownCodeTokens`). Output is what a program printed:
 * it keeps its ANSI colours and is never tokenized.
 */

const MONO = 'var(--font-terminal)';

const styles = stylex.create({
  sheet: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: 'hsl(var(--composer))',
    boxShadow: shadow.card,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    color: colors.label,
  },
  section: {
    minWidth: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    // Rows of one record: a rule between them, never above the first.
    boxShadow: { default: `inset 0 1px 0 ${colors.separator}`, ':first-child': 'none' },
  },
  command: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
  },
  prompt: {
    flexShrink: 0,
    color: colors.tertiaryLabel,
    fontFamily: MONO,
    lineHeight: 1.6,
    userSelect: 'none',
  },
  code: {
    flex: 1,
    minWidth: 0,
    margin: 0,
    fontFamily: MONO,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: colors.label,
    backgroundColor: 'transparent',
  },
  output: {
    margin: 0,
    fontFamily: MONO,
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: colors.secondaryLabel,
    backgroundColor: 'transparent',
  },
  caption: {
    display: 'block',
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.tertiaryLabel,
  },
  captionAbove: { marginBottom: space[1] },
  exit: {
    display: 'block',
    marginTop: space[1],
    fontFamily: MONO,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    color: colors.destructive,
  },
  exitAlone: { marginTop: 0 },
});

export function ToolDetailSheet({ children }: { children: ReactNode }) {
  return (
    <div data-tool-detail-sheet="" {...stylex.props(styles.sheet)}>
      {children}
    </div>
  );
}

export function ToolDetailSection({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.section)}>{children}</div>;
}

/**
 * The command, highlighted as shell when it is one. A search's stored "command"
 * is its pattern, not a shell line, so it gets neither the prompt nor shell
 * colours.
 */
export const ToolCommandSection = memo(function ToolCommandSection({
  command,
  shell,
  running,
  fontSize,
}: {
  command: string;
  shell: boolean;
  running: boolean;
  fontSize: ConversationFontSize;
}) {
  const lines = useMarkdownCodeTokens(command, shell ? 'shellscript' : '', running);
  const fontStyle = terminalTextFontSizeStyle(fontSize);
  return (
    <div {...stylex.props(styles.section, styles.command)}>
      {shell ? (
        <span aria-hidden="true" {...stylex.props(styles.prompt)} style={fontStyle}>
          $
        </span>
      ) : null}
      <pre data-shiki-palette="" {...stylex.props(styles.code)} style={fontStyle}>
        <code>
          {lines.map((line, lineIndex) => (
            <span key={lineIndex}>
              {lineIndex > 0 ? '\n' : null}
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} style={markdownCodeTokenStyle(token)}>
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

/**
 * What the program printed, bounded to its tail by the caller. A non-zero exit
 * is the one fact worth a colour: it says the step failed even when the output
 * does not.
 */
export const ToolOutputSection = memo(function ToolOutputSection({
  output,
  limited,
  exitCode,
  fontSize,
}: {
  output: string;
  limited: boolean;
  exitCode: number | null | undefined;
  fontSize: ConversationFontSize;
}) {
  const { t } = useTranslation();
  const activeVSCodeTheme = useActiveVSCodeTheme();
  const terminalTheme = useMemo(
    () => createVSCodeTerminalTheme(activeVSCodeTheme),
    [activeVSCodeTheme]
  );
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  const hasOutput = output.length > 0;
  if (!hasOutput && !failed) return null;
  return (
    <div {...stylex.props(styles.section)}>
      {hasOutput && limited ? (
        <span {...stylex.props(styles.caption, styles.captionAbove)}>
          {t('sessions.toolCall.earlierOutputHidden', 'Earlier output not shown')}
        </span>
      ) : null}
      {hasOutput ? (
        <pre {...stylex.props(styles.output)} style={terminalTextFontSizeStyle(fontSize)}>
          {renderAnsiToReactNodes({ value: output, terminalTheme })}
        </pre>
      ) : null}
      {failed ? (
        <span {...stylex.props(styles.exit, !hasOutput && styles.exitAlone)}>
          {t('sessions.toolCall.exitCode', { code: exitCode, defaultValue: 'Exit {{code}}' })}
        </span>
      ) : null}
    </div>
  );
});

/** Verbatim machine text (a JSON result, a fenced snapshot): mono, never Markdown. */
export function ToolVerbatimSection({
  value,
  fontSize,
}: {
  value: string;
  fontSize: ConversationFontSize;
}) {
  return (
    <div {...stylex.props(styles.section)}>
      <pre {...stylex.props(styles.output)} style={terminalTextFontSizeStyle(fontSize)}>
        {value}
      </pre>
    </div>
  );
}

export function ToolCaptionSection({ children }: { children: ReactNode }) {
  return (
    <div {...stylex.props(styles.section)}>
      <span {...stylex.props(styles.caption)}>{children}</span>
    </div>
  );
}
