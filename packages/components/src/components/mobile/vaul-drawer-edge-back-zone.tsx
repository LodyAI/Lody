import type { ReactNode } from 'react';

import * as stylex from '@stylexjs/stylex';
import { isNativeAppShell } from '@/lib/native-platform';
import { EDGE_ZONE_PX } from './mobile-edge-back-swipe';

const styles = stylex.create({
  zone: {
    position: 'absolute',
    left: 0,
    zIndex: 30,
  },
  body: {
    display: 'contents',
  },
});

export type VaulDrawerEdgeBackZoneProps = {
  /** Native app only. On web we leave back to the browser / route history, so
     we don't mount the strip and never fight iOS Safari's own edge-swipe
     (matches `MobileEdgeBackSwipeZone`). */
  isNativeApp: boolean;
  /** Distance from the top the strip starts at (any CSS length). The strip is
     the one place the drawer may start a drag, so it sits above content and
     must never overlap a header's back button (it would swallow the tap). Pass
     the header height — or header + tab-bar height — so it covers the body
     only. */
  topInset: string;
};

/**
 * The single invisible left-edge strip a full-screen Vaul `direction="right"`
 * drawer is allowed to start its drag-to-dismiss from — giving the native iOS
 * edge-pop: as soon as the swipe begins the panel follows the finger and the
 * layer beneath is revealed, committing or snapping back on release.
 *
 * WHY a bare strip instead of a gesture handler: vaul drags a right drawer on
 * *any* pointerdown unless the target has a `data-vaul-no-drag` ancestor (see
 * vaul's `shouldDrag`). So the drawer's content is wrapped in
 * `data-vaul-no-drag` (see `VaulDrawerBody`) and this bare, *unmarked* div is
 * mounted on top of it. A swipe that starts here gets vaul's full interactive
 * drag; a center pan lands on the no-drag content and just scrolls/pans (so
 * horizontally-scrollable code blocks, wide tables, and the no-drag-portaled
 * zoomed image viewer never fight dismissal). There is no handler here — vaul
 * owns the gesture, the animation, and the commit/snap-back. `touch-action:
 * pan-y` lets a vertical swipe through the strip scroll the content beneath
 * while a horizontal swipe drives the drag. `z-30` keeps it above content but
 * below overlays (sheets, the image viewer).
 *
 * Most callers want `VaulDrawerBody` (strip + no-drag wrapper together); this is
 * exported on its own for the story, which injects `isNativeApp`.
 */
export function VaulDrawerEdgeBackZone({ isNativeApp, topInset }: VaulDrawerEdgeBackZoneProps) {
  if (!isNativeApp) return null;

  return (
    <div
      aria-hidden="true"
      {...stylex.props(styles.zone)}
      style={{
        top: topInset,
        bottom: 0,
        width: EDGE_ZONE_PX,
        touchAction: 'pan-y',
      }}
    />
  );
}

/**
 * App-facing body wrapper for a full-screen Vaul `direction="right"` drawer:
 * mounts the edge-back strip and wraps the content in `data-vaul-no-drag` so
 * only an edge swipe (never a center pan) drives dismissal. Use this for every
 * such drawer instead of composing the strip and wrapper by hand — it keeps the
 * "strip + no-drag content" contract un-forgettable.
 *
 * `topInset` is the chrome height above the body (header, or header + tab bar)
 * so the strip never overlaps a back button. Native-only behaviour lives in
 * `VaulDrawerEdgeBackZone`: on web no strip is mounted (browser / route history
 * owns back) but the content stays `data-vaul-no-drag`, so there is no web
 * center-swipe-back.
 */
export function VaulDrawerBody({ topInset, children }: { topInset: string; children: ReactNode }) {
  return (
    <>
      <VaulDrawerEdgeBackZone isNativeApp={isNativeAppShell()} topInset={topInset} />
      <div data-vaul-no-drag {...stylex.props(styles.body)}>
        {children}
      </div>
    </>
  );
}
