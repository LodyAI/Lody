/**
 * Make the desktop app feel native by suppressing the browser's Tab focus-traversal on the
 * general app chrome. A native desktop window doesn't cycle a focus ring through every
 * clickable element the way a web page does.
 *
 * Tab is deliberately left untouched where it legitimately matters:
 *   - editable fields (input / textarea / select / contenteditable) so multi-field forms
 *     still move between fields, and
 *   - focus-trapped surfaces (dialogs, menus, listboxes, trees, the command palette) so modal
 *     keyboard accessibility keeps working (Radix moves focus programmatically inside these).
 *
 * Capture-phase + `preventDefault()` only cancels the default focus move; it does NOT stop
 * propagation, so any component that owns Tab still receives the event.
 *
 * Electron-only: this module is imported solely from the Electron renderer entry, so the web
 * build keeps standard browser Tab behavior.
 */
const INTERACTIVE_TAB_CONTEXT = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  'dialog',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="grid"]',
  '[role="tree"]',
  '[cmdk-root]',
  '[data-radix-focus-guard]'
].join(', ')

export function installNativeTabBehavior(): void {
  if (typeof window === 'undefined') return
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target instanceof Element && target.closest(INTERACTIVE_TAB_CONTEXT)) return
      // General app chrome: swallow the focus-traversal so it feels like a native window.
      event.preventDefault()
    },
    { capture: true }
  )
}
