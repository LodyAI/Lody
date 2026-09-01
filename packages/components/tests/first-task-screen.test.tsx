// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfigId, AgentConfigMeta, LocalProjectId, MachineId } from '@lody/shared';

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
    const onContinue = vi.fn();

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
            onSessionStarted={vi.fn()}
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
});
