import { useCallback, useRef } from 'react';
import { useDrag } from '@use-gesture/react';
import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  zone: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
  },
});

/* Width of the left-edge strip where a back-swipe may begin. Kept
   generous (vs. the ~20px iOS system edge) because users reported the
   gesture felt unreachable when it required starting at the very
   screen edge. Widening the start zone is safe: the gesture still only
   commits on a deliberate rightward drag and bails on vertical drift,
   so a wider strip doesn't steal scrolls or taps. */
export const EDGE_ZONE_PX = 48;
const MIN_DISTANCE_PX = 80;
const MAX_VERTICAL_DRIFT_PX = 52;
const VELOCITY_THRESHOLD = 0.45;

export type MobileEdgeBackSwipeZoneProps = {
  /** Only enable inside the native app. On web we let the browser /
     route history own back navigation so our gesture doesn't fight
     iOS Safari's edge-swipe. */
  isNativeApp: boolean;
  /** Fires once when the user completes a left→right swipe that
     started inside the left-edge strip (see EDGE_ZONE_PX). */
  onBack: () => void;
  /** Stacking order. The strip sits above the page content so it
     captures the touch before any underlying tap handler does — but
     the strip is invisible and narrow, so it doesn't steal anything
     actually useful from the user. */
  zIndex?: number;
};

/**
 * Renders an invisible overlay strip along the left edge (EDGE_ZONE_PX
 * wide) that detects iOS-style "swipe right from the left edge to go back"
 * gestures and calls `onBack`. Mounts only when `isNativeApp` is
 * true; on web it returns `null`.
 *
 * Use this from any mobile detail page that's reached by tapping
 * into a list — settings, project detail, session detail. The host
 * must be `position: relative` so the strip can absolutely-position
 * to its left edge.
 */
export function MobileEdgeBackSwipeZone({
  isNativeApp,
  onBack,
  zIndex = 10,
}: MobileEdgeBackSwipeZoneProps) {
  const edgeSwipeStartXRef = useRef<number | null>(null);

  const handleBack = useCallback(() => {
    onBack();
  }, [onBack]);

  const bindBackSwipe = useDrag(
    ({
      first,
      last,
      movement: [movementX, movementY],
      direction: [directionX],
      velocity: [vx],
      xy: [currentX],
      cancel,
      event,
    }) => {
      if (first) {
        edgeSwipeStartXRef.current = currentX;
        if (currentX > EDGE_ZONE_PX) {
          cancel();
          edgeSwipeStartXRef.current = null;
          return;
        }
      }

      if (edgeSwipeStartXRef.current == null) return;

      /* Wrong-way drag → bail. We only commit on rightward swipes
         that originated at the left edge. */
      if (movementX < 0) {
        cancel();
        edgeSwipeStartXRef.current = null;
        return;
      }

      /* If the user's drag is dominantly vertical, treat it as a
         scroll attempt and bail so the underlying list can scroll. */
      if (
        Math.abs(movementY) > MAX_VERTICAL_DRIFT_PX &&
        Math.abs(movementY) > Math.abs(movementX)
      ) {
        cancel();
        edgeSwipeStartXRef.current = null;
        return;
      }

      /* Once the drag is committedly horizontal, preventDefault so
         nothing underneath (a horizontally-scrollable list, an
         <input> cursor placement) tries to claim the touch. */
      if (movementX > 8) {
        event.preventDefault();
      }

      if (!last) return;

      edgeSwipeStartXRef.current = null;
      const shouldNavigateBack =
        movementX >= MIN_DISTANCE_PX ||
        (directionX > 0 && vx >= VELOCITY_THRESHOLD && movementX >= MIN_DISTANCE_PX * 0.3);

      if (shouldNavigateBack) {
        handleBack();
      }
    },
    {
      axis: 'x',
      filterTaps: true,
      pointer: { touch: true },
      eventOptions: { passive: false },
    }
  );

  if (!isNativeApp) return null;

  return (
    <div
      {...stylex.props(styles.zone)}
      style={{ width: EDGE_ZONE_PX, touchAction: 'pan-y', zIndex }}
      aria-hidden="true"
      {...bindBackSwipe()}
    />
  );
}
