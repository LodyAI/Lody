import type { InitialWindowTheme } from '../initial-window-theme-argument'

type DocumentObserver = {
  observe: (target: Document, options: { childList: boolean; subtree: boolean }) => void
  disconnect: () => void
}

const createDocumentObserver = (onMutation: () => void): DocumentObserver =>
  new MutationObserver(onMutation) as unknown as DocumentObserver

/**
 * Puts the resolved theme class on `<html>` if the element exists yet.
 *
 * Mirrors what `theme-provider.tsx` applies on mount (the `light`/`dark` class
 * plus `color-scheme`) so the two never disagree. A class already present means
 * something later in the boot has spoken, and this must not overrule it.
 *
 * Returns whether the document was ready, so the caller knows to wait.
 */
export function applyInitialWindowThemeClass(target: Document, theme: InitialWindowTheme): boolean {
  const root = target.documentElement
  if (!root) {
    return false
  }
  if (!root.classList.contains('light') && !root.classList.contains('dark')) {
    root.classList.add(theme)
    root.style.colorScheme = theme
  }
  return true
}

/**
 * Applies the theme class as early in the document's life as it can be applied.
 *
 * Preload runs before the parser has produced anything, so `documentElement`
 * may not exist on the first line. Observing the document catches the element
 * the instant the parser inserts it — a microtask during parsing, still well
 * before the first paint. Waiting for `DOMContentLoaded` instead would be too
 * late: `index.html` loads the app as a module script, so Chromium is free to
 * paint the already-parsed (and, without this, light) body while that bundle is
 * still being fetched and evaluated.
 */
export function installInitialWindowThemeClass(
  target: Document,
  theme: InitialWindowTheme,
  createObserver: (onMutation: () => void) => DocumentObserver = createDocumentObserver
): void {
  if (applyInitialWindowThemeClass(target, theme)) {
    return
  }

  const observer = createObserver(() => {
    if (applyInitialWindowThemeClass(target, theme)) {
      observer.disconnect()
    }
  })
  observer.observe(target, { childList: true, subtree: true })
}
