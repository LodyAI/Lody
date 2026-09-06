import type { BrowserPageReference } from '@lody/shared';

export const OPEN_BROWSER_PAGE_REFERENCE_EVENT = 'lody:open-browser-reference';
let pending:
  | { reference: BrowserPageReference; pathname: string; navigationExpected: boolean }
  | undefined;
export function requestBrowserPageReferenceOpen(
  reference: BrowserPageReference,
  pathname: string
): void {
  pending = { reference, pathname, navigationExpected: false };
  window.dispatchEvent(new CustomEvent(OPEN_BROWSER_PAGE_REFERENCE_EVENT, { detail: reference }));
}
export function getPendingBrowserPageReference(pathname: string): BrowserPageReference | undefined {
  if (pending?.pathname !== pathname) return undefined;
  return pending.reference;
}
export function clearPendingBrowserPageReference(reference: BrowserPageReference): void {
  if (pending?.reference === reference) pending = undefined;
}
/** Authorize precisely one route transition to the resolved owner in the same workspace. */
export function prepareBrowserPageReferenceNavigation(
  reference: BrowserPageReference,
  pathname: string
): void {
  if (pending?.reference === reference) {
    pending = { reference, pathname, navigationExpected: true };
  }
}
export function handleBrowserPageReferenceNavigation(pathname: string): void {
  if (!pending) return;
  if (pending.navigationExpected && pending.pathname === pathname) {
    pending.navigationExpected = false;
  } else {
    pending = undefined;
  }
}
