import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius } from '@lody/ui/tokens/scales.stylex';
import { resolveAnchor } from '../tour/camera';

// A question asked where its answer will live.
//
// The panel is pinned to a REAL control in the product window — the run-config
// trigger, the sidebar's project list, the composer — and follows it every
// frame, so while the camera travels the panel travels with the thing it is
// about instead of waiting in a corner for the move to finish.

export type PanelPlacement =
  | 'above-start'
  | 'right-start'
  | 'below-start'
  | 'inside-top'
  | 'center'
  | 'dock';

const MARGIN = 20;

const styles = stylex.create({
  panel: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 20,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 'calc(100% - 40px)',
    backgroundColor: colors.raisedBackground,
    boxShadow: shadow.popover,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    willChange: 'transform',
    // Hidden until the first frame has placed it, so it never flashes at 0,0.
    visibility: 'hidden',
  },
  // Words set on the drawing itself: no card, no lift.
  bare: { backgroundColor: 'transparent', boxShadow: 'none' },
  leader: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    zIndex: 19,
    pointerEvents: 'none',
    overflow: 'visible',
    visibility: 'hidden',
  },
  leaderLine: {
    fill: 'none',
    stroke: colors.secondaryLabel,
    strokeWidth: 1,
    strokeLinecap: 'round',
    opacity: 0.7,
  },
  leaderDot: { fill: colors.raisedBackground, stroke: colors.secondaryLabel, strokeWidth: 1.25 },
});

export function AnchoredPanel({
  stageRef,
  anchor,
  placement,
  gap = 14,
  width: initialWidth,
  alignTo,
  offsetY = 0,
  bare = false,
  leaderTo,
  matchWidth,
  inset = 0,
  children,
}: {
  stageRef: RefObject<HTMLElement | null>;
  anchor: string;
  placement: PanelPlacement;
  gap?: number;
  /** A second anchor whose left edge the panel lines up with. */
  alignTo?: string;
  /** Moves the panel down from where its placement puts it, in stage pixels. */
  offsetY?: number;
  /** No card: words laid straight onto the drawing. */
  bare?: boolean;
  /**
   * The control this question configures. A pencil leader runs from the
   * panel's nearest edge to a small ring on it, so the question and the part
   * of the window it will ink are visibly one thing.
   */
  leaderTo?: string;
  /** Take the width of this anchor, so the panel and its control share edges. */
  matchWidth?: string;
  /** For `inside-top`: the gap kept from the anchor's sides. */
  inset?: number;
  width: number;
  children: ReactNode;
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    let frame = 0;
    let width = initialWidth;
    const place = (): void => {
      const stage = stageRef.current;
      const panel = panelRef.current;
      if (stage && panel) {
        const stageRect = stage.getBoundingClientRect();
        const target = resolveAnchor(stage, anchor)?.getBoundingClientRect();
        const aligned = alignTo ? resolveAnchor(stage, alignTo)?.getBoundingClientRect() : null;
        const matched = matchWidth
          ? resolveAnchor(stage, matchWidth)?.getBoundingClientRect()
          : null;
        if (matched) {
          width = matched.width - inset * 2;
          panel.style.width = `${width}px`;
        }
        const height = panel.offsetHeight;
        let left: number;
        let top: number;
        if (placement === 'dock' || !target) {
          left = (stageRect.width - width) / 2;
          top = stageRect.height - height - 28;
        } else if (placement === 'inside-top') {
          left = target.left - stageRect.left + inset;
          top = target.top - stageRect.top;
        } else if (placement === 'center') {
          left = target.left - stageRect.left + (target.width - width) / 2;
          top = target.top - stageRect.top + (target.height - height) / 2;
        } else if (placement === 'above-start') {
          left = target.left - stageRect.left - 6;
          top = target.top - stageRect.top - gap - height;
        } else if (placement === 'right-start') {
          left = target.right - stageRect.left + gap;
          top = target.top - stageRect.top;
        } else {
          left = target.left - stageRect.left;
          top = target.bottom - stageRect.top + gap;
        }
        if (aligned) left = aligned.left - stageRect.left;
        top += offsetY;
        // Content laid INSIDE a region of the window follows the window,
        // even to the stage's edge; everything else keeps the stage margin.
        if (placement !== 'inside-top') {
          left = Math.min(Math.max(MARGIN, left), stageRect.width - width - MARGIN);
          top = Math.min(Math.max(MARGIN, top), stageRect.height - height - MARGIN);
        }
        panel.style.transform = `translate3d(${left.toFixed(1)}px, ${top.toFixed(1)}px, 0)`;
        panel.style.visibility = 'visible';

        const leader = leaderRef.current;
        const control = leaderTo ? resolveAnchor(stage, leaderTo)?.getBoundingClientRect() : null;
        if (leader && control) {
          // The ring sits on the control's edge facing the panel, never on
          // its label.
          const cx = control.left - stageRect.left + control.width / 2;
          const above = top + height <= control.top - stageRect.top;
          const cy = above
            ? control.top - stageRect.top
            : control.top - stageRect.top + control.height / 2;
          // The nearest point of the panel's edge to the control.
          const px = Math.min(Math.max(cx, left + 12), left + width - 12);
          const py = Math.min(Math.max(cy, top), top + height);
          const line = leader.firstElementChild as SVGLineElement;
          const ring = leader.lastElementChild as SVGCircleElement;
          const inside = cx > left && cx < left + width && cy > top && cy < top + height;
          const ringRadius = 4;
          const length = Math.hypot(cx - px, cy - py);
          const ux = length > 0 ? (px - cx) / length : 0;
          const uy = length > 0 ? (py - cy) / length : 0;
          line.setAttribute('x1', (cx + ux * ringRadius).toFixed(1));
          line.setAttribute('y1', (cy + uy * ringRadius).toFixed(1));
          line.setAttribute('x2', px.toFixed(1));
          line.setAttribute('y2', py.toFixed(1));
          ring.setAttribute('cx', cx.toFixed(1));
          ring.setAttribute('cy', cy.toFixed(1));
          leader.style.visibility = inside || length < 8 ? 'hidden' : 'visible';
        }
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [
    alignTo,
    anchor,
    gap,
    initialWidth,
    inset,
    leaderTo,
    matchWidth,
    offsetY,
    placement,
    stageRef,
  ]);

  return (
    <>
      {leaderTo ? (
        <svg ref={leaderRef} aria-hidden {...stylex.props(styles.leader)}>
          <line {...stylex.props(styles.leaderLine)} />
          <circle r={4} {...stylex.props(styles.leaderDot)} />
        </svg>
      ) : null}
      <div
        ref={panelRef}
        {...stylex.props(styles.panel, bare && styles.bare)}
        style={{ width: initialWidth }}
      >
        {children}
      </div>
    </>
  );
}

/**
 * An input laid exactly over a real text field in the camera's window: same
 * box, same font, scaled with the shot. What is typed is mirrored into the
 * product's own composer, so the words appear in the real UI; this layer only
 * contributes the caret and the selection.
 */
export function FieldOverlay({
  stageRef,
  anchor,
  value,
  onChange,
  onSubmit,
  autoFocus,
}: {
  stageRef: RefObject<HTMLElement | null>;
  anchor: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  autoFocus?: boolean;
}): React.JSX.Element {
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    let frame = 0;
    let styled = false;
    const place = (): void => {
      const stage = stageRef.current;
      const field = fieldRef.current;
      const target = stage ? resolveAnchor(stage, anchor) : null;
      if (stage && field && target) {
        const stageRect = stage.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        const scale = rect.width / (target.offsetWidth || 1);
        if (!styled) {
          const source = getComputedStyle(target);
          for (const property of [
            'fontFamily',
            'fontSize',
            'fontWeight',
            'lineHeight',
            'letterSpacing',
            'paddingTop',
            'paddingRight',
            'paddingBottom',
            'paddingLeft',
            'textIndent',
          ] as const) {
            field.style[property] = source[property];
          }
          styled = true;
        }
        field.style.width = `${target.offsetWidth}px`;
        field.style.height = `${target.offsetHeight}px`;
        field.style.transform = `translate3d(${(rect.left - stageRect.left).toFixed(2)}px, ${(rect.top - stageRect.top).toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
        if (field.style.visibility !== 'visible') {
          field.style.visibility = 'visible';
          // A hidden field cannot take focus, so focus waits for the first
          // frame that has placed it.
          if (autoFocus) field.focus({ preventScroll: true });
        }
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [anchor, autoFocus, stageRef]);

  return (
    <textarea
      ref={fieldRef}
      value={value}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSubmit();
        }
      }}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        zIndex: 15,
        margin: 0,
        border: 0,
        outline: 'none',
        // The product's own field draws its focus; this layer adds no second ring.
        boxShadow: 'none',
        resize: 'none',
        overflow: 'hidden',
        background: 'transparent',
        color: 'transparent',
        caretColor: colors.label,
        transformOrigin: '0 0',
        visibility: 'hidden',
      }}
    />
  );
}

/**
 * A press target laid over a real control in the camera's window, so the
 * product's own button is the one that acts — the send arrow sends.
 */
export function PressOverlay({
  stageRef,
  anchor,
  label,
  onPress,
}: {
  stageRef: RefObject<HTMLElement | null>;
  anchor: string;
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    let frame = 0;
    const place = (): void => {
      const stage = stageRef.current;
      const button = buttonRef.current;
      const target = stage ? resolveAnchor(stage, anchor) : null;
      if (stage && button && target) {
        const stageRect = stage.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        button.style.width = `${rect.width}px`;
        button.style.height = `${rect.height}px`;
        button.style.transform = `translate3d(${(rect.left - stageRect.left).toFixed(2)}px, ${(rect.top - stageRect.top).toFixed(2)}px, 0)`;
        button.style.visibility = 'visible';
      }
      frame = requestAnimationFrame(place);
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [anchor, stageRef]);

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      onClick={onPress}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        zIndex: 15,
        margin: 0,
        padding: 0,
        border: 0,
        borderRadius: 9999,
        background: 'transparent',
        cursor: 'pointer',
        visibility: 'hidden',
      }}
    />
  );
}
