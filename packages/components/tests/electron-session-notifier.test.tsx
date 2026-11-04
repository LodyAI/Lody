// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMachineRoomId, type MachineMeta } from '@lody/shared';
import { LegacyElectronSessionNotifier } from '../src/components/legacy-electron-session-notifier';
import type { SessionListEntry } from '../src/lib/session-visibility';

const bridge = vi.hoisted(() => ({ shown: [] as Array<{ sessionId: string; title: string }> }));
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    notifications: {
      showSessionCompletion: async (input: { sessionId: string; title: string }) => {
        bridge.shown.push(input);
        return { shown: true };
      },
    },
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const session = {
  id: 'session',
  machineId: 'machine',
  userId: 'user',
  title: 'Synthetic',
  status: { type: 'running' },
} as SessionListEntry;
const machine = {
  id: 'machine',
  protocolCapabilities: { terminalNotifications: 1 },
} as MachineMeta;
const props = {
  sessions: [session],
  machines: {},
  runtime: null,
  currentUserId: 'user',
  workspaceSlug: 'workspace',
  enabled: true,
};

let root: Root | undefined;
let container: HTMLDivElement;
function render(node: ReactNode) {
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender: (next: ReactNode) => {
      act(() => root?.render(next));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  bridge.shown.length = 0;
  window.__LODY_ELECTRON__ = true;
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  delete window.__LODY_ELECTRON__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop legacy compatibility observer', () => {
  it.each([false, true])('gates idle completion by terminal capability (%s)', (modern) => {
    const machines = modern ? { [getMachineRoomId(session.machineId)]: machine } : {};
    const view = render(<LegacyElectronSessionNotifier {...props} machines={machines} />);
    view.rerender(
      <LegacyElectronSessionNotifier
        {...props}
        machines={machines}
        sessions={[{ ...session, status: { type: 'idle' } }]}
      />
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(bridge.shown.map(({ sessionId, title }) => ({ sessionId, title }))).toEqual(
      modern ? [] : [{ sessionId: 'session', title: 'Synthetic' }]
    );
  });
  it('drops a pending old-account notification during a scope switch', () => {
    const view = render(<LegacyElectronSessionNotifier {...props} />);
    view.rerender(
      <LegacyElectronSessionNotifier
        {...props}
        sessions={[{ ...session, status: { type: 'idle' } }]}
      />
    );
    view.rerender(
      <LegacyElectronSessionNotifier
        {...props}
        sessions={[]}
        currentUserId="other"
        workspaceSlug="other"
      />
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(bridge.shown).toEqual([]);
  });
  it('retains permission alerts for modern peers while completion uses the new consumer', () => {
    const machines = { [getMachineRoomId(session.machineId)]: machine };
    const view = render(<LegacyElectronSessionNotifier {...props} machines={machines} />);
    view.rerender(
      <LegacyElectronSessionNotifier
        {...props}
        machines={machines}
        sessions={[{ ...session, status: { type: 'requestPermission' } }]}
      />
    );
    expect(bridge.shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: 'Synthetic', body: 'notifications.copy.conversation.attention' },
    ]);
  });
});
