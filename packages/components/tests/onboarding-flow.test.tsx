// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigId,
  AgentConfigMeta,
  LocalProjectId,
  MachineId,
  ProviderSetupTask,
  WorkspaceId,
} from '@lody/shared';

const mocks = vi.hoisted(() => ({
  createGitHubInstallState: vi.fn(),
  getCliState: vi.fn(),
  onCliState: vi.fn(),
  openExternalUrl: vi.fn(),
  selectLocalProjectDirectory: vi.fn(),
  useVisibleLocalProjects: vi.fn(),
}));

vi.mock('convex/react', () => ({
  useAction: () => mocks.createGitHubInstallState,
}));

vi.mock('../src/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: () => [],
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock('../src/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjects: mocks.useVisibleLocalProjects,
}));

vi.mock('../src/lib/native-browser', () => ({
  openExternalUrl: mocks.openExternalUrl,
}));

import { localCliStartingAtom, localProbeResultAtom } from '../src/atoms/local-probe';
import { runtimeAtom } from '../src/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import {
  OnboardingOverlay,
  resolveDesktopOnboardingPhase,
} from '../src/components/onboarding/onboarding-overlay';
import { getDesktopOnboardingSteps } from '../src/components/onboarding/onboarding-steps';
import {
  ProjectsScreen,
  ProjectsScreenView,
} from '../src/components/onboarding/screens/projects-screen';
import { ProvidersScreenView } from '../src/components/onboarding/screens/providers-screen';
import { initI18n } from '../src/i18n';
import { TestCloudPlatformProvider } from './test-platform';

const workspaceId = 'workspace-1' as WorkspaceId;
const machineId = 'machine-1' as MachineId;

function installElectronWindowIpc() {
  mocks.getCliState.mockReturnValue(new Promise(() => undefined));
  mocks.onCliState.mockReturnValue(() => undefined);

  Object.defineProperty(window, '__LODY_ELECTRON__', { configurable: true, value: true });
  Object.defineProperty(window, 'ipc', {
    configurable: true,
    value: {
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === 'cli.getState') return mocks.getCliState();
        if (channel === 'localProjects.selectDirectory') {
          return mocks.selectLocalProjectDirectory(...args);
        }
        throw new Error(`unexpected invoke ${channel}`);
      },
      on: (channel: string, listener: (payload: unknown) => void) => {
        if (channel === 'cli.state') return mocks.onCliState(listener);
        return () => {};
      },
      send: () => {},
    },
  });
}

function uninstallElectronWindowIpc() {
  delete window.__LODY_ELECTRON__;
  delete window.ipc;
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((item) =>
    item.textContent?.includes(label)
  );
  if (!button) throw new Error(`Expected button containing "${label}"`);
  return button;
}

describe('desktop onboarding flow', () => {
  let root: Root | undefined;
  let container: HTMLDivElement;
  let store: Store;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    localStorage.clear();
    mocks.createGitHubInstallState.mockResolvedValue({ state: 'github-state-1' });
    mocks.openExternalUrl.mockResolvedValue(true);
    mocks.useVisibleLocalProjects.mockReturnValue({ projects: new Map() });
    installElectronWindowIpc();

    store = createStore();
    store.set(currentWorkspaceIdAtom, workspaceId);
    store.set(currentWorkspaceSlugAtom, 'workspace-1');
    store.set(runtimeAtom, {
      workspaceId,
      workspaceSlug: 'workspace-1',
      getMachineAcpBinaryProgress: () => null,
      subscribeMachineAcpBinaryProgress: () => () => undefined,
    } as never);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    uninstallElectronWindowIpc();
    vi.clearAllMocks();
  });

  it('renders the welcome step without waiting for the Electron CLI bootstrap', async () => {
    await act(async () => {
      root?.render(
        <TestCloudPlatformProvider>
          <Provider store={store}>
            <OnboardingOverlay onCompleted={vi.fn()} />
          </Provider>
        </TestCloudPlatformProvider>
      );
    });

    expect(container.textContent).toContain('Stay in the flow.');
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).not.toContain('Preparing your workspace');
    expect(mocks.getCliState).not.toHaveBeenCalled();
  });

  it('derives steps and repairs stale phases from platform capabilities', () => {
    expect(getDesktopOnboardingSteps({ cloudAccount: false, multiWorkspace: false })).toEqual([
      'ceremony',
      'providers',
      'projects',
      'firstTask',
    ]);
    expect(getDesktopOnboardingSteps({ cloudAccount: true, multiWorkspace: true })).toEqual([
      'ceremony',
      'login',
      'workspace',
      'providers',
      'projects',
      'firstTask',
    ]);
    expect(
      resolveDesktopOnboardingPhase('login', {
        cloudAccount: false,
        multiWorkspace: false,
        hasAgent: false,
        hasProject: false,
      })
    ).toBe('providers');
    expect(
      resolveDesktopOnboardingPhase('firstTask', {
        cloudAccount: false,
        multiWorkspace: false,
        hasAgent: true,
        hasProject: false,
      })
    ).toBe('projects');
  });

  it('returns the exact selected local project', async () => {
    const onComplete = vi.fn();
    const selectedMachine = 'machine-2' as MachineId;
    const selectedProject = 'project-2' as LocalProjectId;
    await act(async () => {
      root?.render(
        <ProjectsScreenView
          local={[
            {
              key: `${machineId}:project-1`,
              machineId,
              localProjectId: 'project-1' as LocalProjectId,
              name: 'first',
              detail: '/first',
            },
            {
              key: `${selectedMachine}:${selectedProject}`,
              machineId: selectedMachine,
              localProjectId: selectedProject,
              name: 'selected',
              detail: '/selected',
            },
          ]}
          github={[]}
          importing={false}
          connectingGitHub={false}
          canImportLocal
          canConnectGitHub={false}
          selectedProjectKey={`local:${selectedMachine}:${selectedProject}`}
          onAddLocal={vi.fn()}
          onConnectGitHub={vi.fn()}
          onBack={vi.fn()}
          onComplete={onComplete}
        />
      );
    });

    await act(async () => {
      findButton(container, 'Next').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onComplete).toHaveBeenCalledWith({
      kind: 'local',
      machineId: selectedMachine,
      localProjectId: selectedProject,
      name: 'selected',
    });
  });

  it('keeps GitHub available while the local agent is not ready', async () => {
    store.set(localProbeResultAtom, null);
    store.set(localCliStartingAtom, false);
    await act(async () => {
      root?.render(
        <TestCloudPlatformProvider>
          <Provider store={store}>
            <ProjectsScreen onBack={vi.fn()} onComplete={vi.fn()} />
          </Provider>
        </TestCloudPlatformProvider>
      );
    });

    expect(findButton(container, 'Add a local project').disabled).toBe(true);
    const githubButton = findButton(container, 'Connect a GitHub repository');
    expect(githubButton.disabled).toBe(false);
    await act(async () => {
      githubButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.createGitHubInstallState).toHaveBeenCalledWith({
      workspaceId,
      workspaceSlug: 'workspace-1',
      returnTarget: 'desktop',
    });
  });

  it('continues with the exact durable provider setup id', async () => {
    const onNext = vi.fn();
    const setup: ProviderSetupTask = {
      v: 1,
      id: 'setup-1' as ProviderSetupTask['id'],
      machineId,
      config: {
        id: 'setup-1' as ProviderSetupTask['id'],
        machineId,
        name: 'Codex',
        description: undefined,
        cliType: 'builtin',
        agentType: 'codex',
        env: {},
        prompt: '',
      },
      status: 'preparing-runtime',
      attempt: 1,
      createdAt: 10,
      updatedAt: 20,
    };

    await act(async () => {
      root?.render(
        <ProvidersScreenView
          configs={[]}
          setups={[setup]}
          testStatuses={{}}
          selectedConfigId={setup.id}
          noLocalMachine={false}
          localMachineId={machineId}
          onEdit={vi.fn()}
          onTest={vi.fn()}
          onDelete={vi.fn()}
          onAdd={vi.fn()}
          onBack={vi.fn()}
          onSkip={vi.fn()}
          onNext={onNext}
        />
      );
    });

    await act(async () => {
      findButton(container, 'Next').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onNext).toHaveBeenCalledWith(setup.id);
  });

  it('keeps provider activity compact in the badge and progress button', async () => {
    const config: AgentConfigMeta = {
      id: 'config-progress' as AgentConfigId,
      machineId,
      name: 'Codex',
      description: undefined,
      cliType: 'builtin',
      agentType: 'codex',
      env: {},
    };

    await act(async () => {
      root?.render(
        <ProvidersScreenView
          configs={[config]}
          testStatuses={{}}
          testActivities={{ [config.id]: { phase: 'downloading-runtime', percent: 64 } }}
          noLocalMachine={false}
          onEdit={vi.fn()}
          onTest={vi.fn()}
          onDelete={vi.fn()}
          onAdd={vi.fn()}
          onBack={vi.fn()}
          onSkip={vi.fn()}
          onNext={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('Downloading');
    expect(findButton(container, '64%').disabled).toBe(true);
    expect(container.textContent).not.toContain('Downloading the agent runtime');
  });

  it('keeps the latest provider failure reason on the failed badge', async () => {
    const config: AgentConfigMeta = {
      id: 'config-failed' as AgentConfigId,
      machineId,
      name: 'Codex',
      description: undefined,
      cliType: 'builtin',
      agentType: 'codex',
      env: {},
    };

    await act(async () => {
      root?.render(
        <ProvidersScreenView
          configs={[config]}
          testStatuses={{ [config.id]: 'failed' }}
          failureReasons={{ [config.id]: 'The API key was rejected.' }}
          noLocalMachine={false}
          onEdit={vi.fn()}
          onTest={vi.fn()}
          onDelete={vi.fn()}
          onAdd={vi.fn()}
          onBack={vi.fn()}
          onSkip={vi.fn()}
          onNext={vi.fn()}
        />
      );
    });

    expect(
      container.querySelector('[aria-label="Failed: The API key was rejected."]')
    ).not.toBeNull();
  });
});
