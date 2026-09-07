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
import {
  conversationTextFontSizeStyle,
  terminalTextFontSizeStyle,
} from './conversation-font-size-classes';
import { prepareTerminalPreview } from './terminal-preview';

export { prepareTerminalPreview } from './terminal-preview';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const renderAnsiToReactNodes = ({
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
      <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 truncate text-[11px] font-medium">{title}</div>
    </>
  );

  return (
    <div
      className={cn(
        'overflow-hidden',
        showBorder ? CONVERSATION_PANEL_FRAME_CLASS : null,
        className
      )}
    >
      {/* The terminal's own surface (VS Code `terminal.background`, or the muted
          fallback) wraps the header AND the body, so the header's raised tint
          steps away from the SAME base the output sits on. While the surface
          lived on the body alone, the header was tinting the frame instead and
          the step measured -1 in dark and inverted to +7 in light. */}
      <div
        className={cn(showBackground && !terminalBackgroundColor ? 'bg-muted/[0.35]' : null)}
        style={terminalContainerStyle}
      >
        {showHeader ? (
          onHeaderClick ? (
            <button
              type="button"
              className={cn(
                CONVERSATION_PANEL_HEADER_CLASS,
                'w-full text-left transition-colors hover:bg-muted',
                bodyVisible ? CONVERSATION_PANEL_HEADER_RULE_CLASS : null
              )}
              onClick={onHeaderClick}
              aria-expanded={headerExpanded}
            >
              {headerContent}
            </button>
          ) : (
            <div
              className={cn(
                CONVERSATION_PANEL_HEADER_CLASS,
                bodyVisible ? CONVERSATION_PANEL_HEADER_RULE_CLASS : null
              )}
            >
              {headerContent}
            </div>
          )
        ) : null}

        {bodyVisible ? (
          <div className="text-foreground">
            {shouldRenderInput ? (
              <div
                className={cn(
                  'flex items-start gap-2 px-3 py-2 font-terminal',
                  hasOutput ? 'border-b border-border/50' : null
                )}
              >
                <span
                  className="leading-none text-muted-foreground"
                  style={conversationTextFontSizeStyle(fontSize)}
                >
                  $
                </span>
                <pre
                  className="scrollbar-pro min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-terminal"
                  style={terminalTextFontSizeStyle(fontSize)}
                >
                  {command}
                </pre>
              </div>
            ) : null}

            {hasOutput ? (
              <div
                ref={outputRef}
                className={cn(
                  'relative',
                  shouldUseFullOutput
                    ? null
                    : shouldUseScrollOutput || isFocused
                      ? cn(
                          'scrollbar-pro overflow-auto',
                          shouldUseScrollOutput ? null : 'ring-1 ring-ring/30'
                        )
                      : 'overflow-hidden'
                )}
                style={{
                  maxHeight:
                    !shouldUseFullOutput && (shouldUseScrollOutput || isFocused)
                      ? focusedMaxHeightPx
                      : undefined,
                }}
              >
                <pre
                  className="px-3 py-2 font-terminal leading-relaxed whitespace-pre-wrap break-words"
                  style={terminalTextFontSizeStyle(fontSize)}
                >
                  {renderAnsiToReactNodes({ value: outputTextForDisplay, terminalTheme })}
                </pre>

                {!shouldUseScrollOutput && !shouldUseFullOutput && !isFocused && isTruncatedView ? (
                  <button
                    type="button"
                    className="absolute inset-0 h-full cursor-pointer bg-transparent"
                    onClick={() => setIsFocused(true)}
                    aria-label="Focus terminal output"
                  >
                    <div
                      className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-muted/90 to-transparent"
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
