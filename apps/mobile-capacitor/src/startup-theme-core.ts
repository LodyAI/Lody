/**
 * Hides the native splash the moment the renderer has decided its theme.
 *
 * `capacitor.config.json` keeps the splash up past its default 500ms so the
 * bare WebView is never on screen while the bundle evaluates. The signal to
 * take it down is the theme class landing on `<html>` — not React's first
 * commit, which may be the router still resolving, and not a timer. The class
 * is applied in a layout effect, so the observer fires before that frame is
 * painted and the fade-out crosses onto a frame that is already the right color.
 *
 * Pure over its two effects so it runs under `node --test` without a DOM.
 */
export function releaseSplashOnTheme(
  root: { classList: { contains: (name: string) => boolean } },
  observe: (onMutation: () => void) => () => void,
  hide: () => void
): void {
  const themed = () => root.classList.contains('light') || root.classList.contains('dark');
  if (themed()) {
    hide();
    return;
  }
  const stop = observe(() => {
    if (!themed()) return;
    stop();
    hide();
  });
}
