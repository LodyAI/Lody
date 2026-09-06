// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserPageReference } from '@lody/shared';
import {
  clearPendingBrowserPageReference,
  getPendingBrowserPageReference,
  OPEN_BROWSER_PAGE_REFERENCE_EVENT,
  requestBrowserPageReferenceOpen,
  prepareBrowserPageReferenceNavigation,
  handleBrowserPageReferenceNavigation,
} from '../src/lib/browser-page-reference';

const page = (sessionId: string): BrowserPageReference => ({
  version: 1,
  machineId: 'machine',
  sessionId,
  url: 'http://localhost:3000/docs#intro',
});
afterEach(() => {
  const pending = getPendingBrowserPageReference('/workspace-a/sessions/source');
  if (pending) clearPendingBrowserPageReference(pending);
});
describe('browser reference navigation handoff', () => {
  it('keeps the original destination available while the owner route mounts', () => {
    const reference = page('owner');
    let observed: BrowserPageReference | undefined;
    const listener = () => {
      observed = getPendingBrowserPageReference('/workspace-a/sessions/source');
    };
    window.addEventListener(OPEN_BROWSER_PAGE_REFERENCE_EVENT, listener);
    try {
      requestBrowserPageReferenceOpen(reference, '/workspace-a/sessions/source');
      expect(observed).toEqual(reference);
      expect(getPendingBrowserPageReference('/workspace-a/sessions/source')?.url).toBe(
        'http://localhost:3000/docs#intro'
      );
      clearPendingBrowserPageReference(reference);
      expect(getPendingBrowserPageReference('/workspace-a/sessions/source')).toBeUndefined();
    } finally {
      window.removeEventListener(OPEN_BROWSER_PAGE_REFERENCE_EVENT, listener);
    }
  });
  it('does not let an older route consume a newer navigation request', () => {
    const old = page('old');
    const current = page('current');
    requestBrowserPageReferenceOpen(old, '/workspace-a/sessions/source');
    requestBrowserPageReferenceOpen(current, '/workspace-a/sessions/source');
    clearPendingBrowserPageReference(old);
    expect(getPendingBrowserPageReference('/workspace-a/sessions/source')).toEqual(current);
  });
});

describe('browser reference route scope', () => {
  it('only exposes a handoff on its explicitly resolved destination', () => {
    const reference = page('owner');
    requestBrowserPageReferenceOpen(reference, '/workspace-a/sessions/source');
    prepareBrowserPageReferenceNavigation(reference, '/workspace-a/sessions/owner');
    expect(getPendingBrowserPageReference('/workspace-b/sessions/owner')).toBeUndefined();
    handleBrowserPageReferenceNavigation('/workspace-a/sessions/owner');
    expect(getPendingBrowserPageReference('/workspace-a/sessions/owner')).toBe(reference);
    clearPendingBrowserPageReference(reference);
  });
  it('cancels the handoff when navigation switches workspace', () => {
    const reference = page('owner');
    requestBrowserPageReferenceOpen(reference, '/workspace-a/sessions/source');
    prepareBrowserPageReferenceNavigation(reference, '/workspace-a/sessions/owner');
    handleBrowserPageReferenceNavigation('/workspace-b/sessions/owner');
    expect(getPendingBrowserPageReference('/workspace-a/sessions/owner')).toBeUndefined();
  });
  it('cannot replay an unconsumed request on a later visit', () => {
    const reference = page('owner');
    requestBrowserPageReferenceOpen(reference, '/workspace-a/sessions/source');
    prepareBrowserPageReferenceNavigation(reference, '/workspace-a/sessions/owner');
    handleBrowserPageReferenceNavigation('/workspace-a/sessions/owner');
    handleBrowserPageReferenceNavigation('/workspace-a/settings');
    expect(getPendingBrowserPageReference('/workspace-a/sessions/owner')).toBeUndefined();
  });
  it('drops a request waiting for metadata when its source route is abandoned', () => {
    const reference = page('owner');
    requestBrowserPageReferenceOpen(reference, '/workspace-a/sessions/source');
    handleBrowserPageReferenceNavigation('/workspace-a/settings');
    expect(getPendingBrowserPageReference('/workspace-a/sessions/source')).toBeUndefined();
  });
});

it('uses the router logical path when Electron exposes its HTML pathname', () => {
  // Electron file history reports index.html in pathname and the app route in hash.
  const location = { pathname: '/app/resources/index.html', hash: '#/workspace-a/sessions/source' };
  const logicalPath = location.hash.slice(1);
  const reference = page('owner');
  requestBrowserPageReferenceOpen(reference, logicalPath);
  expect(getPendingBrowserPageReference(logicalPath)).toBe(reference);
  expect(getPendingBrowserPageReference(location.pathname)).toBeUndefined();
});
