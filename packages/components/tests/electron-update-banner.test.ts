// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ElectronUpdaterState } from '@lody/shared';
import {
  pickLocalizedReleaseNotes,
  readUpdateBannerState,
} from '../src/lib/electron-update-banner';
import { useElectronUpdaterState } from '../src/hooks/use-electron-updater-state';

function state(overrides: Partial<ElectronUpdaterState>): ElectronUpdaterState {
  return { phase: 'idle', currentVersion: '1.0.0', ...overrides };
}

describe('readUpdateBannerState', () => {
  it.each(['idle', 'checking', 'up_to_date', 'error', 'disabled'] as const)(
    'stays silent in the %s phase',
    (phase) => {
      expect(readUpdateBannerState(state({ phase, availableVersion: '1.1.0' }))).toBeNull();
    }
  );

  it('reports an indeterminate download when the feed has no percent', () => {
    expect(
      readUpdateBannerState(state({ phase: 'downloading', availableVersion: '1.1.0' }))
    ).toEqual({ stage: 'downloading', version: '1.1.0', percent: null });
  });

  it('prefers the downloaded version once the download finishes', () => {
    expect(
      readUpdateBannerState(
        state({
          phase: 'downloaded',
          availableVersion: '1.1.0',
          downloadedVersion: '1.1.1',
          percent: 100,
        })
      )
    ).toEqual({ stage: 'downloaded', version: '1.1.1', percent: null });
  });

  it('falls back to the available version when only that one is reported', () => {
    expect(
      readUpdateBannerState(state({ phase: 'downloaded', availableVersion: '1.1.0' }))
    ).toEqual({ stage: 'downloaded', version: '1.1.0', percent: null });
  });

  it('stays silent when no version is known', () => {
    expect(
      readUpdateBannerState(state({ phase: 'downloading', availableVersion: '   ' }))
    ).toBeNull();
  });
});

describe('pickLocalizedReleaseNotes', () => {
  const notes = state({
    phase: 'downloaded',
    downloadedVersion: '1.1.0',
    releaseNotes: 'publisher notes',
    releaseNotesByLocale: { en: 'English notes', zh_CN: '中文说明' },
  });

  it('picks the notes for the active language', () => {
    expect(pickLocalizedReleaseNotes(notes, 'zh_CN')).toBe('中文说明');
    expect(pickLocalizedReleaseNotes(notes, 'en')).toBe('English notes');
  });

  it('treats any Chinese tag as Simplified Chinese', () => {
    expect(pickLocalizedReleaseNotes(notes, 'zh-TW')).toBe('中文说明');
  });

  it('falls back to English when the active language has no notes', () => {
    const enOnly = state({ releaseNotesByLocale: { en: 'English notes' } });
    expect(pickLocalizedReleaseNotes(enOnly, 'zh_CN')).toBe('English notes');
  });

  it('falls back to the publisher notes when no localized notes exist', () => {
    expect(pickLocalizedReleaseNotes(state({ releaseNotes: 'publisher notes' }), 'zh_CN')).toBe(
      'publisher notes'
    );
  });
});

describe('Electron update state subscription', () => {
  let root: Root;
  let container: HTMLDivElement;
  let resolveSnapshot: (value: ElectronUpdaterState) => void;
  let rejectSnapshot: (reason: Error) => void;
  let listeners: Set<(payload: unknown) => void>;

  function Probe() {
    const current = useElectronUpdaterState();
    const banner = current && readUpdateBannerState(current);
    return createElement('output', null, JSON.stringify({ current, banner }));
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    listeners = new Set();
    const snapshot = new Promise<ElectronUpdaterState>((resolve, reject) => {
      resolveSnapshot = resolve;
      rejectSnapshot = reject;
    });
    window.__LODY_ELECTRON__ = true;
    window.ipc = {
      invoke: async (channel) => {
        if (channel === 'updater.getState') return snapshot;
        throw new Error(`unexpected IPC: ${channel}`);
      },
      on: (channel, listener) => {
        if (channel === 'updater.state') listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send: () => {},
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete window.ipc;
    delete window.__LODY_ELECTRON__;
  });

  function read() {
    return JSON.parse(container.textContent ?? '{}');
  }

  function publish(next: ElectronUpdaterState) {
    act(() => {
      for (const listener of listeners) listener(next);
    });
  }

  it('shows the initial snapshot when no push has arrived', async () => {
    expect(read().current).toBeNull();
    await act(async () => resolveSnapshot(state({ phase: 'checking' })));
    expect(read().current.phase).toBe('checking');
  });

  it('keeps the install-ready banner when an older download snapshot arrives late', async () => {
    publish(state({ phase: 'downloaded', downloadedVersion: '1.1.0' }));
    await act(async () =>
      resolveSnapshot(state({ phase: 'downloading', availableVersion: '1.1.0', percent: 10 }))
    );
    expect(read().banner).toEqual({ stage: 'downloaded', version: '1.1.0', percent: null });
    // Later pushes still own the state, including recovery from a terminal phase.
    publish(state({ phase: 'checking' }));
    expect(read().current.phase).toBe('checking');
  });

  it('continues receiving progress after the initial snapshot fails', async () => {
    await act(async () => rejectSnapshot(new Error('synthetic IPC failure')));
    expect(read().current).toBeNull();
    publish(state({ phase: 'downloading', availableVersion: '1.1.0', percent: 50 }));
    expect(read().banner).toEqual({ stage: 'downloading', version: '1.1.0', percent: 50 });
  });

  it('retires the old read when the updater observer remounts', async () => {
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement(Probe)));
    publish(state({ phase: 'downloaded', downloadedVersion: '1.1.0' }));
    await act(async () => resolveSnapshot(state({ phase: 'idle' })));
    expect(read().banner).toEqual({ stage: 'downloaded', version: '1.1.0', percent: null });
  });
});
