// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId, WorktreeSetupScriptConfig } from '@lody/shared';
import type { VisibleLocalProjectEntry } from '../src/lib/visible-local-project-index';

const state = vi.hoisted(() => ({
  projects: new Map<string, VisibleLocalProjectEntry>(),
  online: new Set<MachineId>(),
  access: new Map(),
  setup: {} as Record<string, WorktreeSetupScriptConfig>,
  cleanup: {} as Record<string, WorktreeSetupScriptConfig>,
  requests: [] as {
    type: string;
    localProjectId: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[],
}));
vi.mock('../src/atoms', async () => {
  const { atom } = await import('jotai');
  return {
    userAtom: atom({ id: 'owner' }),
    getAllAgentConfigAtom: atom([]),
    runtimeAtom: atom({
      requestLocalProjectControl: (request: { type: string; localProjectId: string }) =>
        new Promise((resolve, reject) => state.requests.push({ ...request, resolve, reject })),
    }),
  };
});
vi.mock('../src/atoms/doc-meta', async () => ({
  sessionMetaCacheAtom: (await import('jotai')).atom({}),
}));
vi.mock('../src/atoms/local-probe', async () => ({
  localMachineIdAtom: (await import('jotai')).atom(null),
}));
vi.mock('../src/atoms/workspace-context', async () => ({
  currentWorkspaceIdAtom: (await import('jotai')).atom('workspace'),
}));
vi.mock('../src/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjects: () => ({
    projects: state.projects,
    accessByProjectKey: state.access,
    accessByMachineId: state.access,
    isLoading: false,
  }),
}));
vi.mock('../src/hooks/use-machine-online-status', () => ({
  useOnlineMachineIds: () => state.online,
}));
vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock('../src/hooks/use-legacy-workspace-query', () => ({
  useLegacyWorkspaceMutation: () => async () => {},
}));
vi.mock('../src/hooks/use-convex-error-message', () => ({ useConvexErrorMessage: () => String }));
vi.mock('../src/lib/app-platform', () => ({ useAppCapability: () => false }));
vi.mock('../src/lib/cloud-api-operations', () => ({
  cloudOperations: { localProjects: { setLocalProjectSharedWithTeam: {} } },
}));
vi.mock('../src/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../src/lib/project-history-control-client', () => ({
  canUseProjectHistoryProjectControl: () => false,
}));
vi.mock('../src/components/settings/project-settings', () => ({
  catalogFromProject: () => null,
  historyStateKey: (key: string) => key,
  sortProjectRows: (rows: unknown[]) => rows,
}));
vi.mock('../src/lib/local-storage-cache', () => ({
  worktreeSetupConfigCache: {
    readAll: () => ({ ...state.setup }),
    set: (key: string, value: WorktreeSetupScriptConfig) => {
      state.setup[key] = value;
    },
  },
  worktreeCleanupConfigCache: {
    readAll: () => ({ ...state.cleanup }),
    set: (key: string, value: WorktreeSetupScriptConfig) => {
      state.cleanup[key] = value;
    },
  },
}));

import {
  useLocalProjectsAdmin,
  type LocalProjectsAdminData,
} from '../src/hooks/use-local-projects-admin';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
let root: Root;
let container: HTMLDivElement;
let data: LocalProjectsAdminData;
function Probe({ projectKey }: { projectKey?: string | null }) {
  data = useLocalProjectsAdmin(projectKey);
  return <output>{JSON.stringify(data.sections)}</output>;
}
async function render(projectKey?: string | null) {
  await act(async () => root.render(<Probe projectKey={projectKey} />));
}
function row(id: string) {
  return data.sections.flatMap((section) => section.rows).find((row) => row.project.id === id)!;
}
async function finish(config = { scripts: { bash: 'echo fresh' } }) {
  await act(async () => {
    for (const request of state.requests)
      request.resolve({ ok: true, type: request.type, result: config });
  });
}
beforeEach(() => {
  state.projects.clear();
  state.online.clear();
  state.requests = [];
  state.setup = {};
  state.cleanup = {};
  for (let i = 0; i < 20; i++) {
    const machineId = `machine-${i}` as MachineId;
    const id = `project-${i}` as LocalProjectId;
    const key = `${machineId}:${id}`;
    state.online.add(machineId);
    state.projects.set(key, {
      key,
      machineId,
      machine: { id: machineId, name: machineId, ownerUserId: 'owner', os: 'linux' },
      project: { id, name: id, rootPath: `/projects/${id}` },
      isMachineRegistered: true,
    } as VisibleLocalProjectEntry);
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('lists all projects without script traffic, then loads only the opened project once', async () => {
  await render();
  expect(data.sections).toHaveLength(20);
  expect(state.requests).toEqual([]);
  await render('machine-3:project-3');
  expect(state.requests.map(({ type, localProjectId }) => ({ type, localProjectId }))).toEqual([
    { type: 'local-project/get-worktree-setup', localProjectId: 'project-3' },
    { type: 'local-project/get-worktree-cleanup', localProjectId: 'project-3' },
  ]);
  expect(row('project-3').isWorktreeSetupLoading).toBe(true);
  expect(row('project-4').isWorktreeSetupLoading).toBe(false);
  await finish();
  expect(row('project-3').worktreeSetup.scripts.bash).toBe('echo fresh');
  expect(state.setup['machine-3:project-3'].scripts.bash).toBe('echo fresh');
  await render(null);
  await render('machine-3:project-3');
  expect(row('project-3').isWorktreeSetupLoading).toBe(false);
  expect(state.requests).toHaveLength(2);
  await render('machine-4:project-4');
  await finish();
  expect(row('project-4').worktreeCleanup.scripts.bash).toBe('echo fresh');
});

it('renders persisted scripts during refresh and replaces them with fresh values', async () => {
  state.setup['machine-3:project-3'] = { scripts: { bash: 'echo cached' } };
  await render('machine-3:project-3');
  expect(row('project-3').worktreeSetup.scripts.bash).toBe('echo cached');
  expect(row('project-3').isWorktreeSetupLoading).toBe(false);
  await finish();
  expect(row('project-3').worktreeSetup.scripts.bash).toBe('echo fresh');
});

it('retains cached scripts on refresh failure and reports uncached load failure', async () => {
  state.setup['machine-3:project-3'] = { scripts: { bash: 'echo cached' } };
  await render('machine-3:project-3');
  await act(async () => {
    for (const request of state.requests) request.reject(new Error('unavailable'));
  });
  expect(row('project-3').worktreeSetup.scripts.bash).toBe('echo cached');
  expect(row('project-3').worktreeSetupError).toBeNull();
  expect(row('project-3').worktreeCleanupError).toBe('unavailable');
  expect(row('project-3').isWorktreeCleanupLoading).toBe(false);
});

it('waits for an opened remote project to come online without probing other projects', async () => {
  state.online.delete('machine-3' as MachineId);
  await render('machine-3:project-3');
  expect(state.requests).toEqual([]);
  state.online = new Set([...state.online, 'machine-3' as MachineId]);
  await render('machine-3:project-3');
  await finish();
  expect(row('project-3').worktreeSetup.scripts.bash).toBe('echo fresh');
  expect(row('project-4').worktreeSetup.scripts).toEqual({});
});
