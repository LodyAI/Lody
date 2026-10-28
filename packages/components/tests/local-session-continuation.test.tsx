// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  developerModeEnabledAtom,
  sessionContinuationBetaEnabledAtom,
} from '../src/atoms/settings';
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
  const container = document.createElement('div');
  const root = createRoot(container);
  const store = createStore();
  afterEach(() => {
    act(() => root.unmount());
    automation.mockReset();
  });
  it('loads waits and settings, sends scoped changes, and stops when the flag is off', async () => {
    store.set(developerModeEnabledAtom, true);
    store.set(sessionContinuationBetaEnabledAtom, true);
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
        return { type: 'settings', settings: { archiveAfterMerge: false, compactWhenIdle: false } };
      return { type: command.type };
    });
    function View() {
      const data = useLocalSessionContinuation(target, true);
      return (
        <>
          <output>{JSON.stringify(data.views)}</output>
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
    await act(async () => {
      store.set(sessionContinuationBetaEnabledAtom, false);
    });
    expect(container.querySelector('output')!.textContent).toBe('[]');
  });
});
