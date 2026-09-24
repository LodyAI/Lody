/**
 * @vitest-environment jsdom
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTENT_SYNC_MIN_VISIBLE_MS,
  CONTENT_SYNC_SHOW_AFTER_MS,
  type DisplayedContentSyncState,
  useDisplayedContentSyncState,
} from '../src/hooks/use-displayed-content-sync-state';
import {
  resolveSessionContentSyncState,
  type SessionContentSyncInput,
  type SessionContentSyncState,
} from '../src/lib/session-content-sync-state';

const base: SessionContentSyncInput = {
  docReady: true,
  historyLength: 12,
  syncState: 'syncing',
  hasCaughtUp: false,
  knownToHaveMessages: true,
};
const resolve = (patch: Partial<SessionContentSyncInput>) =>
  resolveSessionContentSyncState({ ...base, ...patch });

describe('resolveSessionContentSyncState', () => {
  it('shows a skeleton only for a known-nonempty conversation with nothing cached', () => {
    expect(resolve({ historyLength: 0 })).toBe('cold');
    expect(resolve({ historyLength: 0, syncState: 'disconnected' })).toBe('cold');
    // A new, genuinely empty conversation never shows a loading skeleton.
    expect(resolve({ historyLength: 0, knownToHaveMessages: false })).toBe('current');
    expect(resolve({ docReady: false, historyLength: 0, knownToHaveMessages: false })).toBe(
      'current'
    );
    // Caught up and still empty: the conversation really is empty.
    expect(resolve({ historyLength: 0, hasCaughtUp: true })).toBe('current');
  });

  it('does not decide on a skeleton before the local copy has been read', () => {
    expect(resolve({ docReady: false, historyLength: 0 })).toBe('opening');
    expect(resolve({ docReady: false, historyLength: 0, syncState: 'idle' })).toBe('opening');
  });

  it('reports catching up while a cached copy actively syncs for the first time', () => {
    expect(resolve({ syncState: 'connecting' })).toBe('catching-up');
    expect(resolve({ syncState: 'syncing' })).toBe('catching-up');
    expect(resolve({ syncState: 'synced' })).toBe('current');
    // Later sync blips are live updates on a current copy.
    expect(resolve({ syncState: 'syncing', hasCaughtUp: true })).toBe('current');
  });

  it('never surfaces a degraded connection as a content state', () => {
    for (const syncState of ['reconnecting', 'disconnected', 'error'] as const) {
      expect(resolve({ syncState })).toBe('current');
    }
  });
});

describe('useDisplayedContentSyncState', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let shown: DisplayedContentSyncState | null = null;

  function Probe({ state }: { state: SessionContentSyncState }) {
    shown = useDisplayedContentSyncState(state);
    return null;
  }
  const render = async (state: SessionContentSyncState) => {
    await act(async () => {
      root!.render(React.createElement(Probe, { state }));
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps a routine catch-up quiet and shows a lasting one', async () => {
    await render('current');
    await render('catching-up');
    await advance(CONTENT_SYNC_SHOW_AFTER_MS - 1);
    expect(shown).toBe('current');
    await render('current');
    await advance(CONTENT_SYNC_SHOW_AFTER_MS);
    expect(shown).toBe('current');

    await render('catching-up');
    await advance(CONTENT_SYNC_SHOW_AFTER_MS);
    expect(shown).toBe('catching-up');
  });

  it('keeps a shown status for the minimum time before clearing it', async () => {
    await render('current');
    await render('catching-up');
    await advance(CONTENT_SYNC_SHOW_AFTER_MS);
    expect(shown).toBe('catching-up');

    await render('current');
    await advance(CONTENT_SYNC_MIN_VISIBLE_MS - 1);
    expect(shown).toBe('catching-up');
    await advance(1);
    expect(shown).toBe('current');
  });

  it('opens a cached conversation without a skeleton flash', async () => {
    await render('opening');
    expect(shown).toBe('current');
    await advance(CONTENT_SYNC_SHOW_AFTER_MS - 1);
    // The local read finished with a cached copy: no skeleton was ever shown.
    await render('current');
    await advance(CONTENT_SYNC_SHOW_AFTER_MS);
    expect(shown).toBe('current');
  });

  it('waits for the local read even when the previous conversation showed a status', async () => {
    await render('catching-up');
    await advance(CONTENT_SYNC_SHOW_AFTER_MS);
    expect(shown).toBe('catching-up');
    await render('opening');
    expect(shown).not.toBe('cold');
  });

  it('falls back to the skeleton when the local read is slow, then shows the empty copy at once', async () => {
    await render('opening');
    await advance(CONTENT_SYNC_SHOW_AFTER_MS);
    expect(shown).toBe('cold');

    await render('current');
    await render('opening');
    await render('cold');
    expect(shown).toBe('cold');
  });

  it('shows the skeleton at once instead of a blank pane', async () => {
    await render('cold');
    expect(shown).toBe('cold');
    // The cache fills with a still-syncing copy: the switch is immediate.
    await render('catching-up');
    expect(shown).toBe('catching-up');
  });
});
