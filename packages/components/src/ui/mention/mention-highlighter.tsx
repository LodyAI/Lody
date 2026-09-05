import { useCallbackRef, useComposedRefs } from '@diceui/shared';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { type Mention, type MentionChip, useMentionContext } from './mention-root';

const HIGHLIGHTER_NAME = 'MentionHighlighter';

type HighlighterElement = HTMLDivElement;

/**
 * Which of the two mirrors this instance is.
 *
 * `background` sits *under* the textarea and tints ranges through the real
 * glyphs — the plain highlight. `chip` sits *over* it and paints opaque chips
 * that hide the raw characters they replace, which is the only way to show an
 * icon and a chip-specific text colour without giving up the native textarea.
 * At a mention boundary MentionInput temporarily raises the textarea above
 * `chip`, so `background` carries the text while the native caret remains on
 * top. Both mirrors render the identical character stream, so they agree on
 * every line break and the caret stays aligned with both.
 */
type MentionHighlighterLayer = 'background' | 'chip';

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
  layer?: MentionHighlighterLayer;
  /** Text rendered by this mirror; IME preedit may lead the committed context value. */
  renderValue?: string;
  /** Ranges addressing `renderValue`; defaults to the committed context ranges. */
  renderMentions?: readonly Mention[];
  /** Make the background mirror carry the textarea's visible text. */
  showText?: boolean;
}

type MentionHighlightSegment =
  | {
      type: 'text' | 'space';
      key: string;
      text: string;
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
      key: `text-end-${value.length}`,
      text: value.slice(lastIndex),
    });
  }

  segments.push({ type: 'space', key: 'space', text: '\u00a0' });
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
 * defaults to the input colour; a composer on a different surface must say so,
 * or its mentions will show as faint rectangles.
 */
const CHIP_CLASS_NAME = 'box-decoration-clone bg-[var(--mention-chip-surface,hsl(var(--input)))]';

/**
 * Selection is the one case that still needs a fill: the surface cover also
 * hides the textarea's own selection highlight, so the range has to repaint it.
 * The system colour goes on as a background *image* over the opaque surface
 * *colour*, because `Highlight` is `rgba(0, 65, 198, 0.8)` in Chrome — used
 * alone it would be translucent enough to let the covered glyphs back through.
 */
const CHIP_SELECTED_CLASS_NAME =
  'bg-[image:linear-gradient(Highlight,Highlight)] !text-[HighlightText]';

/**
 * The textarea's selection range, tracked only while chips are painted.
 * `selectionchange` fires on the document for textarea selections in every
 * engine we ship on; `select` alone misses caret-only moves. Collapsed ranges
 * do not need to rerender the chip mirror: the native caret is raised above
 * the chip at a mention boundary by MentionInput.
 */
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
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
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
        <span className="invisible relative">
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
              className="visible absolute inset-y-0 left-0 right-px flex items-center justify-end [&>*]:max-w-full"
            >
              {chip.icon}
            </span>
          ) : null}
        </span>
      ) : null}
      {labelText ? <span>{labelText}</span> : null}
      {trailingText ? <span className="invisible">{trailingText}</span> : null}
    </>
  );
}

const MentionHighlighter = React.memo(
  React.forwardRef<HighlighterElement, MentionHighlighterProps>((props, forwardedRef) => {
    const {
      style,
      layer = 'background',
      renderValue,
      renderMentions,
      showText = false,
      ...highlighterProps
    } = props;
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

    React.useEffect(() => {
      const inputElement = context.inputRef.current;
      if (!inputElement) return undefined;

      onInputStyleChange();

      function onResize() {
        onInputStyleChange();
        onSyncScrollAndResize();
      }

      // Create a ResizeObserver to listen for the input's size changes
      const cleanupResizeObserver = observeResizeOnAnimationFrame(inputElement, () => onResize());

      // Create a MutationObserver to listen for the input's class changes
      const mutationObserver = new MutationObserver((mutations) => {
        if (mutations.some((m) => m.type === 'attributes' && m.attributeName === 'class')) {
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
        attributeFilter: ['class'],
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
        // Usually above the textarea: an opaque chip has to cover the raw
        // characters it stands in for. At a caret boundary MentionInput raises
        // the textarea above this layer. `pointer-events: none` keeps the
        // textarea clickable in either order.
        zIndex: layer === 'chip' ? 20 : defaultHighlighterStyle.zIndex,
        color: layer === 'background' && showText ? inputStyle.color : 'transparent',
        fontStyle: inputStyle.fontStyle,
        fontVariant: inputStyle.fontVariant,
        fontWeight: inputStyle.fontWeight,
        fontSize: inputStyle.fontSize,
        lineHeight: inputStyle.lineHeight,
        fontFamily: inputStyle.fontFamily,
        letterSpacing: inputStyle.letterSpacing,
        textTransform: inputStyle.textTransform as React.CSSProperties['textTransform'],
        textIndent: inputStyle.textIndent,
        padding: inputStyle.padding,
        borderWidth: inputStyle.borderWidth,
        borderStyle: inputStyle.borderStyle,
        borderColor: 'currentColor',
        borderRadius: inputStyle.borderRadius,
        boxSizing: inputStyle.boxSizing as React.CSSProperties['boxSizing'],
        wordBreak: inputStyle.wordBreak as React.CSSProperties['wordBreak'],
        overflowWrap: inputStyle.overflowWrap as React.CSSProperties['overflowWrap'],
        direction: context.dir,
        ...style,
      };
    }, [inputStyle, style, context.dir, layer, showText]);

    const getMentionChip = context.getMentionChip;
    const mirroredValue = renderValue ?? context.inputValue;
    const mirroredMentions = renderMentions ?? context.mentions;
    const selection = useInputSelection(context.inputRef, layer === 'chip' && !!getMentionChip);
    const onSegmentsRender = React.useCallback(
      () =>
        getMentionHighlightSegments(mirroredValue, mirroredMentions).map((segment) => {
          if (segment.type !== 'mention') {
            return <span key={segment.key}>{segment.text}</span>;
          }

          const chip = getMentionChip?.(segment.mention, segment.text) ?? null;
          // Data attributes go on both mirrors so click hit-testing finds the
          // range whichever mirror it reaches first.
          const rangeProps = {
            'data-mention-start': segment.mention.start,
            'data-mention-end': segment.mention.end,
            'data-mention-kind': segment.mention.kind ?? 'mention',
            'data-mention-value': segment.mention.value,
          };

          if (chip) {
            // A chip is painted once, by the chip mirror. The background mirror
            // still has to emit the characters — they carry the line breaks —
            // but must not tint them, or the tint shows through the chip.
            const selected =
              !!selection &&
              selection[0] < segment.mention.end &&
              selection[1] > segment.mention.start;
            return layer === 'chip' ? (
              <span
                key={segment.key}
                {...rangeProps}
                data-selected={selected ? '' : undefined}
                className={cn(
                  CHIP_CLASS_NAME,
                  chip.className,
                  selected && CHIP_SELECTED_CLASS_NAME
                )}
              >
                <MentionChipContent chip={chip} text={segment.text} />
              </span>
            ) : (
              <span key={segment.key} {...rangeProps}>
                {segment.text}
              </span>
            );
          }

          // Plain highlights belong to the background mirror only.
          if (layer === 'chip') {
            return <span key={segment.key}>{segment.text}</span>;
          }

          return (
            <span
              key={segment.key}
              data-tag=""
              {...rangeProps}
              className={
                segment.mention.kind === 'pasted_text'
                  ? 'rounded-md bg-foreground/10 box-decoration-clone'
                  : 'rounded-sm bg-primary/15 box-decoration-clone'
              }
            >
              {segment.text}
            </span>
          );
        }),
      [getMentionChip, layer, mirroredMentions, mirroredValue, selection]
    );

    if (!inputStyle) return null;
    return (
      <div
        {...highlighterProps}
        ref={composedRef}
        dir={context.dir}
        data-mention-highlighter="true"
        data-mention-layer={layer}
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
