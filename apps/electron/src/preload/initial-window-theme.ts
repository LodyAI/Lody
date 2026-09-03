import type { InitialWindowTheme } from '../initial-window-theme-argument'

type DocumentObserver = {
  observe: (target: Document, options: { childList: boolean; subtree: boolean }) => void
  disconnect: () => void
}

const createDocumentObserver = (onMutation: () => void): DocumentObserver =>
  new MutationObserver(onMutation) as unknown as DocumentObserver

/**
 * Marks `<html>` with the theme main already resolved, before the first paint.
 *
 * Preload runs at document start, where `document.documentElement` is still
 * null and `readyState` is `loading` — measured on Electron 39, the version
 * this app ships: `{ readyState: 'loading', hasDocumentElement: false,
 * childCount: 0 }`. So there is nothing to mark yet, and observing the document
 * is the only path, not a fallback. The observer fires as a microtask the
 * instant the parser inserts the element, still during parsing.
 *
 * Waiting for `DOMContentLoaded` instead would be too late: `index.html` loads
 * the app as a module script, so Chromium is free to paint the parsed body
 * first, and `tailwind/index.css` paints `body` from this very class.
 */
export function installInitialWindowThemeClass(
  target: Document,
  theme: InitialWindowTheme,
  createObserver: (onMutation: () => void) => DocumentObserver = createDocumentObserver
): void {
  const observer = createObserver(() => {
    const root = target.documentElement
    if (!root) {
      return
    }
    // Mirrors what `theme-provider.tsx` applies on mount, so the two agree.
    root.classList.add(theme)
    root.style.colorScheme = theme
    observer.disconnect()
  })
  observer.observe(target, { childList: true, subtree: true })
}
