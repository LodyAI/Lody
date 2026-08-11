// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';

import {
  browserOnlineAtom,
  lodyControlConnectionStateAtom,
  type LodyControlConnectionState,
} from '../src/atoms/control-connection';
import { authTokenAtom } from '../src/atoms/runtime';
import {
  STUCK_CONNECTION_HINT_DELAY_MS,
  useStuckConnectionHint,
} from '../src/hooks/use-stuck-connection';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Store = ReturnType<typeof createStore>;

const latest = { stuck: false };

function Probe() {
  latest.stuck = useStuckConnectionHint();
  return null;
}

let root: Root;
let container: HTMLDivElement;
let store: Store;

function mount() {
  act(() => {
    root.render(createElement(Provider, { store }, createElement(Probe)));
  });
}

function setConnectionState(state: LodyControlConnectionState) {
  act(() => {
    store.set(lodyControlConnectionStateAtom, state);
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  store = createStore();
  store.set(browserOnlineAtom, true);
  store.set(authTokenAtom, 'auth-token');
  store.set(lodyControlConnectionStateAtom, 'connecting');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest.stuck = false;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe('useStuckConnectionHint', () => {
  it('flags a connection stuck in loading once the delay elapses', () => {
    mount();
    expect(latest.stuck).toBe(false);

    advance(STUCK_CONNECTION_HINT_DELAY_MS - 1);
    expect(latest.stuck).toBe(false);

    advance(1);
    expect(latest.stuck).toBe(true);
  });

  it('never flags a slow connection that completes before the delay', () => {
    mount();
    advance(STUCK_CONNECTION_HINT_DELAY_MS - 1_000);
    setConnectionState('online');

    advance(STUCK_CONNECTION_HINT_DELAY_MS * 2);
    expect(latest.stuck).toBe(false);
  });

  it('requires the full delay again after a loading → online → loading cycle', () => {
    mount();
    advance(STUCK_CONNECTION_HINT_DELAY_MS - 1_000);
    setConnectionState('online');
    setConnectionState('connecting');

    advance(STUCK_CONNECTION_HINT_DELAY_MS - 1);
    expect(latest.stuck).toBe(false);

    advance(1);
    expect(latest.stuck).toBe(true);
  });

  it('clears the flag as soon as the connection recovers', () => {
    mount();
    advance(STUCK_CONNECTION_HINT_DELAY_MS);
    expect(latest.stuck).toBe(true);

    setConnectionState('online');
    expect(latest.stuck).toBe(false);
  });

  it('ignores reconnecting: the runtime reconnect loop owns that state', () => {
    setConnectionState('reconnecting');
    mount();

    advance(STUCK_CONNECTION_HINT_DELAY_MS * 2);
    expect(latest.stuck).toBe(false);
  });

  it('ignores an offline browser', () => {
    act(() => {
      store.set(browserOnlineAtom, false);
    });
    mount();

    advance(STUCK_CONNECTION_HINT_DELAY_MS * 2);
    expect(latest.stuck).toBe(false);
  });

  it('never flags while signed out', () => {
    act(() => {
      store.set(authTokenAtom, null);
    });
    mount();

    advance(STUCK_CONNECTION_HINT_DELAY_MS * 2);
    expect(latest.stuck).toBe(false);
  });
});
