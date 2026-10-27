import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import Anser from 'anser';
import { Terminal } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { text as textScale } from '@lody/ui/tokens/scales.stylex';
import { clsx } from 'clsx';
import { cn } from '@/lib/utils';
import {
  CONVERSATION_PANEL_FRAME_CLASS,
  CONVERSATION_PANEL_HEADER_CLASS,
  CONVERSATION_PANEL_HEADER_RULE_CLASS,
} from './conversation-panel';
import {
  createVSCodeTerminalTheme,
  resolveAnsiColorToCss,
  type VSCodeTerminalTheme,
} from '@/lib/vscode-theme';
import { useActiveVSCodeTheme } from '../../theme-provider';
import { DEFAULT_CONVERSATION_FONT_SIZE, type ConversationFontSize } from '@/atoms/settings';
import { terminalTextFontSizeStyle } from './conversation-font-size-classes';
import { prepareTerminalPreview } from './terminal-preview';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontWeight,
  themeSpace,
} from '../../style/theme-scale.stylex';

export { prepareTerminalPreview } from './terminal-preview';

const typography = stylex.create({
  caption: { fontSize: textScale.captionSize, lineHeight: textScale.captionLeading },
  title: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: themeFontWeight.medium,
  },
});

const styles = stylex.create({
  root: { overflow: 'hidden' },
  surfaceFallback: { backgroundColor: 'hsl(var(--muted) / 0.35)' },
  glyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  headerButton: {
    width: '100%',
    textAlign: 'left',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    '@media (hover: hover)': { ':hover': { backgroundColor: themeColors.hover } },
  },
  body: { color: themeColors.foreground },
  commandRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[2],
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
  },
  commandPrompt: { color: themeColors.mutedForeground },
  commandText: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  },
  outputFrame: { position: 'relative' },
  outputScroll: { overflow: 'auto' },
  // A static ring, not a focus ring: it paints while the output sits there.
  outputFocusRing: { boxShadow: '0 0 0 1px hsl(var(--ring) / 0.3)' },
  outputRest: { overflow: 'hidden' },
  outputText: {
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  },
  focusOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    height: '100%',
    cursor: 'pointer',
    backgroundColor: 'transparent',
  },
  outputFade: {
    pointerEvents: 'none',
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: themeSpace[8],
    backgroundImage:
      'linear-gradient(to bottom in oklab, hsl(var(--muted) / 0.9), transparent)',
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const renderAnsiToReactNodes = ({
  value,
  terminalTheme,
}: {
  value: string;
  terminalTheme: VSCodeTerminalTheme | undefined;
}): ReactNode => {
  const parsed = Anser.ansiToJson(value, { use_classes: true, remove_empty: false });

  return parsed.map((segment, index) => {
    const style: CSSProperties = {};

    let fg = resolveAnsiColorToCss(segment.fg, segment.fg_truecolor, terminalTheme?.palette);
    let bg = resolveAnsiColorToCss(segment.bg, segment.bg_truecolor, terminalTheme?.palette);
    const isInverted = isRecord(segment) ? Boolean(segment.isInverted) : false;
    if (isInverted) {
      const tmp = fg;
      fg = bg;
      bg = tmp;
    }
    if (fg) style.color = fg;
    if (bg) style.backgroundColor = bg;

    const decorations = new Set<string>();
    if (Array.isArray(segment.decorations)) {
      for (const decoration of segment.decorations) decorations.add(String(decoration));
    }
    if (segment.decoration) decorations.add(String(segment.decoration));

    if (decorations.has('bold')) style.fontWeight = 700;
    if (decorations.has('italic')) style.fontStyle = 'italic';

    const textDecorations: string[] = [];
    if (decorations.has('underline')) textDecorations.push('underline');
    if (decorations.has('strikethrough')) textDecorations.push('line-through');
    if (textDecorations.length) style.textDecoration = textDecorations.join(' ');

    return (
      <span key={index} style={style}>
        {segment.content ?? ''}
      </span>
    );
  });
};

export type TerminalComponentProps = {
  title: string;
  command: string;
  output: string;
  className?: string;
  tailLines?: number;
  focusedMaxHeightPx?: number;
  outputDisplayMode?: 'tail' | 'scroll' | 'full';
  showHeader?: boolean;
  showBorder?: boolean;
  showBackground?: boolean;
  bodyVisible?: boolean;
  onHeaderClick?: () => void;
  headerExpanded?: boolean;
  fontSize?: ConversationFontSize;
};

export const TerminalComponent = memo(function TerminalComponent({
  title,
  command,
  output,
  className,
  tailLines = 16,
  focusedMaxHeightPx = 320,
  outputDisplayMode = 'tail',
  showHeader = true,
  showBorder = true,
  showBackground = true,
  bodyVisible = true,
  onHeaderClick,
  headerExpanded,
  fontSize = DEFAULT_CONVERSATION_FONT_SIZE,
}: TerminalComponentProps) {
  const outputRef = useRef<HTMLDivElement>(null);
  const [isFocused, setIsFocused] = useState(false);
  const activeVSCodeTheme = useActiveVSCodeTheme();
  const terminalTheme = useMemo(
    () => createVSCodeTerminalTheme(activeVSCodeTheme),
    [activeVSCodeTheme]
  );

  const outputPreview = useMemo(
    () => prepareTerminalPreview(output, { maxLines: tailLines }),
    [output, tailLines]
  );
  const isTruncatedView = outputPreview.wasLimited;
  const shouldRenderInput = command.trim().length > 0;
  const hasOutput = outputPreview.text.length > 0;
  const shouldUseScrollOutput = outputDisplayMode === 'scroll';
  const shouldUseFullOutput = outputDisplayMode === 'full';
  // Expanding changes only the viewport. Rendering the full persisted legacy
  // string would reintroduce the same large Anser/DOM work this preview avoids.
  const outputText = outputPreview.text;
  const outputTextForDisplay = outputText.length === 0 ? ' ' : outputText;
  const terminalContainerStyle = showBackground ? terminalTheme?.containerStyle : undefined;
  const terminalBackgroundColor = terminalContainerStyle?.backgroundColor;
  const collapsedOutputFadeStyle =
    showBackground && terminalBackgroundColor
      ? { background: `linear-gradient(to bottom, ${terminalBackgroundColor}, transparent)` }
      : undefined;

  useEffect(() => {
    if (shouldUseScrollOutput || shouldUseFullOutput || !isFocused) {
      return undefined;
    }
    const handleClickAway = (event: MouseEvent) => {
      if (!outputRef.current) return;
      if (!outputRef.current.contains(event.target as Node)) {
        setIsFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, [isFocused, shouldUseFullOutput, shouldUseScrollOutput]);

  const headerContent = (
    <>
      <Terminal {...stylex.props(styles.glyph)} />
      <div
        className={clsx(
          stylex.props(typography.caption).className,
          stylex.props(typography.title).className
        )}
      >
        {title}
      </div>
    </>
  );

  return (
    <div
      className={clsx(
        stylex.props(styles.root).className,
        cn(showBorder ? CONVERSATION_PANEL_FRAME_CLASS : null, className)
      )}
    >
      {/* The terminal's own surface (VS Code `terminal.background`, or the muted
          fallback) wraps the header AND the body, so the header's raised tint
          steps away from the SAME base the output sits on. While the surface
          lived on the body alone, the header was tinting the frame instead and
          the step measured -1 in dark and inverted to +7 in light. */}
      <div
        {...stylex.props(
          showBackground && !terminalBackgroundColor ? styles.surfaceFallback : null
        )}
        style={terminalContainerStyle}
      >
        {showHeader ? (
          onHeaderClick ? (
            <button
              type="button"
              className={clsx(
                CONVERSATION_PANEL_HEADER_CLASS,
                stylex.props(styles.headerButton).className,
                bodyVisible ? CONVERSATION_PANEL_HEADER_RULE_CLASS : null
              )}
              onClick={onHeaderClick}
              aria-expanded={headerExpanded}
            >
              {headerContent}
            </button>
          ) : (
            <div
              className={clsx(
                CONVERSATION_PANEL_HEADER_CLASS,
                bodyVisible ? CONVERSATION_PANEL_HEADER_RULE_CLASS : null
              )}
            >
              {headerContent}
            </div>
          )
        ) : null}

        {bodyVisible ? (
          <div {...stylex.props(styles.body)}>
            {shouldRenderInput ? (
              <div
                className={clsx(
                  'font-terminal',
                  stylex.props(styles.commandRow).className,
                  hasOutput ? 'border-b border-border/50' : null
                )}
              >
                <span
                  {...stylex.props(styles.commandPrompt)}
                  style={terminalTextFontSizeStyle(fontSize)}
                >
                  $
                </span>
                <pre
                  className={clsx(
                    'scrollbar-pro',
                    'font-terminal',
                    stylex.props(styles.commandText).className
                  )}
                  style={terminalTextFontSizeStyle(fontSize)}
                >
                  {command}
                </pre>
              </div>
            ) : null}

            {hasOutput ? (
              <div
                ref={outputRef}
                className={clsx(
                  stylex.props(styles.outputFrame).className,
                  shouldUseFullOutput
                    ? null
                    : shouldUseScrollOutput || isFocused
                      ? clsx(
                          'scrollbar-pro',
                          stylex.props(styles.outputScroll).className,
                          shouldUseScrollOutput
                            ? null
                            : stylex.props(styles.outputFocusRing).className
                        )
                      : stylex.props(styles.outputRest).className
                )}
                style={{
                  maxHeight:
                    !shouldUseFullOutput && (shouldUseScrollOutput || isFocused)
                      ? focusedMaxHeightPx
                      : undefined,
                }}
              >
                <pre
                  className={clsx(
                    'font-terminal',
                    stylex.props(styles.outputText).className
                  )}
                  style={terminalTextFontSizeStyle(fontSize)}
                >
                  {renderAnsiToReactNodes({ value: outputTextForDisplay, terminalTheme })}
                </pre>

                {!shouldUseScrollOutput && !shouldUseFullOutput && !isFocused && isTruncatedView ? (
                  <button
                    type="button"
                    {...stylex.props(styles.focusOverlay)}
                    onClick={() => setIsFocused(true)}
                    aria-label="Focus terminal output"
                  >
                    <div
                      {...stylex.props(styles.outputFade)}
                      style={collapsedOutputFadeStyle}
                    />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});
