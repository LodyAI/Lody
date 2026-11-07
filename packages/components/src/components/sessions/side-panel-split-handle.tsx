import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import * as stylex from '@stylexjs/stylex';

/** Each side of a split keeps at least a quarter of the panel. */
export const SIDE_PANEL_SPLIT_RATIO_MIN = 0.25;
export const SIDE_PANEL_SPLIT_RATIO_MAX = 0.75;
export const SIDE_PANEL_SPLIT_RATIO_DEFAULT = 0.5;
const KEYBOARD_STEP = 0.05;

/** The CSS variable both split halves and this handle position against. */
export const SIDE_PANEL_SPLIT_RATIO_VAR = '--side-panel-split';

export const clampSidePanelSplitRatio = (ratio: number): number =>
  Number.isFinite(ratio)
    ? Math.min(SIDE_PANEL_SPLIT_RATIO_MAX, Math.max(SIDE_PANEL_SPLIT_RATIO_MIN, ratio))
    : SIDE_PANEL_SPLIT_RATIO_DEFAULT;

const styles = stylex.create({
  // The seam is the end panel's own hairline; like the conversation/panel
  // handle, this paints nothing at rest and reveals one ink block on hover,
  // a taller darker one on focus, and the darkest while dragging.
  handle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: `calc(var(${SIDE_PANEL_SPLIT_RATIO_VAR}, 0.5) * 100%)`,
    zIndex: 2,
    display: 'flex',
    width: '24px',
    marginInlineStart: '-12px',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'col-resize',
    touchAction: 'none',
    outline: 'none',
  },
  ink: {
    width: '3px',
    height: '28px',
    flexShrink: 0,
    borderRadius: '9999px',
    pointerEvents: 'none',
    backgroundColor: 'hsl(var(--foreground) / 0.3)',
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':focus-visible')]: 1,
    },
    transitionProperty: 'background-color, opacity, scale',
    transitionDuration: '150ms',
  },
  inkFocus: {
    backgroundColor: {
      default: null,
      [stylex.when.ancestor(':focus-visible')]: 'hsl(var(--foreground) / 0.5)',
    },
    scale: {
      default: null,
      [stylex.when.ancestor(':focus-visible')]: '1 1.25',
    },
  },
  inkDragging: {
    opacity: 1,
    scale: '1 1.25',
    backgroundColor: 'hsl(var(--foreground) / 0.7)',
  },
  // Device screens are iframes; without a shield above them a fast drag
  // crosses into one and the iframe swallows the pointer.
  dragShield: {
    position: 'absolute',
    inset: 0,
    zIndex: 1,
    cursor: 'col-resize',
  },
});

/**
 * The divider between two split side-panel tabs. Its parent must be the
 * positioned box both halves fill and must define `SIDE_PANEL_SPLIT_RATIO_VAR`.
 */
export function SidePanelSplitHandle({
  ratio,
  label,
  onRatioChange,
  onDraggingChange,
}: {
  ratio: number;
  label: string;
  onRatioChange: (ratio: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const setDraggingState = (next: boolean) => {
    setDragging(next);
    onDraggingChange?.(next);
  };
  const ratioAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect || rect.width === 0) return ratio;
    return clampSidePanelSplitRatio((event.clientX - rect.left) / rect.width);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingState(false);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? ratio - KEYBOARD_STEP
        : event.key === 'ArrowRight'
          ? ratio + KEYBOARD_STEP
          : event.key === 'Home'
            ? SIDE_PANEL_SPLIT_RATIO_MIN
            : event.key === 'End'
              ? SIDE_PANEL_SPLIT_RATIO_MAX
              : null;
    if (next === null) return;
    event.preventDefault();
    onRatioChange(clampSidePanelSplitRatio(next));
  };

  return (
    <>
      {dragging ? <div aria-hidden {...stylex.props(styles.dragShield)} /> : null}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuemin={Math.round(SIDE_PANEL_SPLIT_RATIO_MIN * 100)}
        aria-valuemax={Math.round(SIDE_PANEL_SPLIT_RATIO_MAX * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        {...stylex.props(stylex.defaultMarker(), styles.handle)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDraggingState(true);
        }}
        onPointerMove={(event) => {
          if (dragging) onRatioChange(ratioAt(event));
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => {
          if (dragging) setDraggingState(false);
        }}
        onDoubleClick={() => onRatioChange(SIDE_PANEL_SPLIT_RATIO_DEFAULT)}
        onKeyDown={handleKeyDown}
      >
        <span {...stylex.props(styles.ink, styles.inkFocus, dragging && styles.inkDragging)} />
      </div>
    </>
  );
}
