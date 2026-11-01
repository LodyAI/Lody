// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, getDefaultStore, Provider } from 'jotai';
import { getMachineMetaByIdAtomFamily } from '../src/atoms/machines';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeSessionContinuation } from '../src/components/sessions/session-continuation';
import { useLocalSessionContinuation } from '../src/components/sessions/use-local-session-continuation';

vi.mock('../src/atoms/machines', async () => {
  const { atom } = await import('jotai');
  const machine = atom({
    protocolCapabilities: { sessionAutomations: 1, remoteAutomationControl: 1 },
  });
  return { getMachineMetaByIdAtomFamily: () => machine };
});
const machineAtom = getMachineMetaByIdAtomFamily() as import('jotai').PrimitiveAtom<{
  protocolCapabilities: Record<string, number>;
} | null>;

const automation = vi.fn();
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({ sessionControl: { automation } }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const target = { workspaceId: 'workspace', machineId: 'machine', sessionId: 'session' };

describe('local Session continuation', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let store: ReturnType<typeof createStore>;
  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    store = createStore();
    getDefaultStore().set(machineAtom, {
      protocolCapabilities: { sessionAutomations: 1, remoteAutomationControl: 1 },
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    automation.mockReset();
    vi.useRealTimers();
  });
  it('does not access the owner when no supported local Session is selected', async () => {
    function View() {
      const data = useLocalSessionContinuation(null, true);
      return <output>{JSON.stringify(data.views)}</output>;
    }
    await act(async () => root.render(<View />));
    expect(container.textContent).toBe('[]');
    expect(automation).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'hides unsupported automation without polling (remote=%s), then recovers on upgrade',
    async (remote) => {
      vi.useFakeTimers();
      store.set(machineAtom, { protocolCapabilities: {} });
      let requests = 0;
      const execute = async (command: { type: string }) => {
        requests++;
        return command.type === 'list'
          ? { type: 'list', waits: [] }
          : { type: 'settings', settings: { recoverCapacity: true } };
      };
      automation.mockImplementation(({ command }) => execute(command));
      const runtime = {
        requestSessionAutomationControl: (
          _m: string,
          _s: string,
          _u: string,
          command: { type: string }
        ) => execute(command),
      } as unknown as import('../src/atoms/runtime').WorkspaceRuntime;
      function View() {
        const data = useLocalSessionContinuation(
          remote ? { ...target, remote: { runtime, requesterUserId: 'user' } } : target,
          true
        );
        return (
          <output>
            {JSON.stringify({
              supported: data.supported,
              error: data.error,
              recovery: data.recoveryEnabled,
              views: data.views,
            })}
          </output>
        );
      }
      await act(async () =>
        root.render(
          <Provider store={store}>
            <View />
          </Provider>
        )
      );
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(container.textContent).toBe(
        '{"supported":false,"error":false,"recovery":null,"views":[]}'
      );
      expect(requests).toBe(0);
      await act(async () =>
        store.set(machineAtom, {
          protocolCapabilities: remote ? { remoteAutomationControl: 1 } : { sessionAutomations: 1 },
        })
      );
      expect(container.textContent).toBe(
        '{"supported":true,"error":false,"recovery":true,"views":[]}'
      );
      await act(async () => store.set(machineAtom, null));
      expect(container.textContent).toBe(
        '{"supported":false,"error":false,"recovery":null,"views":[]}'
      );
      const completed = requests;
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(requests).toBe(completed);
    }
  );
  it('keeps supported connection failures visible and recovers on retry', async () => {
    vi.useFakeTimers();
    automation.mockRejectedValue(new Error('disconnected'));
    function View() {
      const data = useLocalSessionContinuation(target, true);
      return (
        <output>
          {String(data.error)}:{String(data.recoveryEnabled)}
        </output>
      );
    }
    await act(async () => root.render(<View />));
    expect(container.textContent).toBe('true:null');
    automation.mockImplementation(async ({ command }) =>
      command.type === 'list'
        ? { type: 'list', waits: [] }
        : { type: 'settings', settings: { recoverCapacity: false } }
    );
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(container.textContent).toBe('false:false');
  });
  it('reads and changes a remote Session through its machine owner', async () => {
    const calls: string[] = [];
    const runtime = {
      requestSessionAutomationControl: async (
        machineId: string,
        sessionId: string,
        userId: string,
        command: { type: string }
      ) => {
        calls.push(`${machineId}:${sessionId}:${userId}:${command.type}`);
        return command.type === 'list'
          ? {
              type: 'list',
              waits: [{ id: 'remote-wait', sessionId, state: 'waiting', nextCheckAt: 1 }],
            }
          : command.type === 'settings'
            ? { type: 'settings', settings: { recoverCapacity: false } }
            : { type: 'cancel' };
      },
    } as unknown as import('../src/atoms/runtime').WorkspaceRuntime;
    function View() {
      const data = useLocalSessionContinuation(
        { ...target, remote: { runtime, requesterUserId: 'user' } },
        true
      );
      return (
        <>
          <output>{JSON.stringify(data.views)}</output>
          <button onClick={() => data.cancel('remote-wait')}>Cancel</button>
        </>
      );
    }
    await act(async () => root.render(<View />));
    expect(container.textContent).toContain('remote-wait');
    await act(async () => container.querySelector('button')?.click());
    expect(calls).toContain('machine:session:user:cancel');
    expect(automation).not.toHaveBeenCalled();
  });
  it('exposes Resume only for a stopped continuation and refreshes the delivery after restore', async () => {
    let stopped = true;
    automation.mockImplementation(async ({ command }) =>
      command.type === 'list'
        ? {
            type: 'list',
            waits: [
              {
                id: 'stopped',
                state: 'matched',
                nextCheckAt: 1,
                continuation: stopped
                  ? { state: 'blocked', reason: 'target_stopped' }
                  : { state: 'queued' },
              },
              {
                id: 'archived',
                state: 'matched',
                nextCheckAt: 1,
                continuation: { state: 'blocked', reason: 'target_archived' },
              },
            ],
          }
        : { type: 'settings', settings: {} }
    );
    function View() {
      const data = useLocalSessionContinuation(target, true);
      return (
        <>
          {data.views.map((view) => {
            const descriptor = describeSessionContinuation(view, 1);
            return descriptor.visible ? (
              <output key={view.id} data-id={view.id}>
                {descriptor.detail}
                {descriptor.actions.resume && (
                  <button
                    onClick={() => {
                      stopped = false;
                      data.refresh();
                    }}
                  >
                    Resume
                  </button>
                )}
              </output>
            ) : null;
          })}
        </>
      );
    }
    await act(async () =>
      root.render(
        <Provider store={store}>
          <View />
        </Provider>
      )
    );
    expect(container.querySelector('[data-id="stopped"]')?.textContent).toBe(
      'blockedStoppedResume'
    );
    expect(container.querySelector('[data-id="archived"]')?.textContent).toBe('blockedUnavailable');
    await act(async () => container.querySelector('button')?.click());
    expect(container.querySelector('[data-id="stopped"]')?.textContent).toBe('queued');
    expect(container.querySelector('button')).toBeNull();
  });
  it('loads waits and settings and sends scoped changes without developer mode', async () => {
    let settingsUnavailable = true;
    automation.mockImplementation(async ({ command }) => {
      if (command.type === 'list')
        return {
          type: 'list',
          waits: [
            {
              id: 'one',
              state: 'matched',
              reason: 'CI',
              nextCheckAt: 1,
              continuation: { state: 'unknown' },
            },
          ],
        };
      if (command.type === 'settings' && settingsUnavailable) throw new Error('stopped');
      if (command.type === 'settings')
        return {
          type: 'settings',
          settings: { recoverCapacity: true, archiveAfterMerge: false, compactWhenIdle: false },
        };
      return { type: command.type };
    });
    function View() {
      const data = useLocalSessionContinuation(target, true);
      return (
        <>
          <output>{JSON.stringify(data.views)}</output>
          <span>{String(data.recoveryEnabled)}</span>
          <button onClick={() => data.cancel('one')}>Cancel</button>
          <button onClick={() => data.setTweak('archiveAfterMerge', true)}>Enable</button>
        </>
      );
    }
    await act(async () => {
      root.render(
        <Provider store={store}>
          <View />
        </Provider>
      );
    });
    expect(container.textContent).toContain('"continuation":"unknown"');
    settingsUnavailable = false;
    await act(async () => {
      container.querySelectorAll('button')[0]!.click();
    });
    expect(automation).toHaveBeenCalledWith({ ...target, command: { type: 'cancel', id: 'one' } });
    await act(async () => {
      container.querySelectorAll('button')[1]!.click();
    });
    expect(automation).toHaveBeenCalledWith({
      ...target,
      command: { type: 'configure', settings: { archiveAfterMerge: true } },
    });
    expect(container.querySelector('output')!.textContent).toContain('"continuation":"unknown"');
    expect(container.querySelector('span')!.textContent).toBe('true');
  });
});
