import {
  createRouter,
  createRootRoute,
  createRoute,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
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

vi.mock('convex/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('convex/react')>()),
  useAction: () => mocks.createGitHubInstallState,
}));

vi.mock('../src/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: () => [],
}));

vi.mock('../src/hooks/use-authenticated-convex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks/use-authenticated-convex')>();
  return {
    ...actual,
    useAuthenticatedConvex: () => ({ isAuthenticated: true, isLoading: false }),
  };
});

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
import { OnboardingLoadingView } from '../src/components/onboarding/onboarding-loading';
import { getDesktopOnboardingSteps } from '../src/components/onboarding/onboarding-steps';
import {
  ProjectsScreen,
  ProjectsScreenView,
} from '../src/components/onboarding/screens/projects-screen';
import { ProvidersScreenView } from '../src/components/onboarding/screens/providers-screen';
import { SummaryScreen } from '../src/components/onboarding/screens/summary-screen';
import { initI18n } from '../src/i18n';
import { TEST_CLOUD_PLATFORM, TestCloudPlatformProvider } from './test-platform';
import { PlatformContext } from '@lody/platform/react';
import { createStaticStore, type CloudApi } from '@lody/platform';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { userAtom } from '../src/atoms';
import { ErrorBoundary } from '../src/components/error-boundary';

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
    store.set(userAtom, { id: 'account' } as never);
    store.set(workspaceContentModeAtom, {
      accountId: 'account',
      workspaceId,
      workspaceSlug: 'workspace-1',
      descriptor: { workspaceId, contentMode: 'plaintext', contentModeVersion: 1 },
    });
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

  it('marks the stalled startup step as a spring probe after the bypass', async () => {
    await act(async () => {
      root?.render(<OnboardingLoadingView phase="starting" stage="fleet-start" bypassed />);
    });

    expect(container.querySelector('[data-onboarding-stalled-probe]')).not.toBeNull();
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
          loadingRepos={false}
          selectedProjectKey={`local:${selectedMachine}:${selectedProject}`}
          onAddLocal={vi.fn()}
          onConnectGitHub={vi.fn()}
          onBack={vi.fn()}
          onSkip={vi.fn()}
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

  it.each(['unknown', 'provisional'] as const)(
    'restores projects with %s mode without querying refused GitHub catalogs',
    async (state) => {
      store.set(userAtom, { id: 'account' } as never);
      store.set(
        workspaceContentModeAtom,
        state === 'unknown'
          ? null
          : { accountId: 'account', workspaceId, workspaceSlug: 'workspace-1', descriptor: null }
      );
      const platform = {
        ...TEST_CLOUD_PLATFORM,
        workspaces: {
          ...TEST_CLOUD_PLATFORM.workspaces,
          state: createStaticStore({
            status: 'ready',
            workspaces: [
              { id: workspaceId, slug: 'workspace-1', name: 'Unmarked workspace', role: 'owner' },
            ],
          } as never),
        },
        cloudApi: {
          ...TEST_CLOUD_PLATFORM.cloudApi!,
          useMutation: () => async () => {
            throw new Error('unexpected cloud mutation');
          },
          useAction: () => async () => {
            throw new Error('unexpected cloud action');
          },
          useQuery: ((_operation, args) => {
            if (args !== 'skip') throw new Error('e2ee_control_only');
            return undefined;
          }) as CloudApi['useQuery'],
        },
      };
      await act(async () =>
        root?.render(
          <PlatformContext.Provider value={platform}>
            <Provider store={store}>
              <ErrorBoundary
                fallbackRender={({ error }) => <output role="alert">{String(error)}</output>}
              >
                <ProjectsScreen onBack={vi.fn()} onSkip={vi.fn()} onComplete={vi.fn()} />
              </ErrorBoundary>
            </Provider>
          </PlatformContext.Provider>
        )
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain('Loading your repositories');
      expect(findButton(container, 'Connect a GitHub repository').disabled).toBe(true);
    }
  );

  it('keeps local projects and Back available when restored encrypted projects offer control/pairing', async () => {
    store.set(workspaceContentModeAtom, {
      accountId: 'account',
      workspaceId,
      workspaceSlug: 'workspace-1',
      descriptor: {
        workspaceId,
        contentMode: 'e2ee',
        contentModeVersion: 1,
        activation: 'control-only',
        genesisHash: 'ab'.repeat(32),
        cryptoOrgId: 'ab'.repeat(32),
      },
    });
    store.set(localProbeResultAtom, { ok: true, machineId } as never);
    mocks.useVisibleLocalProjects.mockReturnValue({
      projects: new Map([
        [
          'machine-1:local',
          {
            key: 'machine-1:local',
            machineId,
            project: { id: 'local', name: 'Kept local project', rootPath: '/synthetic/local' },
            machine: { name: 'Local' },
          },
        ],
      ]),
    });
    const back = vi.fn();
    const platform = {
      ...TEST_CLOUD_PLATFORM,
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useMutation: () => async () => {
          throw new Error('unexpected mutation');
        },
        useAction: () => async () => {
          throw new Error('unexpected action');
        },
        useQuery: ((_operation, args) => {
          if (args !== 'skip') throw new Error('e2ee_control_only');
          return undefined;
        }) as CloudApi['useQuery'],
      },
    };
    const base = createRootRoute({ component: Outlet });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
      routeTree: base.addChildren([
        createRoute({
          getParentRoute: () => base,
          path: '/onboarding',
          component: () => <ProjectsScreen onBack={back} onSkip={vi.fn()} onComplete={vi.fn()} />,
        }),
        createRoute({
          getParentRoute: () => base,
          path: '/workspace/e2ee/$workspaceId',
          component: () => <p>Control and pairing</p>,
        }),
      ]),
    });
    await act(async () => {
      await router.load();
      root?.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={store}>
            <RouterProvider router={router} />
          </Provider>
        </PlatformContext.Provider>
      );
    });
    expect(container.textContent).toContain('Kept local project');
    expect(findButton(container, 'Connect a GitHub repository').disabled).toBe(true);
    await act(async () => findButton(container, 'Back').click());
    expect(back).toHaveBeenCalledOnce();
    const control = container.querySelector<HTMLAnchorElement>('a[href*="/workspace/e2ee/"]');
    expect(control).not.toBeNull();
    const pathname = window.location.pathname;
    await act(async () => {
      control!.click();
      await router.load();
    });
    expect(router.state.location.pathname).toBe('/workspace/e2ee/workspace-1');
    expect(window.location.pathname).toBe(pathname);
    expect(container.textContent).toContain('Control and pairing');
  });

  it('keeps GitHub available while the local agent is not ready', async () => {
    store.set(localProbeResultAtom, null);
    store.set(localCliStartingAtom, false);
    await act(async () => {
      root?.render(
        <TestCloudPlatformProvider>
          <Provider store={store}>
            <ProjectsScreen onBack={vi.fn()} onSkip={vi.fn()} onComplete={vi.fn()} />
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

  it('keeps a pending setup distinct from a completed AgentConfig', async () => {
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
          selectedProviderId={setup.id}
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

    expect(findButton(container, 'Working').disabled).toBe(true);

    await act(async () => {
      findButton(container, 'Next').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onNext).toHaveBeenCalledWith({
      kind: 'providerSetup',
      providerSetupId: setup.id,
      agentName: setup.config.name,
    });
  });

  it('continues with an AgentConfig only after it is published', async () => {
    const onNext = vi.fn();
    const config: AgentConfigMeta = {
      id: 'config-ready' as AgentConfigId,
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
          selectedProviderId={config.id}
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
    expect(onNext).toHaveBeenCalledWith({
      kind: 'agentConfig',
      agentConfigId: config.id,
      agentName: config.name,
    });
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

  it('keeps failed Agent setup retryable from Summary with investigation detail', async () => {
    const retry = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('machine is offline'))
      .mockResolvedValueOnce(undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await act(async () => {
      root?.render(
        <SummaryScreen
          agentState="failed"
          agentName="Codex"
          agentFailureCode="runtime-install-failed"
          onBack={vi.fn()}
          onComplete={vi.fn()}
          onRetryAgent={retry}
        />
      );
    });

    expect(container.textContent).toContain(
      'Lody could not download the Agent runtime. Check your connection and try again.'
    );
    expect(container.textContent).not.toContain('runtime-install-failed');
    await act(async () => {
      findButton(container, 'Retry').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('machine is offline');
    expect(consoleError).toHaveBeenCalledWith(
      '[onboarding] Failed to retry Agent setup from Summary:',
      expect.any(Error)
    );
    expect(findButton(container, 'Retry').disabled).toBe(false);

    await act(async () => {
      findButton(container, 'Retry').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(retry).toHaveBeenCalledTimes(2);
  });
});
