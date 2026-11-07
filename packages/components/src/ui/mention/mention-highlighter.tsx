import { clsx } from 'clsx';
import { useCallbackRef, useComposedRefs } from '@diceui/shared';
import * as React from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { badge } from '@lody/ui/badge/badge.tokens.stylex';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { type Mention, type MentionChip, useMentionContext } from './mention-root';

const HIGHLIGHTER_NAME = 'MentionHighlighter';

const styles = stylex.create({
  hidden: { visibility: 'hidden' },
  chip: {
    boxDecorationBreak: 'clone',
    backgroundColor: `var(--mention-chip-surface,${colors.background})`,
    backgroundImage: 'var(--mention-chip-overlay,none)',
  },
  selectedChip: {
    backgroundImage: 'linear-gradient(Highlight,Highlight)',
    color: 'HighlightText !important',
  },
  iconSlot: { position: 'relative' },
  icon: {
    ':is(*) > *': { maxWidth: '100%' },
    visibility: 'visible',
    position: 'absolute',
    insetBlock: 'calc(var(--spacing) * 0)',
    left: 'calc(var(--spacing) * 0)',
    right: '1px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  pastedHighlight: {
    borderRadius: 'var(--radius-md)',
    backgroundColor: badge.neutralFill,
    WebkitBoxDecorationBreak: 'clone',
    boxDecorationBreak: 'clone',
  },
  highlight: {
    borderRadius: 'var(--radius-sm)',
    backgroundColor: colors.wellBackground,
    WebkitBoxDecorationBreak: 'clone',
    boxDecorationBreak: 'clone',
  },
});

type HighlighterElement = HTMLDivElement;

/**
 * One mirror paints ordinary text and decorated ranges together. The transparent
 * textarea stays above it for native editing, selection and the caret; focus or
 * caret movement must never change which layer paints the text.
 */
const defaultHighlighterStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 0,
  color: 'transparent',
  whiteSpace: 'pre-wrap',
  wordWrap: 'break-word',
  pointerEvents: 'none',
  userSelect: 'none',
  overflow: 'hidden',
  width: '100%',
};

interface MentionHighlighterProps extends React.HTMLAttributes<HighlighterElement> {
  /** Text rendered by this mirror; IME preedit may lead the committed context value. */
  renderValue?: string;
  /** Ranges addressing `renderValue`; defaults to the committed context ranges. */
  renderMentions?: readonly Mention[];
  /** Paint all visible text when the textarea delegates its glyphs to this mirror. */
  showText?: boolean;
}

type MentionHighlightSegment =
  | {
      type: 'text' | 'space';
      key: string;
      text: string;
      start: number;
    }
  | {
      type: 'mention';
      key: string;
      text: string;
      mention: Mention;
    };

export function getMentionHighlightSegments(
  value: string,
  mentions: readonly Mention[]
): MentionHighlightSegment[] {
  const segments: MentionHighlightSegment[] = [];
  let lastIndex = 0;

  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    const { start, end } = mention;
    if (start < lastIndex || start < 0 || end <= start || end > value.length) {
      continue;
    }

    if (start > lastIndex) {
      segments.push({
        type: 'text',
        start: lastIndex,
        key: `text-${lastIndex}`,
        text: value.slice(lastIndex, start),
      });
    }

    segments.push({
      type: 'mention',
      key: `mention-${start}-${end}-${mention.kind ?? 'mention'}-${mention.value}`,
      text: value.slice(start, end),
      mention,
    });

    lastIndex = end;
  }

  if (lastIndex < value.length) {
    segments.push({
      type: 'text',
      start: lastIndex,
      key: `text-end-${value.length}`,
      text: value.slice(lastIndex),
    });
  }

  segments.push({ type: 'space', key: 'space', text: '\u00a0', start: value.length });
  return segments;
}

/**
 * A decorated range paints no visible background — the mention reads as
 * coloured text, and `chip.className` supplies only that colour.
 *
 * It does still paint the *surface* colour, and that is not a contradiction: a
 * native textarea cannot colour a sub-range of its own value, so the only way
 * to recolour one is to cover its glyphs and redraw them. The cover has to be
 * opaque or the original shows through underneath. Painting the surface colour
 * makes the cover invisible while it does that job.
 *
 * `--mention-chip-surface` is therefore whatever sits behind the textarea. It
 * is an opaque backdrop. A translucent well also publishes its fill as
 * `--mention-chip-overlay`; native background layers reproduce the well without
 * painting the underlying glyphs through a second translucent cover.
 */
const CHIP_CLASS_NAME = stylex.props(styles.chip).className;

/**
 * Selection is the one case that still needs a fill: the surface cover also
 * hides the textarea's own selection highlight, so the range has to repaint it.
 * The system colour goes on as a background *image* over the opaque surface
 * *colour*, because `Highlight` is `rgba(0, 65, 198, 0.8)` in Chrome — used
 * alone it would be translucent enough to let the covered glyphs back through.
 */
const CHIP_SELECTED_CLASS_NAME = stylex.props(styles.selectedChip).className;

/** The mirror paints selection too; the textarea keeps its native selection state. */
function useInputSelection(
  inputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  enabled: boolean
) {
  const [selection, setSelection] = React.useState<[number, number] | null>(null);

  React.useLayoutEffect(() => {
    if (!enabled) return undefined;

    const read = () => {
      const input = inputRef.current;
      if (!input || document.activeElement !== input) {
        setSelection(null);
        return;
      }
      const { selectionStart, selectionEnd } = input;
      if (selectionStart === null || selectionEnd === null) {
        setSelection(null);
        return;
      }
      if (selectionStart === selectionEnd) {
        setSelection(null);
        return;
      }
      // Same range, same object: `selectionchange` fires at pointer-move rate
      // through a drag-select, and a fresh tuple each time would defeat React's
      // bail-out and re-split the whole draft into segments per event.
      setSelection((prev) =>
        prev && prev[0] === selectionStart && prev[1] === selectionEnd
          ? prev
          : [selectionStart, selectionEnd]
      );
    };

    read();
    const input = inputRef.current;
    document.addEventListener('selectionchange', read);
    input?.addEventListener('select', read);
    input?.addEventListener('focus', read);
    input?.addEventListener('blur', read);
    return () => {
      document.removeEventListener('selectionchange', read);
      input?.removeEventListener('select', read);
      input?.removeEventListener('focus', read);
      input?.removeEventListener('blur', read);
    };
  }, [enabled, inputRef]);

  return selection;
}

/**
 * Splits the range into its icon slot, label, and trailing pad. The slot
 * characters still render — as `invisible`, so they keep their exact boxes —
 * and the icon overrides `visibility` from inside the slot it covers.
 */
function MentionChipContent({ chip, text }: { chip: MentionChip; text: string }) {
  const iconSlots = Math.max(0, Math.min(chip.iconSlots ?? 1, text.length));
  const trailingSlots = Math.max(0, Math.min(chip.trailingSlots ?? 0, text.length - iconSlots));
  const iconText = text.slice(0, iconSlots);
  const labelText = text.slice(iconSlots, text.length - trailingSlots);
  const trailingText = text.slice(text.length - trailingSlots);

  return (
    <>
      {iconText ? (
        <span {...stylex.props(styles.hidden, styles.iconSlot)}>
          {iconText}
          {chip.icon ? (
            <span
              aria-hidden="true"
              // Confined to the slot, never hanging past it. Hanging left into
              // the preceding space looked better and was wrong twice: a slash
              // command sits at offset 0 with nothing to its left, and any
              // mention can wrap to the start of a line, where the space that
              // was supposed to absorb the overflow has been eaten by the break.
              // Neither is visible to CSS, so the icon simply stays inside.
              {...stylex.props(styles.icon)}
            >
              {chip.icon}
            </span>
          ) : null}
        </span>
      ) : null}
      {labelText ? <span>{labelText}</span> : null}
      {trailingText ? <span {...stylex.props(styles.hidden)}>{trailingText}</span> : null}
    </>
  );
}

const MentionHighlighter = React.memo(
  React.forwardRef<HighlighterElement, MentionHighlighterProps>((props, forwardedRef) => {
    const { style, renderValue, renderMentions, showText = false, ...highlighterProps } = props;
    const context = useMentionContext(HIGHLIGHTER_NAME);
    const highlighterRef = React.useRef<HighlighterElement>(null);
    const composedRef = useComposedRefs(forwardedRef, highlighterRef);
    const [inputStyle, setInputStyle] = React.useState<CSSStyleDeclaration>();
    const onInputStyleChangeCallback = useCallbackRef(setInputStyle);

    const onInputStyleChange = React.useCallback(() => {
      const inputElement = context.inputRef.current;
      if (!inputElement) return;

      const computedStyle = window.getComputedStyle(inputElement);
      onInputStyleChangeCallback(computedStyle);
    }, [context.inputRef, onInputStyleChangeCallback]);

    const onSyncScrollAndResize = React.useCallback(() => {
      const inputElement = context.inputRef.current;
      const highlighterElement = highlighterRef.current;

      if (!inputElement || !highlighterElement) return;

      requestAnimationFrame(() => {
        highlighterElement.scrollTop = inputElement.scrollTop;
        highlighterElement.scrollLeft = inputElement.scrollLeft;
        highlighterElement.style.height = `${inputElement.offsetHeight}px`;
      });
    }, [context.inputRef]);

    React.useLayoutEffect(() => {
      const inputElement = context.inputRef.current;
      if (!inputElement) return undefined;

      onInputStyleChange();

      function onResize() {
        onInputStyleChange();
        onSyncScrollAndResize();
      }

      // Create a ResizeObserver to listen for the input's size changes
      const cleanupResizeObserver = observeResizeOnAnimationFrame(inputElement, () => onResize());

      // Keep inherited theme/font changes and native control state in sync.
      const mutationObserver = new MutationObserver((mutations) => {
        if (mutations.some((m) => m.type === 'attributes')) {
          onResize();
        }
      });

      inputElement.addEventListener('scroll', onSyncScrollAndResize, {
        passive: true,
      });
      window.addEventListener('resize', onSyncScrollAndResize, {
        passive: true,
      });
      mutationObserver.observe(inputElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'readonly', 'wrap'],
      });
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });

      return () => {
        inputElement.removeEventListener('scroll', onSyncScrollAndResize);
        window.removeEventListener('resize', onSyncScrollAndResize);
        cleanupResizeObserver();
        mutationObserver.disconnect();
      };
    }, [context.inputRef, onInputStyleChange, onSyncScrollAndResize]);

    const highlighterStyle = React.useMemo<React.CSSProperties>(() => {
      if (!inputStyle) return defaultHighlighterStyle;

      return {
        ...defaultHighlighterStyle,
        color: showText ? inputStyle.color : 'transparent',
        opacity: inputStyle.opacity,
        fontStyle: inputStyle.fontStyle,
        fontVariant: inputStyle.fontVariant,
        fontWeight: inputStyle.fontWeight,
        fontSize: inputStyle.fontSize,
        lineHeight: inputStyle.lineHeight,
        fontFamily: inputStyle.fontFamily,
        letterSpacing: inputStyle.letterSpacing,
        textTransform: inputStyle.textTransform as React.CSSProperties['textTransform'],
        textIndent: inputStyle.textIndent,
        textAlign: inputStyle.textAlign as React.CSSProperties['textAlign'],
        tabSize: inputStyle.tabSize,
        whiteSpace: context.inputRef.current?.wrap === 'off' ? 'pre' : 'pre-wrap',
        padding: inputStyle.padding,
        borderWidth: inputStyle.borderWidth,
        borderStyle: inputStyle.borderStyle,
        borderColor: 'transparent',
        borderRadius: inputStyle.borderRadius,
        boxSizing: inputStyle.boxSizing as React.CSSProperties['boxSizing'],
        wordBreak: inputStyle.wordBreak as React.CSSProperties['wordBreak'],
        overflowWrap: inputStyle.overflowWrap as React.CSSProperties['overflowWrap'],
        direction: context.dir,
        ...style,
      };
    }, [inputStyle, style, context.dir, context.inputRef, showText]);

    const getMentionChip = context.getMentionChip;
    const mirroredValue = renderValue ?? context.inputValue;
    const mirroredMentions = renderMentions ?? context.mentions;
    const selection = useInputSelection(context.inputRef, showText);
    const onSegmentsRender = React.useCallback(
      () =>
        getMentionHighlightSegments(mirroredValue, mirroredMentions).map((segment) => {
          if (segment.type !== 'mention') {
            const start = segment.start;
            const from = selection ? Math.max(0, selection[0] - start) : 0;
            const to = selection ? Math.min(segment.text.length, selection[1] - start) : 0;
            return from < to ? (
              <span key={segment.key}>
                {segment.text.slice(0, from)}
                <span className={CHIP_SELECTED_CLASS_NAME}>{segment.text.slice(from, to)}</span>
                {segment.text.slice(to)}
              </span>
            ) : (
              <span key={segment.key}>{segment.text}</span>
            );
          }

          const chip = getMentionChip?.(segment.mention, segment.text) ?? null;
          // Hit testing reads the same ranges that paint the visible reference.
          const rangeProps = {
            'data-mention-start': segment.mention.start,
            'data-mention-end': segment.mention.end,
            'data-mention-kind': segment.mention.kind ?? 'mention',
            'data-mention-value': segment.mention.value,
          };

          const selected =
            !!selection &&
            selection[0] < segment.mention.end &&
            selection[1] > segment.mention.start;
          if (chip) {
            return (
              <span
                key={segment.key}
                {...rangeProps}
                data-selected={selected ? '' : undefined}
                className={clsx(
                  CHIP_CLASS_NAME,
                  chip.className,
                  selected && CHIP_SELECTED_CLASS_NAME
                )}
              >
                <MentionChipContent chip={chip} text={segment.text} />
              </span>
            );
          }

          return (
            <span
              key={segment.key}
              data-tag=""
              {...rangeProps}
              data-selected={selected ? '' : undefined}
              {...stylex.props(
                segment.mention.kind === 'pasted_text' ? styles.pastedHighlight : styles.highlight,
                selected && styles.selectedChip
              )}
            >
              {segment.text}
            </span>
          );
        }),
      [getMentionChip, mirroredMentions, mirroredValue, selection]
    );

    if (!inputStyle) return null;
    return (
      <div
        {...highlighterProps}
        ref={composedRef}
        dir={context.dir}
        data-mention-highlighter="true"
        data-mention-layer={showText ? 'text' : 'highlight'}
        aria-hidden="true"
        style={highlighterStyle}
      >
        {onSegmentsRender()}
      </div>
    );
  }),
  (prevProps, nextProps) =>
    prevProps.style === nextProps.style &&
    Object.keys(prevProps).every(
      (key) => prevProps[key as keyof typeof prevProps] === nextProps[key as keyof typeof nextProps]
    )
);

MentionHighlighter.displayName = HIGHLIGHTER_NAME;

export { MentionHighlighter };
