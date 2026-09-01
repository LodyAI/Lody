// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAgentConfigRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type LocalProjectId,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';

const sessionActions = vi.hoisted(() => ({
  requestSessionDispatch: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('../src/hooks/use-session-actions', () => ({
  useSessionActions: () => sessionActions,
}));

import {
  FirstTaskScreen,
  getFirstTaskAgentConfigs,
  getSelectedFirstTaskAgentConfig,
} from '../src/components/onboarding/screens/first-task-screen';
import { userAtom } from '../src/atoms';
import { agentConfigMetaCacheAtom } from '../src/atoms/doc-meta';
import { runtimeAtom } from '../src/atoms/runtime';
import { initI18n } from '../src/i18n';

const machineId = 'machine-1' as MachineId;
const otherMachineId = 'machine-2' as MachineId;
const project = {
  kind: 'local' as const,
  machineId,
  localProjectId: 'project-1' as LocalProjectId,
  name: 'Lody',
};

function config(id: string, name: string, targetMachineId = machineId): AgentConfigMeta {
  return {
    id: id as AgentConfigId,
    machineId: targetMachineId,
    name,
    description: undefined,
    cliType: 'builtin',
    agentType: 'claude',
    env: {},
  };
}

describe('first task Agent Provider state', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('offers only published configs bound to the project machine in deterministic order', () => {
    const selected = config('selected', 'Zulu');
    const otherLocal = config('other-local', 'Alpha');
    const remote = config('remote', 'Beta', otherMachineId);

    expect(getFirstTaskAgentConfigs([selected, remote, otherLocal], project)).toEqual([
      otherLocal,
      selected,
    ]);
    expect(
      getFirstTaskAgentConfigs([selected], {
        kind: 'github',
        repoFullName: 'lodyai/lody',
        name: 'Lody',
      })
    ).toEqual([]);
  });

  it('does not fall back when the exact selected config disappears', () => {
    const remaining = config('remaining', 'Alpha');

    expect(
      getSelectedFirstTaskAgentConfig([remaining], 'missing-selection' as AgentConfigId)
    ).toBeNull();
  });

  it('skips without creating a Session, first turn, or dispatch request', async () => {
    const onSkip = vi.fn();
    const onContinue = vi.fn().mockResolvedValue(true);

    await act(async () => {
      root?.render(
        <Provider store={createStore()}>
          <FirstTaskScreen
            agentConfigId={'selected' as AgentConfigId}
            project={project}
            onBack={vi.fn()}
            onAgentConfigChange={vi.fn()}
            onSkip={onSkip}
            onContinue={onContinue}
          />
        </Provider>
      );
    });

    const skipButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Skip for now'
    );
    expect(skipButton).toBeDefined();

    await act(async () => {
      skipButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSkip).toHaveBeenCalledOnce();
    expect(onContinue).not.toHaveBeenCalled();
    expect(sessionActions.startSession).not.toHaveBeenCalled();
    expect(sessionActions.requestSessionDispatch).not.toHaveBeenCalled();
  });

  it('enters Lody before background Session creation settles', async () => {
    const selected = config('selected', 'Claude Code');
    const store = createStore();
    store.set(userAtom, { id: 'user-1', name: 'User', email: 'user@example.com' });
    store.set(runtimeAtom, {
      workspaceId: 'workspace-1' as WorkspaceId,
      workspaceSlug: 'workspace-1',
    } as never);
    store.set(agentConfigMetaCacheAtom, {
      [getAgentConfigRoomId(selected.id)]: selected,
    });
    let resolveStart:
      | ((value: {
          sessionId: string;
          historyEntry: { id: string; inputConfig: Record<string, unknown> };
        }) => void)
      | undefined;
    sessionActions.startSession.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      })
    );
    sessionActions.requestSessionDispatch.mockResolvedValue(true);
    const onContinue = vi.fn().mockResolvedValue(true);

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <FirstTaskScreen
            agentConfigId={selected.id}
            project={project}
            onBack={vi.fn()}
            onAgentConfigChange={vi.fn()}
            onSkip={vi.fn()}
            onContinue={onContinue}
          />
        </Provider>
      );
    });

    const runButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Run first task'
    );
    expect(runButton).toBeDefined();
    await act(async () => {
      runButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onContinue).toHaveBeenCalledOnce();
    expect(sessionActions.startSession).toHaveBeenCalledOnce();
    expect(onContinue.mock.invocationCallOrder[0]).toBeLessThan(
      sessionActions.startSession.mock.invocationCallOrder[0]
    );
    expect(sessionActions.requestSessionDispatch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Enter Lody');

    await act(async () => {
      resolveStart?.({
        sessionId: 'session-1',
        historyEntry: { id: 'turn-1', inputConfig: {} },
      });
      await Promise.resolve();
    });
    expect(sessionActions.requestSessionDispatch).toHaveBeenCalledOnce();
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
