import { afterEach, describe, expect, it } from 'vitest';
import type { AgentConfigId, AgentConfigMeta, MachineId, MachineViewMeta } from '@lody/shared';
import {
  getChatLandingAgentSelectionsForMachine,
  getChatLandingDefaultsStorageKey,
  readChatLandingDefaults,
  recordChatLandingProjectUse,
  resolvePreferredChatLandingAgentSelection,
  writeChatLandingDefaults,
} from '../src/lib/chat-landing-defaults';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

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
  it('persists and restores repo/project/agent selections per workspace', () => {
    installWindowStorage();
    const workspaceId = 'workspace-1';

    writeChatLandingDefaults(workspaceId, {
      contextType: 'local',
      agentId: 'agent-1',
      machineId: 'machine-1',
      repoFullName: 'loro-dev/lody',
      branch: 'main',
      localMachineId: 'machine-1',
      localProjectId: 'project-1',
      localBranch: 'feature/test',
    });

    expect(readChatLandingDefaults(workspaceId)).toEqual({
      contextType: 'local',
      agentId: 'agent-1',
      machineId: 'machine-1',
      repoFullName: 'loro-dev/lody',
      branch: 'main',
      localMachineId: 'machine-1',
      localProjectId: 'project-1',
      localBranch: 'feature/test',
    });
  });

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

  it('returns null when stored payload is invalid', () => {
    installWindowStorage();
    const workspaceId = 'workspace-1';
    localStorage.setItem(
      getChatLandingDefaultsStorageKey(workspaceId),
      JSON.stringify({ contextType: 'unsupported' })
    );
    expect(readChatLandingDefaults(workspaceId)).toBeNull();
  });

  it('is a no-op when window is unavailable', () => {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'localStorage');

    expect(readChatLandingDefaults('workspace-1')).toBeNull();
    expect(() => writeChatLandingDefaults('workspace-1', { contextType: 'chat' })).not.toThrow();
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

describe('getChatLandingAgentSelectionsForMachine', () => {
  it('keeps every provider on the selected machine in list order', () => {
    const selections = getChatLandingAgentSelectionsForMachine(
      [
        createConfig('provider-a', 'machine-a'),
        createConfig('provider-b', 'machine-a'),
        createConfig('provider-other-machine', 'machine-b'),
        createConfig('provider-c', 'machine-a'),
        createConfig('provider-d', 'machine-a'),
      ],
      asMachineId('machine-a')
    );

    expect(selections).toEqual([
      { agentId: asAgentConfigId('provider-a'), machineId: asMachineId('machine-a') },
      { agentId: asAgentConfigId('provider-b'), machineId: asMachineId('machine-a') },
      { agentId: asAgentConfigId('provider-c'), machineId: asMachineId('machine-a') },
      { agentId: asAgentConfigId('provider-d'), machineId: asMachineId('machine-a') },
    ]);
  });
});

describe('resolvePreferredChatLandingAgentSelection', () => {
  it('restores the exact stored agent and machine when still compatible', () => {
    const selection = resolvePreferredChatLandingAgentSelection({
      preferredAgentId: asAgentConfigId('codex-a'),
      preferredMachineId: asMachineId('machine-a'),
      executorConfigs: [
        createConfig('codex-a', 'machine-a'),
        createConfig('claude-a', 'machine-a', 'claude'),
      ],
      machines: new Map([
        ['machine-a', createMachine('machine-a')],
        ['machine-b', createMachine('machine-b')],
      ]),
    });

    expect(selection).toEqual({
      agentId: asAgentConfigId('codex-a'),
      machineId: asMachineId('machine-a'),
    });
  });

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

  it('falls back to the first compatible machine in order when no stored selection resolves', () => {
    const selection = resolvePreferredChatLandingAgentSelection({
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
