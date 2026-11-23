import { useEffect, useMemo, useRef, type CSSProperties, type RefObject } from 'react';

/**
 * Keeps the focused control inside a scroll container visible above the native
 * soft keyboard.
 *
 * On iOS Capacitor the WebView is NOT resized when the keyboard opens
 * (`resize: "none"` + `interactive-widget=overlaps-content`), so the browser's
 * default focus-scroll can leave the focused input — or the controls just below
 * it — hidden behind the keyboard. Sheets lift themselves via
 * `bottom-[var(--native-keyboard-height)]` and cap their scroll height to the
 * visible region; this hook then pulls the focused element to the CENTER of
 * that region. Centering (rather than `nearest`/`end`) is deliberate: it leaves
 * room below the focused field so a trailing cluster (e.g. the new-chat agent +
 * permission row that sits under the composer) also clears the keyboard.
 *
 * Fires on:
 *   - `lody:keyboard-resize` with height > 0 (keyboard opening), and
 *   - focus moving between fields while the keyboard is already up.
 *
 * Web is a no-op because the native shell does not dispatch this event there.
 * Android keeps `--native-keyboard-height` at `0px`; its native shell still
 * dispatches `lody:keyboard-resize`, so this hook may recenter on that event.
 * Shells can resize the WebView or overlay the keyboard. Non-iOS side drawers
 * handle both through the live viewport inset in `ui/drawer.tsx`.
 *
 * Listeners are bound to `window` / `document` (not the container) and read
 * `containerRef.current` lazily at event time, so the hook works even when the
 * container mounts later (e.g. a drawer that only renders its content when open).
 */
export function useKeyboardAwareScrollIntoView(containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const scrollActiveIntoView = () => {
      const container = containerRef.current;
      const active = document.activeElement;
      if (!container || !(active instanceof HTMLElement) || !container.contains(active)) {
        return;
      }
      // Two rAFs so the keyboard var + the sheet/dialog height reflow land
      // before we measure; otherwise we would target stale container geometry.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (document.activeElement === active) {
            const containerRect = container.getBoundingClientRect();
            const activeRect = active.getBoundingClientRect();
            const targetTop =
              container.scrollTop +
              activeRect.top +
              activeRect.height / 2 -
              (containerRect.top + containerRect.height / 2);
            const maxScrollTop = container.scrollHeight - container.clientHeight;
            container.scrollTop = Math.max(0, Math.min(targetTop, maxScrollTop));
          }
        });
      });
    };

    const handleKeyboardResize = (event: Event) => {
      const detail = (event as CustomEvent<{ height?: number }>).detail;
      if ((detail?.height ?? 0) > 0) scrollActiveIntoView();
    };

    const handleFocusIn = (event: FocusEvent) => {
      // Cheap check first: this listener is on `document`, and several of these
      // sheets are mounted for the whole session view, so every focus change in
      // the app reaches every one of them. Only the sheet that owns the focused
      // field should go on to read a computed style.
      const container = containerRef.current;
      const target = event.target;
      if (!container || !(target instanceof Node) || !container.contains(target)) return;
      // Only act when the keyboard is already up; otherwise the keyboard-resize
      // event drives the scroll once it opens (focusin fires before the keyboard,
      // when the layout is still full-height).
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue('--native-keyboard-height')
        .trim();
      if (raw && parseFloat(raw) > 0) scrollActiveIntoView();
    };

    window.addEventListener('lody:keyboard-resize', handleKeyboardResize);
    document.addEventListener('focusin', handleFocusIn);
    return () => {
      window.removeEventListener('lody:keyboard-resize', handleKeyboardResize);
      document.removeEventListener('focusin', handleFocusIn);
    };
  }, [containerRef]);
}

/* One lift for every sheet that can put a field on screen. */
const KEYBOARD_LIFT_CLASS = 'bottom-[var(--native-keyboard-height,0px)]!';

export type KeyboardAwareSheet = {
  /** Goes on the sheet's scrolling body, which the hook keeps focus centered in. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Goes on the drawer/dialog content: lifts the whole sheet off the keyboard. */
  contentClassName: string;
  /** Goes on the scrolling body: caps it to the visible region and pads it. */
  scrollStyle: CSSProperties;
};

/**
 * The whole native-keyboard contract for a bottom sheet, in one call.
 *
 * vaul portals a drawer out of the layout, so the root's global
 * `pb-[var(--native-keyboard-height)]` never reaches it, and each sheet has to
 * (1) lift itself by the keyboard height, (2) cap its scroll area to what is
 * still visible — without the cap there is nothing to center inside — and
 * (3) center the focused field in that area. Three parts that only work
 * together, which is exactly why they should not be three things to remember:
 * sheets that copied two of the three exist, and they misbehave on iOS.
 *
 * The CSS keyboard lift is zero on web and Android because
 * `--native-keyboard-height` stays `0px`; it is used by iOS Capacitor.
 * Android can still recenter fields through the native resize event. This
 * bottom-sheet helper is separate from side-drawer viewport handling.
 *
 * The lift is deliberately NOT transitioned: the sheet's height is driven by
 * `scrollStyle`'s `maxHeight`, which reacts to the keyboard var instantly, so
 * animating `bottom` would drop the sheet's top for a frame and slide it back.
 */
export function useKeyboardAwareSheet({
  /** Height of the sheet chrome above the scroll body (grabber + header). */
  chromeHeight = '3.25rem',
  /** The body's own bottom padding, before the safe area is folded in. */
  bodyPadding = '16px',
}: { chromeHeight?: string; bodyPadding?: string } = {}): KeyboardAwareSheet {
  const scrollRef = useRef<HTMLDivElement>(null);
  useKeyboardAwareScrollIntoView(scrollRef);

  return useMemo(
    () => ({
      scrollRef,
      contentClassName: KEYBOARD_LIFT_CLASS,
      scrollStyle: {
        maxHeight: `calc(100dvh - var(--native-keyboard-height, 0px) - ${chromeHeight})`,
        // The safe area is already covered by the keyboard once it is up, so
        // paying for both would leave a gap under the sheet.
        paddingBottom: `calc(${bodyPadding} + max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px)))`,
      },
    }),
    [bodyPadding, chromeHeight]
  );
}
