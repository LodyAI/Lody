/**
 * Check if current path is a settings route.
 */
export function isSettingsRoute(pathname: string): boolean {
  return /^\/[^/]+\/settings(\/|$)/.test(pathname);
}

/**
 * Tailwind classes that shift a layout root above the native soft keyboard.
 *
 * `--native-keyboard-height` defaults to `0px` (tailwind/index.css `:root`) and
 * is only updated to a non-zero value by `@capacitor/keyboard` in the iOS
 * native shell (apps/mobile/src/native-keyboard.ts), so this is a no-op on web
 * and Android — where the keyboard is instead handled by viewport/WebView
 * resizing.
 *
 * Shared by BOTH the mobile root layout and the desktop/web layout: the iPad
 * native shell renders the desktop layout (viewport width ≥ 768) yet still
 * needs the offset, because native viewport meta is `overlaps-content` so
 * `h-svh` does NOT shrink when the keyboard opens. Applying it on web/Android
 * is safe (var is `0px`), so there is no double offset when the viewport/WebView
 * already shrank.
 */
export const NATIVE_KEYBOARD_OFFSET_CLASS =
  'pb-[var(--native-keyboard-height)] transition-[padding-bottom] duration-[250ms] ease-out';

/**
 * Tailwind classes that inset a full-viewport layout root out of the device
 * safe area at the top and sides (iPadOS status bar, display cutouts).
 *
 * The `--safe-area-*` variables resolve to `env(safe-area-inset-*)`
 * (tailwind/index.css `:root`), which is `0px` on desktop and in any window
 * that does not extend under system chrome — so this is a no-op on Electron and
 * the browser, and it collapses on its own in Split View / Stage Manager, where
 * iPadOS reports no inset.
 *
 * The desktop/web layout needs it because the iPad native shell renders THIS
 * layout (viewport width ≥ 768, `detectAppDeviceClass()` is `tablet`) with
 * `viewport-fit=cover`: without the inset the sidebar header and the session
 * chrome are drawn edge-to-edge and share their first row with the system
 * status bar. The mobile layout deliberately does not use this, because its
 * surfaces inset their own headers.
 *
 * Top and sides only. The bottom safe area belongs to whichever surface sits
 * against it — the composer shell
 * (`getSessionChatInputAreaShellClassName`) already pads itself by
 * `env(safe-area-inset-bottom)`, and padding the root as well would double it.
 */
export const LAYOUT_SAFE_AREA_INSET_CLASS =
  'pt-[var(--safe-area-top)] pl-[var(--safe-area-left)] pr-[var(--safe-area-right)]';

/**
 * Returns the root container className for the desktop/web workspace layout.
 *
 * Settings routes render a single pane and position the Electron window drag
 * strip against this root, hence the extra `relative`.
 *
 * Shared between production code and tests to keep the two roots' viewport
 * handling (safe area, native keyboard offset) in sync.
 */
export function getWebWorkspaceLayoutRootClassName({
  settingsRoute,
}: { settingsRoute?: boolean } = {}): string {
  return [
    settingsRoute ? 'relative' : undefined,
    'flex h-svh w-full overflow-hidden bg-background',
    LAYOUT_SAFE_AREA_INSET_CLASS,
    NATIVE_KEYBOARD_OFFSET_CLASS,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Returns the root container className for the mobile workspace layout.
 *
 * Uses `h-full` so the container height matches the parent (#root) exactly.
 * On iOS Safari with `viewport-fit=cover`, `100dvh` can be larger than the
 * `height: 100%` on #root (which resolves to the standard viewport height).
 * Because #root has `overflow: hidden`, any height exceeding it gets clipped.
 *
 * - **Web**: combined with `interactive-widget=resizes-content`, `h-full`
 *   still tracks keyboard open/close because the browser resizes the ICB
 *   (initial containing block), which propagates through the 100% chain.
 * - **iOS Native (Capacitor)**: uses `interactive-widget=overlaps-content` +
 *   `@capacitor/keyboard` with `resize: "none"`. The layout does NOT shrink
 *   automatically; instead, this root container adds `pb-[var(--native-keyboard-height)]`
 *   so the entire content area shifts above the keyboard.
 * - **Android Native (Capacitor)**: `resize` is not supported by the Keyboard
 *   plugin, so the WebView handles keyboard resize and this var stays `0px`.
 *
 * Shared between production code and Storybook stories to keep them in sync.
 */
export function getMobileMainLayoutRootClassName(): string {
  return `flex h-full w-full overflow-hidden ${NATIVE_KEYBOARD_OFFSET_CLASS}`;
}

/**
 * Returns the content wrapper className for the mobile workspace layout.
 */
export function getMobileMainLayoutContentClassName(): string {
  return 'flex-1 flex flex-col overflow-hidden';
}
