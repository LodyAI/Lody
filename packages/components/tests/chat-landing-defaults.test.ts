import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentConfigId,
  AgentConfigMeta,
  MachineId,
  MachineViewMeta,
  MachineMeta,
} from '@lody/shared';
import {
  getChatLandingDefaultsStorageKey,
  readChatLandingDefaults,
  recordChatLandingProjectUse,
  resolvePreferredChatLandingAgentSelection,
  writeChatLandingDefaults,
} from '../src/lib/chat-landing-defaults';
import {
  createChatLandingBranchSnapshot,
  resolveChatLandingBranchSelection,
} from '../src/lib/chat-landing-branches';
import {
  LocalProjectBranchSwrCache,
  deriveLocalProjectGitStateFromMeta,
  getLocalProjectWorktreeAvailability,
  isLocalProjectMachineOffline,
  resolveLocalProjectBranchSelection,
} from '../src/lib/chat-landing-git-state';

describe('chat-landing-defaults', () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage'
  );

  const asAgentConfigId = (value: string) => value as AgentConfigId;
  const asMachineId = (value: string) => value as MachineId;

  const installWindowStorage = () => {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      key(index: number) {
        return Array.from(store.keys())[index] ?? null;
      },
      removeItem(key: string) {
        store.delete(key);
      },
      setItem(key: string, value: string) {
        store.set(key, value);
      },
    };

    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
  };

  const createConfig = (
    id: string,
    machineId: string,
    agentType: AgentConfigMeta['agentType'] = 'codex'
  ): AgentConfigMeta => ({
    id: asAgentConfigId(id),
    machineId: asMachineId(machineId),
    name: id,
    description: undefined,
    cliType: 'builtin',
    agentType,
    env: {},
  });

  const createMachine = (id: string): MachineViewMeta => ({
    id: asMachineId(id),
    name: id,
    cliVersion: '0.0.0',
    os: 'darwin',
    sessions: [],
    raceLimits: {},
  });

  afterEach(() => {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }

    if (originalLocalStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  describe('chat landing defaults storage', () => {
    it('isolates defaults between workspaces', () => {
      installWindowStorage();

      writeChatLandingDefaults('workspace-a', {
        contextType: 'github',
        repoFullName: 'loro-dev/lody',
        branch: 'main',
      });
      writeChatLandingDefaults('workspace-b', {
        contextType: 'github',
        repoFullName: 'foo/bar',
        branch: 'develop',
      });

      expect(readChatLandingDefaults('workspace-a')).toEqual({
        contextType: 'github',
        repoFullName: 'loro-dev/lody',
        branch: 'main',
      });
      expect(readChatLandingDefaults('workspace-b')).toEqual({
        contextType: 'github',
        repoFullName: 'foo/bar',
        branch: 'develop',
      });
    });
  });

  describe('last accepted project', () => {
    it.each([
      { kind: 'github', repoFullName: 'org/repo' },
      { kind: 'local', machineId: 'machine-a', localProjectId: 'project-a' },
      { kind: 'group', projectId: 'group-a' },
      { kind: 'none' },
    ] as const)('remembers $kind separately from mutable composer defaults', (project) => {
      installWindowStorage();
      writeChatLandingDefaults('workspace-a', { agentId: 'agent-a', contextType: 'chat' });
      recordChatLandingProjectUse('workspace-a', project);
      expect(readChatLandingDefaults('workspace-a')).toMatchObject({
        agentId: 'agent-a',
        lastUsedProject: project,
      });
      expect(readChatLandingDefaults('workspace-b')).toBeNull();
    });
    it('discards a corrupt remembered target without losing existing agent defaults', () => {
      installWindowStorage();
      localStorage.setItem(
        getChatLandingDefaultsStorageKey('workspace-a'),
        JSON.stringify({
          agentId: 'agent-a',
          lastUsedProject: { kind: 'local', localProjectId: 'incomplete' },
        })
      );
      expect(readChatLandingDefaults('workspace-a')).toMatchObject({ agentId: 'agent-a' });
      expect(readChatLandingDefaults('workspace-a')?.lastUsedProject).toBeUndefined();
    });
  });

  describe('resolvePreferredChatLandingAgentSelection', () => {
    it('falls back to a same-agent-type config on the required machine when the stored config belongs elsewhere', () => {
      const selection = resolvePreferredChatLandingAgentSelection({
        preferredAgentId: asAgentConfigId('claude-a'),
        preferredMachineId: asMachineId('machine-a'),
        requiredMachineId: asMachineId('machine-b'),
        executorConfigs: [
          createConfig('codex-a', 'machine-a'),
          createConfig('claude-a', 'machine-a', 'claude'),
          createConfig('claude-b', 'machine-b', 'claude'),
        ],
        machines: new Map([
          ['machine-a', createMachine('machine-a')],
          ['machine-b', createMachine('machine-b')],
        ]),
      });

      expect(selection).toEqual({
        agentId: asAgentConfigId('claude-b'),
        machineId: asMachineId('machine-b'),
      });
    });

    it('falls back to the first compatible config on the required machine when no same-type match exists', () => {
      const selection = resolvePreferredChatLandingAgentSelection({
        preferredAgentId: asAgentConfigId('codex-a'),
        preferredMachineId: asMachineId('machine-a'),
        requiredMachineId: asMachineId('machine-b'),
        executorConfigs: [
          createConfig('codex-a', 'machine-a'),
          createConfig('claude-b', 'machine-b', 'claude'),
        ],
        machines: new Map([
          ['machine-a', createMachine('machine-a')],
          ['machine-b', createMachine('machine-b')],
        ]),
      });

      expect(selection).toEqual({
        agentId: asAgentConfigId('claude-b'),
        machineId: asMachineId('machine-b'),
      });
    });

    it('returns the preferred config on its owning machine even if the stored machine id no longer resolves', () => {
      const selection = resolvePreferredChatLandingAgentSelection({
        preferredAgentId: asAgentConfigId('codex-c'),
        preferredMachineId: asMachineId('missing-machine'),
        executorConfigs: [
          createConfig('claude-b', 'machine-b', 'claude'),
          createConfig('codex-c', 'machine-c'),
        ],
        machines: new Map([
          ['machine-b', createMachine('machine-b')],
          ['machine-c', createMachine('machine-c')],
        ]),
      });

      expect(selection).toEqual({
        agentId: asAgentConfigId('codex-c'),
        machineId: asMachineId('machine-c'),
      });
    });

    it('restores the preferred machine even when only the machine id was stored', () => {
      const selection = resolvePreferredChatLandingAgentSelection({
        preferredMachineId: asMachineId('machine-b'),
        executorConfigs: [
          createConfig('codex-a', 'machine-a'),
          createConfig('claude-b', 'machine-b', 'claude'),
        ],
        machines: new Map([
          ['machine-a', createMachine('machine-a')],
          ['machine-b', createMachine('machine-b')],
        ]),
      });

      expect(selection).toEqual({
        agentId: asAgentConfigId('claude-b'),
        machineId: asMachineId('machine-b'),
      });
    });

    it('falls back to the next compatible machine in order when the stored machine is unavailable', () => {
      const selection = resolvePreferredChatLandingAgentSelection({
        preferredAgentId: asAgentConfigId('claude-a'),
        preferredMachineId: asMachineId('missing-machine'),
        executorConfigs: [
          createConfig('codex-b', 'machine-b'),
          createConfig('claude-c', 'machine-c', 'claude'),
        ],
        machines: new Map([
          ['machine-b', createMachine('machine-b')],
          ['machine-c', createMachine('machine-c')],
        ]),
      });

      expect(selection).toEqual({
        agentId: asAgentConfigId('codex-b'),
        machineId: asMachineId('machine-b'),
      });
    });

    it('returns null when the required machine has no configured agents', () => {
      const selection = resolvePreferredChatLandingAgentSelection({
        preferredAgentId: asAgentConfigId('codex-a'),
        preferredMachineId: asMachineId('machine-a'),
        requiredMachineId: asMachineId('machine-b'),
        executorConfigs: [createConfig('codex-a', 'machine-a')],
        machines: new Map([
          ['machine-a', createMachine('machine-a')],
          ['machine-b', createMachine('machine-b')],
        ]),
      });

      expect(selection).toBeNull();
    });

    it('does not fall back to another machine when the required machine is unavailable', () => {
      const selection = resolvePreferredChatLandingAgentSelection({
        preferredAgentId: asAgentConfigId('codex-a'),
        preferredMachineId: asMachineId('machine-a'),
        requiredMachineId: asMachineId('offline-local-project-machine'),
        executorConfigs: [
          createConfig('codex-a', 'machine-a'),
          createConfig('claude-b', 'machine-b', 'claude'),
        ],
        machines: new Map([
          ['machine-a', createMachine('machine-a')],
          ['machine-b', createMachine('machine-b')],
        ]),
      });

      expect(selection).toBeNull();
    });
  });
});

describe('chat-landing-branches', () => {
  describe('chat landing branches', () => {
    it('preserves the current branch when refreshed branches still include it', () => {
      const snapshot = createChatLandingBranchSnapshot(['main', 'release'], 'main');

      expect(resolveChatLandingBranchSelection(snapshot, 'release')).toBe('release');
    });

    it('falls back to a preferred available branch and clears selection for empty repositories', () => {
      expect(
        resolveChatLandingBranchSelection(
          createChatLandingBranchSnapshot(['release'], 'release'),
          'deleted'
        )
      ).toBe('release');
      expect(
        resolveChatLandingBranchSelection(createChatLandingBranchSnapshot([], null), 'main')
      ).toBeNull();
    });
  });
});

describe('chat-landing-git-state', () => {
  const machineMeta = (overrides: Partial<MachineMeta> = {}): MachineMeta =>
    ({
      id: 'machine-target' as MachineId,
      ...overrides,
    }) as MachineMeta;

  describe('local project Git selection', () => {
    it('does not synthesize a branch or offer worktrees for an empty repository', () => {
      const state = {
        git: true as const,
        branches: [],
        currentBranch: null,
        defaultBranch: null,
        githubRepoFullName: null,
        workingTree: {
          clean: true,
          staged: false,
          unstaged: false,
          untracked: false,
          conflicted: false,
        },
      };

      expect(resolveLocalProjectBranchSelection(state, null)).toBeNull();
      expect(getLocalProjectWorktreeAvailability(state)).toBe(false);
    });

    it('keeps a valid previous selection and enables worktrees when refs exist', () => {
      const state = {
        git: true as const,
        branches: ['feature/selected', 'main'],
        currentBranch: null,
        defaultBranch: 'main',
        githubRepoFullName: null,
        workingTree: {
          clean: true,
          staged: false,
          unstaged: false,
          untracked: false,
          conflicted: false,
        },
      };

      expect(resolveLocalProjectBranchSelection(state, 'feature/selected')).toBe(
        'feature/selected'
      );
      expect(getLocalProjectWorktreeAvailability(state)).toBe(true);
    });

    it('derives immediate worktree availability and default branch from synced LocalProjectMeta', () => {
      const state = deriveLocalProjectGitStateFromMeta({
        id: 'local-project-1' as never,
        name: 'Repo',
        rootPath: '/repo',
        createdAtMs: 1,
        git: true,
        defaultBranch: 'lody:branch:local:main',
        currentBranch: 'session/old-work',
      });
      expect(state).not.toBeNull();
      expect(getLocalProjectWorktreeAvailability(state)).toBe(true);
      expect(resolveLocalProjectBranchSelection(state!, null)).toBe('lody:branch:local:main');
      expect(resolveLocalProjectBranchSelection(state!, 'feat/custom-picked')).toBe(
        'feat/custom-picked'
      );

      const nonGit = deriveLocalProjectGitStateFromMeta({
        id: 'local-project-2' as never,
        name: 'Plain',
        rootPath: '/plain',
        createdAtMs: 1,
        git: false,
      });
      expect(getLocalProjectWorktreeAvailability(nonGit)).toBe(false);
    });

    it('serves stale-while-revalidate branch pages until stale TTL expires', () => {
      const cache = new LocalProjectBranchSwrCache({ freshTtlMs: 1_000, staleTtlMs: 10_000 });
      const payload = {
        git: true as const,
        currentBranch: 'main',
        defaultBranch: 'main',
        pinnedBranches: ['main'],
        branches: ['main', 'feat/a'],
        truncated: false,
        totalCount: 2,
      };
      cache.set('w:m:p:', payload, 100);
      expect(cache.get('w:m:p:', 500)).toEqual({ result: payload, isFresh: true });
      expect(cache.get('w:m:p:', 2_000)).toEqual({ result: payload, isFresh: false });
      expect(cache.get('w:m:p:', 10_200)).toBeNull();
    });
  });

  describe('local project machine liveness', () => {
    const remoteWithoutHeartbeat = {
      projectMachineId: 'machine-target' as MachineId,
      visibleLocalMachineId: 'machine-local' as MachineId,
      targetMachine: machineMeta(),
      isMachineOnline: () => false,
    };

    it('keeps an unsynced presence room unknown so the Git RPC decides on its own deadline', () => {
      expect(
        isLocalProjectMachineOffline({ ...remoteWithoutHeartbeat, presenceSynced: false })
      ).toBe(false);
    });

    it('reports a definite offline only from a synced presence room', () => {
      expect(
        isLocalProjectMachineOffline({ ...remoteWithoutHeartbeat, presenceSynced: true })
      ).toBe(true);
    });
  });
});
