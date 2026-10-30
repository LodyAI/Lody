// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeSessionContinuation } from '../src/components/sessions/session-continuation';
import { useLocalSessionContinuation } from '../src/components/sessions/use-local-session-continuation';

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
  });
  afterEach(() => {
    act(() => root.unmount());
    automation.mockReset();
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
