/** @vitest-environment jsdom */

import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import type { SessionDocStore, SessionSyncInspection } from '../src/atoms/runtime';
import {
  SESSION_DOC_STALE_REPORT_DELAY_MS,
  useSessionDocStaleReport,
  type SessionDocStaleSignal,
} from '../src/components/sessions/use-session-doc-stale-report';
import { flushClientLog, readClientLog, resetClientLogForTests } from '../src/lib/client-log';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const START = Date.UTC(2026, 9, 20, 12);
const SESSION = 'session-stale' as SessionId;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(START);
  await resetClientLogForTests(() => Date.now());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A store whose doc last imported 5 minutes before the report. */
const createStore = (inspection: Partial<SessionSyncInspection> = {}): SessionDocStore =>
  ({
    historyBackend: 'loro',
    inspectSync: async () => ({
      transportId: 'cloud',
      bindingStatus: 'joined',
      syncState: 'synced',
      openedAt: START - 600_000,
      lastRemoteImportAt: START - 300_000,
      pendingUploadProbe: 'timeout',
      ...inspection,
    }),
  }) as unknown as SessionDocStore;

type Props = Partial<SessionDocStaleSignal> & { store?: SessionDocStore };

const stale: SessionDocStaleSignal = {
  docReady: true,
  machineOnlineStatus: 'online',
  agentBusy: false,
  activeAssistantTurnId: 'turn-1',
};

function Probe({ store, ...signal }: Props) {
  useSessionDocStaleReport({
    ...stale,
    ...signal,
    sessionId: SESSION,
    lastMessageAt: START - 10_000,
    peekStore: () => store,
  });
  return null;
}

const render = (props: Props) => {
  if (!root) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root!.render(<Probe {...props} />));
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const staleEntries = async (): Promise<string[]> => {
  await flushClientLog();
  return (await readClientLog()).split('\n').filter((line) => line.includes('session.doc_stale'));
};

describe('useSessionDocStaleReport', () => {
  it('records one entry with the room state once an unfinished turn outlives presence', async () => {
    const store = createStore();
    render({ store });
    await advance(SESSION_DOC_STALE_REPORT_DELAY_MS - 1);
    expect(await staleEntries()).toEqual([]);

    await advance(1);
    const [entry, ...rest] = await staleEntries();
    expect(rest).toEqual([]);
    expect(entry).toContain('session-stale');
    expect(entry).toContain('turn-1');
    expect(entry).toMatch(/bindingStatus.*joined/);
    expect(entry).toMatch(/pendingUploadProbe.*timeout/);
    expect(entry).toMatch(/lastRemoteImportAgoMs.*330000/);
    expect(entry).toMatch(/lastMessageAgoMs.*40000/);

    // Re-rendering the same stale turn never repeats the report.
    render({ store });
    await advance(SESSION_DOC_STALE_REPORT_DELAY_MS * 3);
    expect(await staleEntries()).toHaveLength(1);
  });

  it('reports again for a later turn that goes stale', async () => {
    const store = createStore();
    render({ store });
    await advance(SESSION_DOC_STALE_REPORT_DELAY_MS);
    render({ store, activeAssistantTurnId: 'turn-2' });
    await advance(SESSION_DOC_STALE_REPORT_DELAY_MS);
    const entries = await staleEntries();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toContain('turn-2');
  });

  it.each([
    { name: 'presence still reports work', props: { agentBusy: true } },
    { name: 'machine liveness is unknown', props: { machineOnlineStatus: 'unknown' as const } },
    { name: 'machine is offline', props: { machineOnlineStatus: 'offline' as const } },
    { name: 'the doc is not ready', props: { docReady: false } },
  ])('stays quiet while $name', async ({ props }) => {
    render({ store: createStore(), ...props });
    await advance(SESSION_DOC_STALE_REPORT_DELAY_MS * 2);
    expect(await staleEntries()).toEqual([]);
  });

  it('stays quiet when the turn finishes before the delay', async () => {
    const store = createStore();
    render({ store });
    await advance(SESSION_DOC_STALE_REPORT_DELAY_MS - 1_000);
    render({ store, activeAssistantTurnId: null });
    await advance(SESSION_DOC_STALE_REPORT_DELAY_MS * 2);
    expect(await staleEntries()).toEqual([]);
  });
});
