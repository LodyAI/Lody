// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronCliState } from '@lody/shared';
import {
  E2eeMachineWindowPillView,
  E2eeOfflineSummaryText,
  e2eeOfflineWindow,
} from '../src/components/e2ee-offline-window';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));

const HOUR = 3_600_000;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const cliState = (runtime: Partial<NonNullable<ElectronCliState['runtime']>>) =>
  ({
    runtime: { schemaVersion: 1, phase: 'running', pid: 1, updatedAtMs: 0, issues: [], ...runtime },
  }) as unknown as ElectronCliState;

describe('encrypted workspace outage window', () => {
  it('reads only the current workspace window from the local runtime', () => {
    const state = cliState({
      e2eeAccessWindows: { w1: { executionUntilMs: 4 * HOUR, readUntilMs: 24 * HOUR } },
      connectionAges: { backendNotConnectedSinceMs: HOUR },
    });
    expect(e2eeOfflineWindow(state, 'w1')).toEqual({
      executionUntilMs: 4 * HOUR,
      offlineSinceMs: HOUR,
    });
    // Another workspace, an ordinary one, or no runtime at all shows nothing extra.
    expect(e2eeOfflineWindow(state, 'w2')).toBeNull();
    expect(e2eeOfflineWindow(null, 'w1')).toBeNull();
  });

  it('says how long the server is out of reach and how long this machine keeps working', () => {
    const window = { executionUntilMs: 4 * HOUR, offlineSinceMs: HOUR - 48 * 60_000 };
    act(() => root.render(<E2eeOfflineSummaryText window={window} now={HOUR} />));
    expect(container.textContent).toContain('e2ee.offline.since');
    expect(container.textContent).toContain('"duration":"e2ee.offline.minutes {\\"count\\":48}"');
    expect(container.textContent).toContain(
      'e2ee.offline.machineLeft {"duration":"e2ee.offline.hoursMinutes {\\"hours\\":3,\\"minutes\\":0}"}'
    );

    // Past the window the machine has paused; reconnecting resumes it.
    act(() => root.render(<E2eeOfflineSummaryText window={window} now={5 * HOUR} />));
    expect(container.textContent).toContain('e2ee.offline.machinePaused');
    expect(container.textContent).not.toContain('e2ee.offline.machineLeft');
  });

  it('marks this machine with the time left, then as paused', () => {
    const window = { executionUntilMs: 4 * HOUR };
    act(() => root.render(<E2eeMachineWindowPillView window={window} now={48 * 60_000} />));
    const pill = () => container.querySelector('[data-e2ee-machine-window]');
    expect(pill()?.getAttribute('data-e2ee-machine-window')).toBe('active');
    expect(pill()?.textContent).toBe('e2ee.offline.machinePill {"time":"3:12"}');
    act(() => root.render(<E2eeMachineWindowPillView window={window} now={4 * HOUR} />));
    expect(pill()?.getAttribute('data-e2ee-machine-window')).toBe('paused');
    expect(pill()?.textContent).toBe('e2ee.offline.machinePillPaused');
  });
});
