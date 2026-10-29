import { usePersonalGitHubAuthorization } from '../src/hooks/use-personal-github-authorization';
import { storePersonalGitHubProof } from '../src/components/settings/github-personal-authorization';
// @vitest-environment jsdom
import { ErrorBoundary } from '../src/components/error-boundary';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'jotai';
import { getMachineRoomId, type MachineId } from '@lody/shared';
import { createStaticStore, type CloudApi, type PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useVisibleMachineMetas } from '../src/hooks/use-visible-machine-metas';
import { useVisibleLocalProjectsFromMachineIndex } from '../src/hooks/use-visible-local-projects';
import { AuthenticatedConvexContext } from '../src/hooks/use-authenticated-convex';
import { WorkspaceAdmissionGate } from '../src/components/workspace-admission-gate';
import {
  SessionChatInputArea,
  type SessionChatInputAreaHandle,
} from '../src/components/sessions/session-chat-input-area';
import { userAtom } from '../src/atoms';
import {
  PromptShortcutProvider,
  usePromptShortcuts,
} from '../src/providers/prompt-shortcut-provider';
import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { WorkspaceRouteTargetProvider } from '../src/providers/workspace-route-target';
import {
  useLegacyWorkspaceQuery,
  useLegacyWorkspaceMutation,
} from '../src/hooks/use-legacy-workspace-query';
import { cloudOperations } from '../src/lib/cloud-api-operations';
import { runtimeAtom } from '../src/atoms/runtime';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { machineMetaCacheAtom } from '../src/atoms/doc-meta';
import {
  buildTourSession,
  createTourStore,
  DEFAULT_TOUR_IDENTITY,
  TOUR_USER_ID,
  TOUR_WORKSPACE_ID,
  TOUR_WORKSPACE_SLUG,
} from '../src/components/onboarding/tour/tour-fixtures';
import { TEST_CLOUD_PLATFORM } from './test-platform';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function VisibleResources() {
  const machines = useVisibleMachineMetas({ includeMachineFlock: false });
  const projects = useVisibleLocalProjectsFromMachineIndex(machines);
  return (
    <output data-machines-loading={machines.isLoading} data-projects-loading={projects.isLoading}>
      {JSON.stringify({
        machines: [...machines.machines.keys()],
        projects: [...projects.projects.values()].map((p) => p.project.name),
        loading: machines.isLoading || projects.isLoading,
      })}
    </output>
  );
}

it.each(['unpaired', 'paired'] as const)(
  'keeps %s encrypted visibility local and never queries legacy access',
  async (pairing) => {
    const store = createTourStore(DEFAULT_TOUR_IDENTITY);
    const runtime = store.get(runtimeAtom)!;
    store.set(machineMetaCacheAtom, (current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, machine]) => [
          key,
          { ...machine, ownerUserId: TOUR_USER_ID },
        ])
      )
    );
    store.set(
      runtimeAtom,
      pairing === 'paired' ? { ...runtime, accountId: TOUR_USER_ID, contentMode: 'e2ee' } : null
    );
    store.set(workspaceContentModeAtom, {
      accountId: TOUR_USER_ID,
      workspaceSlug: TOUR_WORKSPACE_SLUG,
      workspaceId: TOUR_WORKSPACE_ID,
      descriptor: {
        workspaceId: TOUR_WORKSPACE_ID,
        contentMode: 'e2ee',
        activation: 'control-only',
        contentModeVersion: 1,
        cryptoOrgId: 'ab'.repeat(32),
        genesisHash: 'ab'.repeat(32),
      },
    });
    const query: CloudApi['useQuery'] = (_operation, args) => {
      if (args !== 'skip')
        throw Object.assign(new Error('e2ee_control_only'), {
          data: { code: 'e2ee_control_only' },
        });
      return undefined;
    };
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      cloudApi: {
        ...TEST_CLOUD_PLATFORM.cloudApi!,
        useMutation: () => async () => {
          throw new Error('unexpected cloud mutation');
        },
        useAction: () => async () => {
          throw new Error('unexpected cloud action');
        },
        useQuery: query,
      },
      identity: {
        ...TEST_CLOUD_PLATFORM.identity,
        session: createStaticStore({ status: 'authenticated', user: { id: TOUR_USER_ID } }),
      },
    };
    await act(async () =>
      root.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={store}>
            <AuthenticatedConvexContext.Provider
              value={{ isAuthenticated: true, isLoading: false } as never}
            >
              <VisibleResources />
            </AuthenticatedConvexContext.Provider>
          </Provider>
        </PlatformContext.Provider>
      )
    );
    const snapshot = JSON.parse(container.querySelector('output')!.textContent!);
    expect(snapshot.loading).toBe(false);
    expect(snapshot.machines).toHaveLength(1);
    expect(snapshot.projects).toHaveLength(1);
    // A teammate's metadata in the protected workspace is not a sharing grant.
    await act(async () =>
      store.set(
        machineMetaCacheAtom,
        (current) =>
          ({
            ...current,
            [getMachineRoomId('foreign' as MachineId)]: {
              ...Object.values(current)[0],
              id: 'foreign',
              ownerUserId: 'another-user',
            },
          }) as never
      )
    );
    expect(JSON.parse(container.querySelector('output')!.textContent!).machines).toEqual(
      snapshot.machines
    );
  }
);

it('preserves ordinary visibility failures instead of swallowing an unrelated backend error', async () => {
  const store = createTourStore(DEFAULT_TOUR_IDENTITY);
  const platform = {
    ...TEST_CLOUD_PLATFORM,
    cloudApi: {
      ...TEST_CLOUD_PLATFORM.cloudApi!,
      useQuery: (_operation: unknown, args: unknown) => {
        if (args !== 'skip') throw new Error('ordinary access failure');
        return undefined;
      },
    },
  };
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={platform}>
        <Provider store={store}>
          <AuthenticatedConvexContext.Provider
            value={{ isAuthenticated: true, isLoading: false } as never}
          >
            <ErrorBoundary
              fallbackRender={({ error }) => <output role="alert">{String(error)}</output>}
            >
              <VisibleResources />
            </ErrorBoundary>
          </AuthenticatedConvexContext.Provider>
        </Provider>
      </PlatformContext.Provider>
    )
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'ordinary access failure'
  );
});

it('still renders registered ordinary machines and projects from the cloud visibility rows', async () => {
  const store = createTourStore(DEFAULT_TOUR_IDENTITY);
  const machine = Object.values(store.get(machineMetaCacheAtom))[0]!;
  const rows = [
    { machineId: machine.id, ownerUserId: TOUR_USER_ID, sharedWithTeam: false, updatedAt: 1 },
  ];
  const useQuery: CloudApi['useQuery'] = (operation, args) => {
    if (args === 'skip') return undefined;
    return (
      operation.name === 'machines:listVisibleMachines'
        ? rows
        : Object.keys(machine.localProjects!).map((localProjectId) => ({
            ...rows[0],
            localProjectId,
          }))
    ) as never;
  };
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    cloudApi: { ...TEST_CLOUD_PLATFORM.cloudApi!, useQuery },
  };
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={platform}>
        <Provider store={store}>
          <AuthenticatedConvexContext.Provider
            value={{ isAuthenticated: true, isLoading: false } as never}
          >
            <VisibleResources />
          </AuthenticatedConvexContext.Provider>
        </Provider>
      </PlatformContext.Provider>
    )
  );
  const snapshot = JSON.parse(container.querySelector('output')!.textContent!);
  expect(snapshot).toEqual({
    machines: [machine.id],
    projects: [DEFAULT_TOUR_IDENTITY.projectName],
    loading: false,
  });
});

it('keeps unknown-mode catalogs pending while the real local composer stays usable', async () => {
  const store = createTourStore(DEFAULT_TOUR_IDENTITY);
  const runtime = {
    ...store.get(runtimeAtom)!,
    accountId: TOUR_USER_ID,
    contentMode: 'plaintext' as const,
  };
  store.set(runtimeAtom, runtime);
  store.set(machineMetaCacheAtom, (current) =>
    Object.fromEntries(
      Object.entries(current).map(([key, value]) => [key, { ...value, ownerUserId: TOUR_USER_ID }])
    )
  );
  store.set(workspaceContentModeAtom, {
    accountId: TOUR_USER_ID,
    workspaceSlug: TOUR_WORKSPACE_SLUG,
    workspaceId: TOUR_WORKSPACE_ID,
    descriptor: null,
  });
  const observed: string[] = [];
  let admitted = false;
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    identity: {
      ...TEST_CLOUD_PLATFORM.identity,
      session: createStaticStore({ status: 'authenticated', user: { id: TOUR_USER_ID } }),
    },
    workspaces: {
      ...TEST_CLOUD_PLATFORM.workspaces,
      state: createStaticStore({
        status: 'ready',
        workspaces: [
          { id: TOUR_WORKSPACE_ID, slug: TOUR_WORKSPACE_SLUG, name: 'synthetic', role: 'owner' },
        ],
        activeWorkspaceId: TOUR_WORKSPACE_ID,
      }),
    },
    e2eeWorkspaces: {
      describe: async () => {
        throw new Error('The UI must consume the runtime admission, never start another describe');
      },
      create: async () => {
        throw new Error('unused');
      },
      history: async () => {
        throw new Error('unused');
      },
    },
    cloudApi: {
      useQuery: ((operation, args) => {
        if (args === 'skip') return undefined;
        observed.push(operation.name);
        if (!admitted)
          throw Object.assign(new Error('e2ee_control_only'), {
            data: { code: 'e2ee_control_only' },
          });
        return [];
      }) as CloudApi['useQuery'],
      useMutation: () => async () => {
        throw new Error('unexpected mutation');
      },
      useAction: () => async () => {
        throw new Error('unexpected action');
      },
    },
  };
  const composer = createRef<SessionChatInputAreaHandle>();
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={platform}>
        <Provider store={store}>
          <AuthenticatedConvexContext.Provider
            value={{ isAuthenticated: true, isLoading: false } as never}
          >
            <ErrorBoundary
              fallbackRender={({ error }) => <output role="alert">{String(error)}</output>}
            >
              <WorkspaceAdmissionGate workspaceName={TOUR_WORKSPACE_SLUG}>
                <VisibleResources />
                <SessionChatInputArea
                  ref={composer}
                  session={buildTourSession()}
                  isMachineRemoved={false}
                  isDark={false}
                  isEmptyConversation
                  modeOptions={[]}
                  modelOptions={[]}
                  selectedModeId={null}
                  selectedModelId={null}
                  availableCommands={[]}
                  onSendMessage={async () => false}
                  onStop={() => {}}
                  onRemoveQueueItem={async () => {}}
                  disableImageUpload
                />
              </WorkspaceAdmissionGate>
            </ErrorBoundary>
          </AuthenticatedConvexContext.Provider>
        </Provider>
      </PlatformContext.Provider>
    )
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(observed).toEqual([]);
  expect(JSON.parse(container.querySelector('output')!.textContent!)).toMatchObject({
    loading: true,
    machines: expect.any(Array),
    projects: expect.any(Array),
  });
  expect(container.querySelector('output')!.dataset.machinesLoading).toBe('true');
  expect(container.querySelector('output')!.dataset.projectsLoading).toBe('true');
  expect(JSON.parse(container.querySelector('output')!.textContent!).machines).toHaveLength(1);
  expect(JSON.parse(container.querySelector('output')!.textContent!).projects).toHaveLength(1);
  await act(async () => composer.current!.setInputText('keep this local draft'));
  expect(container.querySelector('textarea')!.value).toBe('keep this local draft');
  admitted = true;
  await act(async () =>
    store.set(workspaceContentModeAtom, {
      accountId: TOUR_USER_ID,
      workspaceSlug: TOUR_WORKSPACE_SLUG,
      workspaceId: TOUR_WORKSPACE_ID,
      descriptor: {
        workspaceId: TOUR_WORKSPACE_ID,
        contentMode: 'plaintext',
        contentModeVersion: 1,
      },
    })
  );
  expect(observed).toContain('machines:listVisibleMachines');
  expect(observed).toContain('localProjects:listVisibleLocalProjects');
  expect(JSON.parse(container.querySelector('output')!.textContent!).loading).toBe(false);
  expect(container.querySelector('output')!.dataset.machinesLoading).toBe('false');
  expect(container.querySelector('output')!.dataset.projectsLoading).toBe('false');
  expect(store.get(runtimeAtom)).toBe(runtime);
  expect(container.querySelector('textarea')!.value).toBe('keep this local draft');
});

function LegacyCatalog() {
  const repos = useLegacyWorkspaceQuery(cloudOperations.github.listWorkspaceReposWithStatus, {
    workspaceId: TOUR_WORKSPACE_ID,
  });
  return <output>{repos === undefined ? 'pending' : 'settled'}</output>;
}

it.each([
  'missing',
  'provisional',
  'other-account',
  'signed-out',
  'other-workspace',
  'other-slug',
  'other-descriptor',
  'other-route',
  'other-context',
  'unknown-version',
] as const)('keeps legacy subscriptions pending for %s admission', async (state) => {
  const store = createTourStore(DEFAULT_TOUR_IDENTITY);
  const mode = store.get(workspaceContentModeAtom)!;
  if (state === 'missing') store.set(workspaceContentModeAtom, null);
  else if (state === 'provisional')
    store.set(workspaceContentModeAtom, { ...mode, descriptor: null });
  else if (state === 'other-account')
    store.set(userAtom, { ...store.get(userAtom)!, id: 'other-account' });
  else if (state === 'signed-out') store.set(userAtom, null);
  else if (state === 'other-workspace')
    store.set(workspaceContentModeAtom, { ...mode, workspaceId: 'other-workspace' });
  else if (state === 'other-slug')
    store.set(workspaceContentModeAtom, { ...mode, workspaceSlug: 'other-slug' });
  else if (state === 'other-descriptor')
    store.set(workspaceContentModeAtom, {
      ...mode,
      descriptor: {
        workspaceId: 'other-workspace',
        contentMode: 'plaintext',
        contentModeVersion: 1,
      },
    });
  else if (state === 'other-context') store.set(currentWorkspaceIdAtom, 'other-workspace' as never);
  else if (state === 'unknown-version')
    store.set(workspaceContentModeAtom, {
      ...mode,
      descriptor: {
        workspaceId: TOUR_WORKSPACE_ID,
        contentMode: 'plaintext',
        contentModeVersion: 2,
      } as never,
    });
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    cloudApi: {
      ...TEST_CLOUD_PLATFORM.cloudApi!,
      useQuery: ((_operation, args) => {
        if (args !== 'skip') throw new Error('e2ee_control_only');
        return undefined;
      }) as CloudApi['useQuery'],
    },
  };
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={platform}>
        <Provider store={store}>
          <WorkspaceRouteTargetProvider
            slug={state === 'other-route' ? 'other-route' : TOUR_WORKSPACE_SLUG}
          >
            <AuthenticatedConvexContext.Provider
              value={{ isAuthenticated: true, isLoading: false } as never}
            >
              <ErrorBoundary
                fallbackRender={({ error }) => <output role="alert">{String(error)}</output>}
              >
                <LegacyCatalog />
                <VisibleResources />
              </ErrorBoundary>
            </AuthenticatedConvexContext.Provider>
          </WorkspaceRouteTargetProvider>
        </Provider>
      </PlatformContext.Provider>
    )
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('output')?.textContent).toBe('pending');
  expect(JSON.parse(container.querySelectorAll('output')[1]!.textContent!).loading).toBe(true);
});

it('drops legacy access across account changes and resumes only with that account admission', async () => {
  const store = createTourStore(DEFAULT_TOUR_IDENTITY);
  const firstUser = store.get(userAtom)!;
  const mode = store.get(workspaceContentModeAtom)!;
  let subscribed = false;
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    cloudApi: {
      ...TEST_CLOUD_PLATFORM.cloudApi!,
      useQuery: ((_operation, args) => {
        subscribed = args !== 'skip';
        return args === 'skip' ? undefined : [];
      }) as CloudApi['useQuery'],
    },
  };
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={platform}>
        <Provider store={store}>
          <LegacyCatalog />
        </Provider>
      </PlatformContext.Provider>
    )
  );
  expect(container.textContent).toBe('settled');
  expect(subscribed).toBe(true);
  await act(async () => store.set(userAtom, { ...firstUser, id: 'second-account' }));
  expect(container.textContent).toBe('pending');
  expect(subscribed).toBe(false);
  await act(async () =>
    store.set(workspaceContentModeAtom, {
      ...mode,
      accountId: 'second-account',
      descriptor: { workspaceId: TOUR_WORKSPACE_ID, admission: 'legacy-unclassified' },
    })
  );
  expect(container.textContent).toBe('settled');
  expect(subscribed).toBe(true);
});

function ShortcutState() {
  const shortcuts = usePromptShortcuts();
  return (
    <output>
      {JSON.stringify({
        loading: shortcuts.loading,
        entries: shortcuts.entries,
        runtime: shortcuts.runtime !== null,
      })}
    </output>
  );
}

it.each(['unknown', 'provisional', 'encrypted'] as const)(
  'keeps %s shortcut discovery inside legacy admission',
  async (state) => {
    const store = createTourStore(DEFAULT_TOUR_IDENTITY);
    const mode = store.get(workspaceContentModeAtom)!;
    store.set(
      workspaceContentModeAtom,
      state === 'unknown'
        ? null
        : state === 'provisional'
          ? { ...mode, descriptor: null }
          : {
              ...mode,
              descriptor: {
                workspaceId: TOUR_WORKSPACE_ID,
                contentMode: 'e2ee',
                contentModeVersion: 1,
                activation: 'control-only',
                genesisHash: 'ab'.repeat(32),
                cryptoOrgId: 'ab'.repeat(32),
              },
            }
    );
    const platform: PlatformProvider = {
      ...TEST_CLOUD_PLATFORM,
      identity: {
        ...TEST_CLOUD_PLATFORM.identity,
        session: createStaticStore({ status: 'authenticated', user: { id: TOUR_USER_ID } }),
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
      root.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={store}>
            <ErrorBoundary
              fallbackRender={({ error }) => <output role="alert">{String(error)}</output>}
            >
              <PromptShortcutProvider enabled>
                <ShortcutState />
                <p>chat stays mounted</p>
              </PromptShortcutProvider>
            </ErrorBoundary>
          </Provider>
        </PlatformContext.Provider>
      )
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('chat stays mounted');
    expect(JSON.parse(container.querySelector('output')!.textContent!)).toEqual({
      loading: state !== 'encrypted',
      entries: [],
      runtime: false,
    });
  }
);

it('rechecks live admission before retained mutation callbacks can send', async () => {
  const store = createTourStore(DEFAULT_TOUR_IDENTITY);
  const mode = store.get(workspaceContentModeAtom)!;
  const sent: string[] = [];
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    cloudApi: {
      ...TEST_CLOUD_PLATFORM.cloudApi!,
      useMutation: (operation) =>
        (async () => {
          sent.push(operation.name);
          return { updated: true };
        }) as never,
    },
  };
  let markRead!: (args: { itemId: string }) => Promise<unknown>;
  function Actions() {
    markRead = useLegacyWorkspaceMutation(cloudOperations.inbox.markRead);
    return <p>actions</p>;
  }
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={platform}>
        <Provider store={store}>
          <Actions />
        </Provider>
      </PlatformContext.Provider>
    )
  );
  await expect(markRead({ itemId: 'synthetic-item' })).resolves.toEqual({ updated: true });
  const retained = markRead;
  await act(async () => {
    store.set(workspaceContentModeAtom, { ...mode, descriptor: null });
    // Deliberately invoke before React commits a replacement callback.
    await expect(retained({ itemId: 'synthetic-item' })).rejects.toMatchObject({
      code: 'legacy_workspace_admission_pending',
    });
  });
  await act(async () => {
    store.set(workspaceContentModeAtom, mode);
    store.set(userAtom, { ...store.get(userAtom)!, id: 'new-account' });
    store.set(workspaceContentModeAtom, { ...mode, accountId: 'new-account' });
  });
  await expect(retained({ itemId: 'synthetic-item' })).rejects.toMatchObject({
    code: 'legacy_workspace_admission_account_changed',
  });
  expect(sent).toEqual(['inbox:markRead']);
});

it('preserves an OAuth return until ordinary mode admission is available', async () => {
  const store = createTourStore(DEFAULT_TOUR_IDENTITY);
  const mode = store.get(workspaceContentModeAtom)!;
  store.set(workspaceContentModeAtom, { ...mode, descriptor: null });
  const sent: string[] = [];
  const platform: PlatformProvider = {
    ...TEST_CLOUD_PLATFORM,
    cloudApi: {
      ...TEST_CLOUD_PLATFORM.cloudApi!,
      useAction: (operation) =>
        (async () => {
          sent.push(operation.name);
          return { success: true };
        }) as never,
    },
  };
  function Return() {
    usePersonalGitHubAuthorization(TOUR_WORKSPACE_ID, TOUR_WORKSPACE_SLUG);
    return <p>authorization</p>;
  }
  storePersonalGitHubProof('synthetic-state', 'synthetic-verifier');
  window.location.hash =
    '#github-personal=' +
    encodeURIComponent(JSON.stringify({ state: 'synthetic-state', code: 'synthetic-code' }));
  try {
    await act(async () =>
      root.render(
        <PlatformContext.Provider value={platform}>
          <Provider store={store}>
            <Return />
          </Provider>
        </PlatformContext.Provider>
      )
    );
    expect(window.location.hash).toContain('github-personal=');
    expect(sessionStorage.getItem('lody:githubPersonalAuthorization')).not.toBeNull();
    expect(sent).toEqual([]);
    await act(async () => store.set(workspaceContentModeAtom, mode));
    expect(sent).toEqual(['githubPersonalAuthorization:complete']);
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('lody:githubPersonalAuthorization')).toBeNull();
  } finally {
    window.location.hash = '';
    sessionStorage.removeItem('lody:githubPersonalAuthorization');
  }
});
