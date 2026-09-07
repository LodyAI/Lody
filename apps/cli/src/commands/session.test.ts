import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  getMachineFlockDocId,
  getSessionRoomId,
  type AcpCapabilityCacheEntry,
  type AgentConfigMeta,
  type LocalProjectGitState,
  type MachineId,
  type MachineMeta,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  createLocalProjectBranchSelector,
  normalizeLocalProjectRootPath,
} from '@lody/shared/node/local-project';

import {
  applyAgentRunConfigSelection,
  assertSupportedParentDepth,
  confirmDispatchSyncedBestEffort,
  buildLegacyMachineRestoreQueueCleanupPatch,
  buildSessionArchiveMetaPatch,
  buildSessionRestoreMetaPatch,
  filterAuthorizedMachineMetas,
  filterAuthorizedLocalProjectCandidates,
  filterCompatibleInheritedTurnConfig,
  filterCompatibleTurnConfigOptionValues,
  filterSessionMetas,
  hasNonPositionalPromptSource,
  listChildSessionIds,
  normalizeCliValue,
  rollbackPendingSessionCreate,
  renderSessionTranscript,
  renderAssistantTurnCompletion,
  deriveSessionLiveStatus,
  ensureSessionCreateWorkspaceMetaFresh,
  resolveCreateAgentSelector,
  resolveCreateCurrentSessionId,
  resolveOpenedBySessionRelation,
  resolveSessionCreateOwnerUserId,
  selectDefaultAgentConfigForCreate,
  resolveSessionRequester,
  resolveSessionCommandRequesterUserId,
  resolveChatArgs,
  resolveRenameArgs,
  resolvePromptCandidate,
  resolveTurnDispatchConfigFromInputConfig,
  resolveLocalProjectBranchForCreate,
  resolveLocalProjectCreateGitContext,
  resolveLocalProjectRefOrThrow,
  selectLocalProjectsBySelector,
  selectTargetMachineForCreate,
  shouldQueueMachineDelete,
  shouldReadStdinForChatArgResolution,
  shouldWaitForSessionCompletion,
  selectSessionTranscriptEntries,
  selectWorkspaceSummary,
  sortSessionMetas,
  toSessionTranscriptEntries,
  updateSessionActivityTimestamps,
  updateSessionActivityTimestampsBestEffort,
  validateTurnConfigOptionValues,
  validateTurnModeAndModel,
  withBuiltinDefaultTurnMode,
} from './session';

const createSessionMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 'session-id',
  machineId: 'machine-id',
  createdAt: '2026-03-10T00:00:00.000Z',
  userId: 'user-id',
  cliType: 'builtin',
  agentType: 'codex',
  ...overrides,
});

const createHistoryEntry = (overrides: Partial<SessionHistoryInput> = {}): SessionHistoryInput => ({
  id: 'history-id',
  role: 'assistant',
  timestamp: '2026-03-12T00:00:00.000Z',
  items: [],
  fileDiff: [],
  ...overrides,
});

const createLocalProjectGitState = (
  overrides: Partial<Extract<LocalProjectGitState, { git: true }>> = {}
): LocalProjectGitState => ({
  git: true,
  currentBranch: 'main',
  defaultBranch: 'main',
  branches: ['main'],
  githubRepoFullName: 'loro-dev/lody',
  workingTree: {
    clean: true,
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
  },
  ...overrides,
});

const createMachineMeta = (overrides: Partial<MachineMeta> = {}): MachineMeta => ({
  id: 'machine-id' as MachineId,
  name: 'Machine',
  type: 'local',
  lastSeen: 0,
  ...overrides,
});

const createAcpCapability = (): AcpCapabilityCacheEntry => ({
  cliType: 'builtin',
  agentType: 'codex',
  modes: [{ id: 'default', name: 'Default' }],
  models: [{ modelId: 'model-a', name: 'Model A' }],
  configOptions: [
    {
      id: 'approval_policy',
      name: 'Approval policy',
      type: 'select',
      currentValue: 'on-request',
      options: [
        { value: 'on-request', name: 'On request' },
        { value: 'never', name: 'Never' },
      ],
    },
    {
      id: 'web_search',
      name: 'Web search',
      type: 'boolean',
      currentValue: false,
      options: [],
    },
  ],
  fetchedAt: 1,
});

describe('session command helpers', () => {
  it('uses one hard Meta read across request validation and accepted create materialization', async () => {
    const syncMetaOrThrow = vi.fn(async () => undefined);
    const manager = { syncMetaOrThrow };
    const workspaceId = 'workspace-id' as WorkspaceId;

    await ensureSessionCreateWorkspaceMetaFresh({
      manager,
      workspaceId,
      prewriteSatisfied: false,
    });
    await ensureSessionCreateWorkspaceMetaFresh({
      manager,
      workspaceId,
      prewriteSatisfied: true,
    });

    expect(syncMetaOrThrow).toHaveBeenCalledTimes(1);
    expect(syncMetaOrThrow).toHaveBeenCalledWith({
      reason: 'session.create:workspace-id:prewrite',
    });
  });

  it('normalizes blank CLI values to undefined', () => {
    expect(normalizeCliValue('   ')).toBeUndefined();
    expect(normalizeCliValue(' value ')).toBe('value');
  });

  it('records both the root Session and exact child Tab that opened a Session', () => {
    expect(
      resolveOpenedBySessionRelation(
        createSessionMeta({
          id: 'child-tab' as SessionId,
          parentSessionId: 'root-session' as SessionId,
        })
      )
    ).toEqual({
      openedBySessionId: 'child-tab',
      openedByRootSessionId: 'root-session',
    });
    expect(
      resolveOpenedBySessionRelation(createSessionMeta({ id: 'root-session' as SessionId }))
    ).toEqual({ openedBySessionId: 'root-session' });
  });

  it('materializes automatic approval defaults for builtin agent turns', () => {
    expect(withBuiltinDefaultTurnMode({}, createSessionMeta())).toEqual({
      modeId: 'agent-auto-review',
    });
    expect(withBuiltinDefaultTurnMode({}, createSessionMeta({ agentType: 'claude' }))).toEqual({
      modeId: 'auto',
    });
    expect(withBuiltinDefaultTurnMode({}, createSessionMeta({ agentType: 'kimi' }))).toEqual({
      modeId: 'auto',
    });
  });

  it('does not replace explicit or non-builtin turn modes', () => {
    expect(withBuiltinDefaultTurnMode({ modeId: 'plan' }, createSessionMeta())).toEqual({
      modeId: 'plan',
    });
    expect(
      withBuiltinDefaultTurnMode(
        { configOptionValues: { mode: 'plan' } },
        createSessionMeta({ agentType: 'kimi' })
      )
    ).toEqual({ configOptionValues: { mode: 'plan' } });
    expect(withBuiltinDefaultTurnMode({}, createSessionMeta({ cliType: 'registry' }))).toEqual({});
  });

  it('picks prompt candidates by explicit precedence', () => {
    expect(
      resolvePromptCandidate({
        prompt: 'from-prompt',
        promptFileContent: 'from-file',
        positionalPrompt: 'from-position',
        stdinText: 'from-stdin',
      })
    ).toBe('from-prompt');

    expect(
      resolvePromptCandidate({
        promptFileContent: 'from-file',
        positionalPrompt: 'from-position',
        stdinText: 'from-stdin',
      })
    ).toBe('from-file');
  });

  it('selects workspaces by explicit selector or the only candidate', () => {
    const workspaces = [
      { id: 'ws-1', slug: 'alpha', name: 'Alpha', role: 'member' },
      { id: 'ws-2', slug: 'beta', name: 'Beta', role: 'member' },
    ];

    expect(selectWorkspaceSummary(workspaces, 'beta')).toEqual(workspaces[1]);
    expect(
      selectWorkspaceSummary([{ id: 'ws-3', slug: null, name: 'Solo', role: 'owner' }])
    ).toEqual({
      id: 'ws-3',
      slug: null,
      name: 'Solo',
      role: 'owner',
    });
  });

  it('throws when workspace selection is ambiguous', () => {
    expect(() =>
      selectWorkspaceSummary([
        { id: 'ws-1', slug: 'alpha', name: 'Alpha', role: 'member' },
        { id: 'ws-2', slug: 'beta', name: 'Beta', role: 'member' },
      ])
    ).toThrow(/Multiple workspaces/);
  });

  it('filters and sorts sessions using archive state and activity time', () => {
    const sessions = [
      createSessionMeta({
        id: 'old-active',
        createdAt: '2026-03-08T00:00:00.000Z',
      }),
      createSessionMeta({
        id: 'new-archived',
        createdAt: '2026-03-09T00:00:00.000Z',
        isArchived: true,
      }),
      createSessionMeta({
        id: 'recent-active',
        createdAt: '2026-03-07T00:00:00.000Z',
        lastMessageAt: Date.parse('2026-03-10T12:00:00.000Z'),
        openedBySessionId: 'parent-session' as SessionId,
      }),
    ];

    expect(filterSessionMetas(sessions, {}).map((session) => session.id)).toEqual([
      'old-active',
      'recent-active',
    ]);
    expect(
      filterSessionMetas(sessions, { archivedOnly: true }).map((session) => session.id)
    ).toEqual(['new-archived']);
    expect(
      filterSessionMetas(sessions, {
        openedBySessionId: 'parent-session' as SessionId,
      }).map((session) => session.id)
    ).toEqual(['recent-active']);
    expect(sortSessionMetas(sessions).map((session) => session.id)).toEqual([
      'recent-active',
      'new-archived',
      'old-active',
    ]);
  });

  it('filters machine selectors to authorized machine ids before selection', () => {
    const authorizedMachine = createMachineMeta({
      id: 'authorized-machine' as MachineId,
      name: 'shared-name',
    });
    const unauthorizedMachine = createMachineMeta({
      id: 'unauthorized-machine' as MachineId,
      name: 'shared-name',
    });

    expect(
      filterAuthorizedMachineMetas(
        [authorizedMachine, unauthorizedMachine],
        new Set<MachineId>(['authorized-machine' as MachineId])
      )
    ).toEqual([authorizedMachine]);
  });

  it('defaults create target machine to the supplied current-session machine', () => {
    const authMachine = createMachineMeta({ id: 'auth-machine' as MachineId });
    const currentSessionMachine = createMachineMeta({ id: 'current-session-machine' as MachineId });

    expect(
      selectTargetMachineForCreate({
        authorizedMachines: [authMachine, currentSessionMachine],
        authMachineId: authMachine.id,
        defaultMachineId: currentSessionMachine.id,
      })
    ).toEqual(currentSessionMachine);

    expect(
      selectTargetMachineForCreate({
        authorizedMachines: [authMachine, currentSessionMachine],
        authMachineId: authMachine.id,
        defaultMachineId: currentSessionMachine.id,
        machineSelector: authMachine.id,
      })
    ).toEqual(authMachine);
  });

  it('binds session command requester identity to CLI auth', () => {
    expect(() =>
      resolveSessionCommandRequesterUserId({ userId: 'machine-owner' }, 'current-session-user')
    ).toThrow('Requester identity must match the authenticated CLI user.');
    expect(resolveSessionCommandRequesterUserId({ userId: 'machine-owner' }, 'machine-owner')).toBe(
      'machine-owner'
    );
    expect(resolveSessionCommandRequesterUserId({ userId: 'machine-owner' }, '   ')).toBe(
      'machine-owner'
    );
  });

  it('keeps delegated requester identity separate from the authenticated executor', () => {
    const delegatedRequester = { userId: 'collaborator-b' };
    expect(
      resolveSessionRequester({ userId: 'machine-owner-a' }, undefined, delegatedRequester)
    ).toEqual({ userId: 'collaborator-b', isDelegated: true });
    expect(
      resolveSessionRequester({ userId: 'machine-owner-c' }, undefined, delegatedRequester)
    ).toEqual({ userId: 'collaborator-b', isDelegated: true });
    expect(() =>
      resolveSessionRequester({ userId: 'machine-owner-a' }, 'someone-else', delegatedRequester)
    ).toThrow('Requester identity must match the delegated Session requester.');
  });

  it('keeps Session ownership separate from the authenticated requester', () => {
    expect(resolveSessionCreateOwnerUserId('machine-owner', 'session-owner')).toBe('session-owner');
    expect(resolveSessionCreateOwnerUserId('machine-owner', '   ')).toBe('machine-owner');
  });

  it('does not report idle live status when live session presence is unavailable', () => {
    expect(deriveSessionLiveStatus({ online: true })).toEqual({
      state: 'unavailable',
      source: 'none',
      reason: 'Session live status is unavailable.',
    });
  });

  it('reports target-machine live status without consulting durable session metadata', () => {
    expect(deriveSessionLiveStatus({ online: true, state: 'waiting' })).toEqual({
      state: 'waiting',
      source: 'machine',
    });
  });

  it('validates ACP config option ids, types, and select values before dispatch', () => {
    const capability = createAcpCapability();
    expect(() =>
      validateTurnConfigOptionValues({ approval_policy: 'never', web_search: true }, capability)
    ).not.toThrow();
    expect(() => validateTurnConfigOptionValues({ unknown: true }, capability)).toThrow(
      /Unknown ACP config option/
    );
    expect(() => validateTurnConfigOptionValues({ approval_policy: false }, capability)).toThrow(
      /expects a select value/
    );
    expect(() =>
      validateTurnConfigOptionValues({ approval_policy: 'invalid' }, capability)
    ).toThrow(/Allowed values/);
    expect(() => validateTurnConfigOptionValues({ web_search: 'true' }, capability)).toThrow(
      /expects a boolean value/
    );
  });

  it('resolves a semantic run config selection against the target agent capabilities', () => {
    const capability: AcpCapabilityCacheEntry = {
      ...createAcpCapability(),
      configOptions: [
        ...(createAcpCapability().configOptions ?? []),
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [{ value: 'high', name: 'High' }],
        },
      ],
    };

    expect(
      applyAgentRunConfigSelection(
        {
          configOptionValues: { approval_policy: 'never' },
          runConfig: { modelId: 'model-a', reasoningEffort: 'high' },
        },
        capability
      ).config
    ).toEqual({
      modelId: 'model-a',
      configOptionValues: { approval_policy: 'never', reasoning_effort: 'high' },
    });

    // No selection: the config passes through untouched, capability or not.
    expect(applyAgentRunConfigSelection({ modeId: 'default' }, undefined).config).toEqual({
      modeId: 'default',
    });

    expect(() =>
      applyAgentRunConfigSelection({ runConfig: { fastMode: true } }, capability)
    ).toThrow(/does not offer a fast mode option/);
  });

  it('validates effort against the selected model and skips the probed-model snapshot check', () => {
    const capability: AcpCapabilityCacheEntry = {
      ...createAcpCapability(),
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'model-a',
          options: [
            { value: 'model-a', name: 'Model A' },
            { value: 'model-b', name: 'Model B' },
          ],
        },
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          // Snapshot taken while model-a was current.
          currentValue: 'medium',
          options: [{ value: 'medium', name: 'Medium' }],
        },
      ],
      models: [],
      modelReasoningEfforts: { 'model-a': ['medium'], 'model-b': ['medium', 'xhigh'] },
    };

    const requested = applyAgentRunConfigSelection(
      { runConfig: { modelId: 'model-b', reasoningEffort: 'xhigh' } },
      capability
    );

    expect(requested.config.configOptionValues).toEqual({ reasoning_effort: 'xhigh' });
    expect(requested.validatedConfigIds.has('reasoning_effort')).toBe(true);
    // `xhigh` is absent from the probed model's option list, so the snapshot
    // check must skip it rather than reject a value valid for model-b.
    expect(() =>
      validateTurnConfigOptionValues(
        requested.config.configOptionValues,
        capability,
        requested.validatedConfigIds
      )
    ).not.toThrow();
    expect(() =>
      validateTurnConfigOptionValues(requested.config.configOptionValues, capability)
    ).toThrow(/Allowed values/);
  });

  it('drops inherited ACP config options that are no longer compatible', () => {
    expect(
      filterCompatibleTurnConfigOptionValues(
        { approval_policy: 'never', web_search: 'true', removed: false },
        createAcpCapability()
      )
    ).toEqual({ approval_policy: 'never' });
  });

  it('validates explicit mode and model selectors against agent capabilities', () => {
    const capability = createAcpCapability();
    expect(() =>
      validateTurnModeAndModel({ modeId: 'default', modelId: 'model-a' }, capability)
    ).not.toThrow();
    expect(() => validateTurnModeAndModel({ modeId: 'plan' }, capability)).toThrow(
      'Unsupported ACP mode'
    );
    expect(() => validateTurnModeAndModel({ modelId: 'model-b' }, capability)).toThrow(
      'Unsupported ACP model'
    );
    expect(() => validateTurnModeAndModel({ modeId: 'default' }, undefined)).toThrow(
      'Unsupported ACP mode'
    );
  });

  it('drops incompatible inherited mode and model selectors', () => {
    expect(
      filterCompatibleInheritedTurnConfig(
        {
          modeId: 'plan',
          modelId: 'model-a',
          configOptionValues: { approval_policy: 'never' },
        },
        createAcpCapability()
      )
    ).toEqual({
      modelId: 'model-a',
      configOptionValues: { approval_policy: 'never' },
    });
  });

  it('accepts mode and model selectors advertised as ACP config options', () => {
    const capability: AcpCapabilityCacheEntry = {
      ...createAcpCapability(),
      modes: [],
      models: [],
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'plan',
          options: [{ value: 'plan', name: 'Plan' }],
        },
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'model-b',
          options: [{ value: 'model-b', name: 'Model B' }],
        },
      ],
    };
    expect(() =>
      validateTurnModeAndModel({ modeId: 'plan', modelId: 'model-b' }, capability)
    ).not.toThrow();
  });

  it('sorts sessions with invalid createdAt timestamps deterministically', () => {
    const sessions = [
      createSessionMeta({
        id: 'z-session',
        createdAt: 'not-a-date',
      }),
      createSessionMeta({
        id: 'a-session',
        createdAt: 'still-not-a-date',
      }),
    ];

    expect(sortSessionMetas(sessions).map((session) => session.id)).toEqual([
      'z-session',
      'a-session',
    ]);
  });

  it('resolves rename args from explicit title, positional title, and env fallback', () => {
    expect(
      resolveRenameArgs({
        sessionIdArg: 'session-1',
        titleArg: 'Renamed from positional',
      })
    ).toEqual({
      sessionId: 'session-1',
      title: 'Renamed from positional',
    });

    expect(
      resolveRenameArgs({
        sessionIdArg: 'session-1',
        optionTitle: 'Renamed from option',
      })
    ).toEqual({
      sessionId: 'session-1',
      title: 'Renamed from option',
    });

    expect(
      resolveRenameArgs({
        optionTitle: 'Renamed using env fallback',
        envSessionId: 'session-from-env',
      })
    ).toEqual({
      sessionId: 'session-from-env',
      title: 'Renamed using env fallback',
    });
  });

  it('rejects rename args when the title is missing', () => {
    expect(() =>
      resolveRenameArgs({
        sessionIdArg: 'session-1',
      })
    ).toThrow(/Missing title/);

    expect(() =>
      resolveRenameArgs({
        sessionIdArg: 'session-2',
        envSessionId: 'session-from-env',
      })
    ).toThrow(/Missing title/);
  });

  it('resolves chat args from explicit session id or env fallback', () => {
    expect(
      resolveChatArgs({
        sessionIdArg: 'session-1',
        promptArg: 'prompt from second positional',
      })
    ).toEqual({
      sessionId: 'session-1',
      positionalPrompt: 'prompt from second positional',
    });

    expect(
      resolveChatArgs({
        sessionIdArg: 'prompt from first positional',
        envSessionId: 'session-from-env',
      })
    ).toEqual({
      sessionId: 'session-from-env',
      positionalPrompt: 'prompt from first positional',
    });

    expect(
      resolveChatArgs({
        sessionIdArg: 'session-explicit',
        envSessionId: 'session-from-env',
        hasNonPositionalPromptSource: true,
      })
    ).toEqual({
      sessionId: 'session-explicit',
    });
  });

  it('resolves --agent as a create alias for --agent-config', () => {
    expect(resolveCreateAgentSelector({ agent: 'Codex' })).toBe('Codex');
    expect(resolveCreateAgentSelector({ agentConfig: 'cfg-1' })).toBe('cfg-1');
    expect(resolveCreateAgentSelector({ agent: 'cfg-1', agentConfig: 'cfg-1' })).toBe('cfg-1');
    expect(() => resolveCreateAgentSelector({ agent: 'cfg-1', agentConfig: 'cfg-2' })).toThrow(
      /either --agent or --agent-config/
    );
  });

  it('uses the same default agent config rules for create and create_options', () => {
    const configs = [
      {
        id: 'other-kind',
        machineId: 'machine-id',
        name: 'Claude',
        cliType: 'builtin',
        agentType: 'claude',
        env: {},
      },
      {
        id: 'same-kind',
        machineId: 'machine-id',
        name: 'Codex',
        cliType: 'builtin',
        agentType: 'codex',
        env: {},
      },
    ] satisfies AgentConfigMeta[];
    const currentSession = createSessionMeta({ agentConfigId: 'deleted-config' });

    expect(
      selectDefaultAgentConfigForCreate(configs, 'machine-id' as MachineId, currentSession)?.id
    ).toBe('same-kind');
    expect(
      selectDefaultAgentConfigForCreate(
        [...configs, { ...configs[1]!, id: 'same-kind-2' }],
        'machine-id' as MachineId,
        currentSession
      )
    ).toBeUndefined();
  });

  it('filters frozen inherited config against the resolved target agent kind', () => {
    const frozenInput = {
      cliType: 'builtin' as const,
      agentType: 'codex',
      modeId: 'plan',
      modelId: 'gpt-5',
      configOptionValues: { fast: true },
    };
    expect(
      resolveTurnDispatchConfigFromInputConfig(frozenInput, {
        id: 'claude',
        machineId: 'machine-id',
        name: 'Claude',
        cliType: 'builtin',
        agentType: 'claude',
        env: {},
      })
    ).toBeUndefined();
    expect(
      resolveTurnDispatchConfigFromInputConfig(frozenInput, {
        id: 'codex',
        machineId: 'machine-id',
        name: 'Codex',
        cliType: 'builtin',
        agentType: 'codex',
        env: {},
      })
    ).toMatchObject({
      modeId: 'plan',
      modelId: 'gpt-5',
      configOptionValues: { fast: true },
    });
  });

  it('resolves create current session id from explicit options before legacy env', () => {
    expect(
      resolveCreateCurrentSessionId({ currentSessionId: 'mcp-current-session' as SessionId }, {})
    ).toBe('mcp-current-session');
    expect(
      resolveCreateCurrentSessionId(
        { currentSessionId: 'mcp-current-session' as SessionId },
        { LODY_SESSION_ID: 'legacy-session' }
      )
    ).toBe('mcp-current-session');
    expect(resolveCreateCurrentSessionId({}, { LODY_SESSION_ID: 'legacy-session' })).toBe(
      'legacy-session'
    );
    expect(resolveCreateCurrentSessionId({}, {})).toBeUndefined();
  });

  it('rejects nested child sessions but accepts a root parent', () => {
    expect(() => assertSupportedParentDepth(undefined)).not.toThrow();
    expect(() => assertSupportedParentDepth({ parentSessionId: undefined })).not.toThrow();
    expect(() =>
      assertSupportedParentDepth({ parentSessionId: 'root-session' as SessionId })
    ).toThrow(/Nested child sessions are not supported.*root-session/);
  });

  it('treats stdin as a prompt source only when it actually has content', () => {
    expect(hasNonPositionalPromptSource({ stdinText: undefined })).toBe(false);
    expect(hasNonPositionalPromptSource({ stdinText: 'prompt from stdin' })).toBe(true);
    expect(hasNonPositionalPromptSource({ promptFile: '-' })).toBe(true);
  });

  it('only pre-reads stdin for chat arg resolution when env fallback is ambiguous', () => {
    expect(
      shouldReadStdinForChatArgResolution({
        sessionIdArg: 'session-1',
        envSessionId: 'session-from-env',
        prompt: 'prompt from option',
        stdinIsTty: false,
      })
    ).toBe(false);

    expect(
      shouldReadStdinForChatArgResolution({
        sessionIdArg: 'session-1',
        envSessionId: 'session-from-env',
        stdinIsTty: false,
      })
    ).toBe(true);

    expect(
      shouldReadStdinForChatArgResolution({
        sessionIdArg: 'session-1',
        envSessionId: 'session-from-env',
        stdinIsTty: true,
      })
    ).toBe(false);
  });

  it('swallows rollback cleanup failures so the original create error can propagate', async () => {
    const deleteDoc = vi.fn(async () => {
      throw new Error('delete failed');
    });
    const cleanSessionDoc = vi.fn(async () => {
      throw new Error('clean failed');
    });
    const warn = vi.fn();

    await expect(
      rollbackPendingSessionCreate(
        {
          repo: { deleteDoc },
          cleanSessionDoc,
        },
        'session-1',
        { warn }
      )
    ).resolves.toBeUndefined();

    expect(deleteDoc).toHaveBeenCalledWith('session-session-1');
    expect(cleanSessionDoc).toHaveBeenCalledWith('session-1', { preserveStatus: true });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the dispatch doc sync is not confirmed, and skips meta sync', async () => {
    const waitUntilSynced = vi.fn(async () => false);
    const waitUntilMetaSynced = vi.fn(async () => true);
    const warn = vi.fn();

    await expect(
      confirmDispatchSyncedBestEffort({
        manager: { waitUntilMetaSynced },
        sessionDoc: { waitUntilSynced },
        reason: 'session.create:session-1',
        logger: { warn },
      })
    ).resolves.toBeUndefined();

    expect(waitUntilSynced).toHaveBeenCalledTimes(1);
    // A stranded doc sync must not proceed to meta confirmation or throw; the
    // durable dispatch pointer owns delivery. It only warns.
    expect(waitUntilMetaSynced).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the dispatch doc sync wait rejects', async () => {
    const waitUntilSynced = vi.fn(async () => {
      throw new Error('transport down');
    });
    const waitUntilMetaSynced = vi.fn(async () => true);
    const warn = vi.fn();

    await expect(
      confirmDispatchSyncedBestEffort({
        manager: { waitUntilMetaSynced },
        sessionDoc: { waitUntilSynced },
        reason: 'session.chat:session-1:turn-1',
        logger: { warn },
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('confirms workspace meta after the dispatch doc sync succeeds, without warning', async () => {
    const waitUntilSynced = vi.fn(async () => true);
    const waitUntilMetaSynced = vi.fn(async () => true);
    const warn = vi.fn();

    await expect(
      confirmDispatchSyncedBestEffort({
        manager: { waitUntilMetaSynced },
        sessionDoc: { waitUntilSynced },
        reason: 'session.create:session-1',
        logger: { warn },
      })
    ).resolves.toBeUndefined();

    expect(waitUntilMetaSynced).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not start workspace meta confirmation before dispatch doc confirmation settles', async () => {
    let resolveDocSync!: (synced: boolean) => void;
    const waitUntilSynced = vi.fn(
      async () =>
        await new Promise<boolean>((resolve) => {
          resolveDocSync = resolve;
        })
    );
    const waitUntilMetaSynced = vi.fn(async () => true);

    const confirmation = confirmDispatchSyncedBestEffort({
      manager: { waitUntilMetaSynced },
      sessionDoc: { waitUntilSynced },
      reason: 'session.create:session-1',
    });
    await Promise.resolve();
    expect(waitUntilMetaSynced).not.toHaveBeenCalled();

    resolveDocSync(true);
    await confirmation;
    expect(waitUntilMetaSynced).toHaveBeenCalledTimes(1);
  });

  it('does not throw when workspace meta sync is not confirmed', async () => {
    const waitUntilSynced = vi.fn(async () => true);
    const waitUntilMetaSynced = vi.fn(async () => false);
    const warn = vi.fn();

    await expect(
      confirmDispatchSyncedBestEffort({
        manager: { waitUntilMetaSynced },
        sessionDoc: { waitUntilSynced },
        reason: 'session.create:session-1',
        logger: { warn },
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('only queues machine-side deletion for sessions with repo-backed resources', () => {
    expect(shouldQueueMachineDelete(createSessionMeta({ repoFullName: 'owner/repo' }))).toBe(true);
    expect(
      shouldQueueMachineDelete(
        createSessionMeta({
          parentSessionId: 'parent-session' as SessionId,
          repoFullName: 'owner/repo',
          isWorktree: true,
        })
      )
    ).toBe(false);
    expect(
      shouldQueueMachineDelete(
        createSessionMeta({
          repoFullName: '   ',
        })
      )
    ).toBe(false);
    expect(shouldQueueMachineDelete(createSessionMeta())).toBe(false);
  });

  it('lists child sessions for lifecycle cascade commands', async () => {
    const parentSessionId = 'parent-session' as SessionId;
    const childSessionId = 'child-session' as SessionId;
    const otherSessionId = 'other-session' as SessionId;
    const getDocMeta = vi.fn(async (roomId: string) => {
      if (roomId === getSessionRoomId(parentSessionId)) {
        return { meta: createSessionMeta({ id: parentSessionId }) };
      }
      if (roomId === getSessionRoomId(childSessionId)) {
        return {
          meta: createSessionMeta({
            id: childSessionId,
            parentSessionId,
          }),
        };
      }
      if (roomId === getSessionRoomId(otherSessionId)) {
        return { meta: createSessionMeta({ id: otherSessionId }) };
      }
      return undefined;
    });
    const manager = {
      repo: {
        getMeta: () => ({
          scan: vi.fn(async () => [
            { key: ['e', getSessionRoomId(parentSessionId)], value: true },
            { key: ['e', getSessionRoomId(childSessionId)], value: true },
            { key: ['e', getSessionRoomId(otherSessionId)], value: true },
          ]),
        }),
        getDocMeta,
      },
    } as any;

    await expect(listChildSessionIds(manager, parentSessionId)).resolves.toEqual([childSessionId]);
  });

  it('builds archive and restore patches without changing archive semantics', () => {
    expect(buildSessionArchiveMetaPatch()).toEqual({
      isArchived: true,
      status: { type: 'idle' },
    });
    expect(buildSessionRestoreMetaPatch()).toEqual({
      isArchived: false,
    });

    expect(
      buildLegacyMachineRestoreQueueCleanupPatch('session-1', {
        needToArchiveSessions: { 'session-1': true, 'session-2': true },
        needToDeleteSessions: {
          'session-1': { requestedAt: 2000 },
          'session-3': { requestedAt: 2000 },
        },
      })
    ).toEqual({
      needToArchiveSessions: { 'session-2': true },
      needToDeleteSessions: {
        'session-3': { requestedAt: 2000 },
      },
    });
    expect(
      buildLegacyMachineRestoreQueueCleanupPatch('session-1', {
        needToArchiveSessions: { 'session-2': true },
        needToDeleteSessions: {},
      })
    ).toBeNull();
  });

  it('matches local project selectors against normalized paths', () => {
    const project = {
      id: 'local-project-1',
      name: 'lody',
      rootPath: normalizeLocalProjectRootPath(process.cwd()),
    };

    expect(selectLocalProjectsBySelector([project], '.')).toEqual([project]);
    expect(selectLocalProjectsBySelector([project], `${process.cwd()}${path.sep}`)).toEqual([
      project,
    ]);
  });

  it('filters local project candidates to authorized project ids before selection', () => {
    const authorizedProject = {
      id: 'authorized-project',
      name: 'shared',
      rootPath: '/workspace/shared',
    };
    const unauthorizedProject = {
      id: 'unauthorized-project',
      name: 'private',
      rootPath: '/workspace/private',
    };

    expect(
      filterAuthorizedLocalProjectCandidates(
        [authorizedProject, unauthorizedProject],
        new Set(['authorized-project'])
      )
    ).toEqual([authorizedProject]);
  });

  it('marks local project refs for worktree session creation', async () => {
    const rootPath = mkdtempSync(path.join(os.tmpdir(), 'lody-session-git-project-'));
    try {
      execFileSync('git', ['init'], { cwd: rootPath, stdio: 'ignore' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--allow-empty',
          '-m',
          'init',
        ],
        { cwd: rootPath, stdio: 'ignore' }
      );
      const syncFlockDocOrThrow = vi.fn(async () => undefined);
      const manager = {
        syncFlockDocOrThrow,
        repo: {
          getDocMeta: vi.fn(async () => ({
            meta: {
              localProjects: {
                'local-project-1': {
                  id: 'local-project-1',
                  name: 'lody',
                  rootPath,
                  createdAtMs: 1,
                },
              },
            },
          })),
          openFlockDoc: vi.fn(async () => ({
            flock: {
              scan: () => [],
            },
          })),
        },
      } as unknown as Parameters<typeof resolveLocalProjectRefOrThrow>[0];

      await expect(
        resolveLocalProjectRefOrThrow(
          manager,
          'workspace-1' as WorkspaceId,
          'machine-id' as MachineId,
          'lody',
          undefined,
          true
        )
      ).resolves.toMatchObject({
        kind: 'local',
        localProjectId: 'local-project-1',
        useWorktree: true,
      });
      expect(syncFlockDocOrThrow).toHaveBeenCalledWith(
        getMachineFlockDocId('workspace-1' as WorkspaceId, 'machine-id' as MachineId),
        expect.objectContaining({ reason: 'session.local-projects:machine-id' })
      );

      await expect(
        resolveLocalProjectRefOrThrow(
          manager,
          'workspace-1' as WorkspaceId,
          'machine-id' as MachineId,
          'lody'
        )
      ).resolves.toEqual({
        kind: 'local',
        localProjectId: 'local-project-1',
      });
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('does not synthesize a branch for non-git local projects', async () => {
    const rootPath = mkdtempSync(path.join(os.tmpdir(), 'lody-session-non-git-'));
    try {
      expect(await resolveLocalProjectBranchForCreate({ rootPath })).toBeUndefined();
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('does not capture the current branch for a direct local project session', async () => {
    const rootPath = mkdtempSync(path.join(os.tmpdir(), 'lody-session-direct-local-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: rootPath, stdio: 'ignore' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--allow-empty',
          '-m',
          'init',
        ],
        { cwd: rootPath, stdio: 'ignore' }
      );

      await expect(resolveLocalProjectBranchForCreate({ rootPath })).resolves.toBeUndefined();
      await expect(
        resolveLocalProjectBranchForCreate({ rootPath }, undefined, { requireGit: true })
      ).resolves.toBe('main');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('rejects worktrees for non-git local projects', async () => {
    const rootPath = mkdtempSync(path.join(os.tmpdir(), 'lody-session-non-git-'));
    try {
      await expect(
        resolveLocalProjectBranchForCreate({ rootPath }, undefined, { requireGit: true })
      ).rejects.toThrow(/--worktree/);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('rejects explicit branches for non-git local projects', async () => {
    const rootPath = mkdtempSync(path.join(os.tmpdir(), 'lody-session-non-git-'));
    try {
      await expect(
        resolveLocalProjectBranchForCreate({ rootPath }, 'feature/test')
      ).rejects.toThrow(/not a git repository/);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('does not synthesize a branch for an empty git repository', async () => {
    const rootPath = mkdtempSync(path.join(os.tmpdir(), 'lody-session-empty-git-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: rootPath, stdio: 'ignore' });

      await expect(resolveLocalProjectBranchForCreate({ rootPath })).resolves.toBeUndefined();
      await expect(
        resolveLocalProjectBranchForCreate({ rootPath }, undefined, { requireGit: true })
      ).rejects.toThrow(/does not have a branch to use as a worktree base/);
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('rejects an explicit missing branch before session creation', async () => {
    const rootPath = mkdtempSync(path.join(os.tmpdir(), 'lody-session-git-'));
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: rootPath, stdio: 'ignore' });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--allow-empty',
          '-m',
          'init',
        ],
        { cwd: rootPath, stdio: 'ignore' }
      );

      await expect(
        resolveLocalProjectBranchForCreate({ rootPath }, 'feature/missing')
      ).rejects.toThrow('Local project branch not found: feature/missing');
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('binds the workspace GitHub repository of a local project to its session', () => {
    expect(
      resolveLocalProjectCreateGitContext({
        gitState: createLocalProjectGitState(),
        workspaceRepositories: [{ fullName: 'loro-dev/lody' }],
        useWorktree: true,
      })
    ).toEqual({ branch: 'main', githubRepoFullName: 'loro-dev/lody' });
  });

  it('binds the GitHub repository of a direct local session without capturing its branch', () => {
    expect(
      resolveLocalProjectCreateGitContext({
        gitState: createLocalProjectGitState(),
        workspaceRepositories: [{ fullName: 'loro-dev/lody' }],
      })
    ).toEqual({ githubRepoFullName: 'loro-dev/lody' });
  });

  it('records the workspace spelling of an origin that differs only in case', () => {
    expect(
      resolveLocalProjectCreateGitContext({
        gitState: createLocalProjectGitState({ githubRepoFullName: 'Loro-Dev/Lody' }),
        workspaceRepositories: [{ fullName: 'loro-dev/lody' }],
        useWorktree: true,
      })
    ).toEqual({ branch: 'main', githubRepoFullName: 'loro-dev/lody' });
  });

  it('keeps a local session local when its origin is not a workspace repository', () => {
    expect(
      resolveLocalProjectCreateGitContext({
        gitState: createLocalProjectGitState(),
        workspaceRepositories: [{ fullName: 'loro-dev/other' }],
        useWorktree: true,
      })
    ).toEqual({ branch: 'main' });
    expect(
      resolveLocalProjectCreateGitContext({
        gitState: createLocalProjectGitState({ githubRepoFullName: null }),
        workspaceRepositories: [{ fullName: 'loro-dev/lody' }],
        useWorktree: true,
      })
    ).toEqual({ branch: 'main' });
  });

  it('resolves a requested branch selector alongside the repository identity', () => {
    const remoteSelector = createLocalProjectBranchSelector({
      kind: 'remote',
      remoteName: 'origin',
      branchName: 'feature/session',
    });
    expect(
      resolveLocalProjectCreateGitContext({
        gitState: createLocalProjectGitState({
          branches: ['main', remoteSelector],
          currentBranch: 'main',
        }),
        workspaceRepositories: [{ fullName: 'loro-dev/lody' }],
        requestedBranch: 'feature/session',
      })
    ).toEqual({ branch: remoteSelector, githubRepoFullName: 'loro-dev/lody' });
    expect(() =>
      resolveLocalProjectCreateGitContext({
        gitState: createLocalProjectGitState(),
        workspaceRepositories: [{ fullName: 'loro-dev/lody' }],
        requestedBranch: 'feature/missing',
      })
    ).toThrow('Local project branch not found: feature/missing');
  });

  it('keeps the non-git local project rules while resolving identity', () => {
    expect(
      resolveLocalProjectCreateGitContext({
        gitState: { git: false },
        workspaceRepositories: [{ fullName: 'loro-dev/lody' }],
      })
    ).toEqual({});
    expect(() =>
      resolveLocalProjectCreateGitContext({
        gitState: { git: false },
        workspaceRepositories: [],
        useWorktree: true,
      })
    ).toThrow(/--worktree/);
    expect(() =>
      resolveLocalProjectCreateGitContext({
        gitState: { git: false },
        workspaceRepositories: [],
        requestedBranch: 'main',
      })
    ).toThrow(/not a git repository/);
    expect(() =>
      resolveLocalProjectCreateGitContext({
        gitState: createLocalProjectGitState({ branches: [], currentBranch: null }),
        workspaceRepositories: [{ fullName: 'loro-dev/lody' }],
        useWorktree: true,
      })
    ).toThrow(/does not have a branch to use as a worktree base/);
  });

  it('downgrades session activity timestamp write failures to warnings', async () => {
    const warn = vi.fn();

    await expect(
      updateSessionActivityTimestampsBestEffort(
        {
          repo: {
            getDocMeta: vi.fn(async () => undefined),
            upsertDocMeta: vi.fn(async () => {
              throw new Error('write failed');
            }),
          },
        },
        'session-1',
        { warn }
      )
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update session activity timestamps for session-1')
    );
  });

  it('rolls CLI child session activity timestamps up to the parent session', async () => {
    const parentId = 'parent-session' as SessionId;
    const childId = 'child-session' as SessionId;
    const parentRoomId = getSessionRoomId(parentId);
    const childRoomId = getSessionRoomId(childId);
    const upsertDocMeta = vi.fn(async () => undefined);

    await updateSessionActivityTimestamps(
      {
        repo: {
          getDocMeta: vi.fn(async (roomId: string) => {
            if (roomId === childRoomId) {
              return { meta: { parentSessionId: parentId } };
            }
            if (roomId === parentRoomId) {
              return { meta: { lastMessageAt: 100, lastReadAt: 90 } };
            }
            return undefined;
          }),
          upsertDocMeta,
        },
      },
      childId
    );

    const childPatch = upsertDocMeta.mock.calls[0]?.[1] as Partial<SessionMeta> | undefined;
    const nowMs = childPatch?.lastMessageAt;
    expect(typeof nowMs).toBe('number');
    expect(upsertDocMeta).toHaveBeenCalledWith(childRoomId, {
      lastMessageAt: nowMs,
      lastReadAt: nowMs,
    });
    expect(upsertDocMeta).toHaveBeenCalledWith(parentRoomId, {
      lastMessageAt: nowMs,
      lastReadAt: nowMs,
    });
  });

  it('does not move CLI parent activity timestamps backwards', async () => {
    const parentId = 'parent-session' as SessionId;
    const childId = 'child-session' as SessionId;
    const parentRoomId = getSessionRoomId(parentId);
    const childRoomId = getSessionRoomId(childId);
    const upsertDocMeta = vi.fn(async () => undefined);

    await updateSessionActivityTimestamps(
      {
        repo: {
          getDocMeta: vi.fn(async (roomId: string) => {
            if (roomId === childRoomId) {
              return { meta: { parentSessionId: parentId } };
            }
            if (roomId === parentRoomId) {
              return {
                meta: {
                  lastMessageAt: Number.MAX_SAFE_INTEGER,
                  lastReadAt: Number.MAX_SAFE_INTEGER,
                },
              };
            }
            return undefined;
          }),
          upsertDocMeta,
        },
      },
      childId
    );

    expect(upsertDocMeta).toHaveBeenCalledWith(
      childRoomId,
      expect.objectContaining({
        lastMessageAt: expect.any(Number),
        lastReadAt: expect.any(Number),
      })
    );
    expect(upsertDocMeta).not.toHaveBeenCalledWith(parentRoomId, expect.anything());
  });

  it('builds transcript entries from visible user and assistant content only', () => {
    expect(
      toSessionTranscriptEntries([
        createHistoryEntry({
          id: 'system-entry',
          role: 'system',
          items: [{ type: 'text', text: 'ignore system turn' }],
        }),
        createHistoryEntry({
          id: 'user-entry',
          role: 'user',
          items: [
            {
              type: 'image',
              imageId: 'image-1',
              mimeType: 'image/png',
              fileName: 'diagram.png',
              sizeBytes: 1,
            },
            { type: 'text', text: 'Explain this output' },
          ],
        }),
        createHistoryEntry({
          id: 'assistant-entry',
          role: 'assistant',
          items: [
            { type: 'thought', text: 'internal reasoning' },
            { type: 'tool_call', toolCallId: 'tool-1', status: 'completed' },
            { type: 'text', text: 'Final answer' },
            { type: 'text', text: 'Second paragraph' },
            { type: 'tool_call', toolCallId: 'tool-2', status: 'completed' },
          ],
        }),
      ])
    ).toEqual([
      {
        index: 1,
        id: 'user-entry',
        role: 'user',
        timestamp: '2026-03-12T00:00:00.000Z',
        text: '[image: diagram.png]\n\nExplain this output',
      },
      {
        index: 2,
        id: 'assistant-entry',
        role: 'assistant',
        timestamp: '2026-03-12T00:00:00.000Z',
        text: 'Second paragraph',
      },
    ]);
  });

  it('selects the most recent transcript entries and supports reverse order', () => {
    const entries = [
      { index: 0, id: 'a', role: 'user', timestamp: 't0', text: 'a' },
      { index: 1, id: 'b', role: 'assistant', timestamp: 't1', text: 'b' },
      { index: 2, id: 'c', role: 'user', timestamp: 't2', text: 'c' },
      { index: 3, id: 'd', role: 'assistant', timestamp: 't3', text: 'd' },
    ] as const;

    expect(selectSessionTranscriptEntries([...entries], { limit: 2 })).toEqual([
      entries[2],
      entries[3],
    ]);
    expect(selectSessionTranscriptEntries([...entries], { limit: 2, reverse: true })).toEqual([
      entries[3],
      entries[2],
    ]);
    expect(selectSessionTranscriptEntries([...entries], { all: true, reverse: true })).toEqual([
      entries[3],
      entries[2],
      entries[1],
      entries[0],
    ]);
  });

  it('renders transcript entries as readable blocks', () => {
    expect(
      renderSessionTranscript([
        {
          index: 0,
          id: 'entry-1',
          role: 'user',
          timestamp: '2026-03-12T00:00:00.000Z',
          text: 'hello',
        },
        {
          index: 1,
          id: 'entry-2',
          role: 'assistant',
          timestamp: '2026-03-12T00:00:01.000Z',
          text: 'world',
        },
      ])
    ).toBe(
      '[user] 2026-03-12T00:00:00.000Z entry-1\nhello\n\n[assistant] 2026-03-12T00:00:01.000Z entry-2\nworld'
    );

    expect(renderSessionTranscript([])).toBe('No visible history found.');
  });

  it('renders the visible assistant completion for human --wait output', () => {
    expect(
      renderAssistantTurnCompletion([
        { type: 'thought', text: 'internal' },
        { type: 'text', text: 'First draft' },
        { type: 'tool_call', toolCallId: 'tool-1', status: 'completed' },
        { type: 'text', text: 'Final answer' },
      ])
    ).toBe('Final answer');
    expect(renderAssistantTurnCompletion([{ type: 'tool_call', toolCallId: 'tool-1' }])).toBe(
      'No visible assistant reply found.'
    );
  });

  it('waits only when --wait is explicit, independently of JSON output', () => {
    expect(shouldWaitForSessionCompletion({})).toBe(false);
    expect(shouldWaitForSessionCompletion({ json: true })).toBe(false);
    expect(shouldWaitForSessionCompletion({ jsonl: true })).toBe(false);
    expect(shouldWaitForSessionCompletion({ wait: true, json: true })).toBe(true);
  });
});
