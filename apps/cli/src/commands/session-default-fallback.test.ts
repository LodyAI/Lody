import { LoroDoc } from 'loro-crdt';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMachineRoomId,
  getWorkspaceFlockDocId,
  getSessionRoomId,
  snapshotAgentRole,
  type AcpCapabilityCacheEntry,
  type AgentConfigMeta,
  type AgentRole,
  type MachineId,
  type MachineMeta,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { SessionTurn } from '@lody/shared/session-data';
import { type LoroDocumentManager, SessionDocument } from '@/lib/loro/doc';
import { composeTestSessionDoc } from '../../tests/session-doc-fixture';
import { FlockSyncTimeoutError } from '@/lib/loro/timeout-utils';
import { applyAgentRoleCreateTarget, resolveAgentRoleCreate } from '@/lib/agent-role-create';
import {
  createLocalSessionCommandEnvironment,
  runWithSessionCommandEnvironment,
} from '@/lib/session-command-environment';
import { createSessionBackend } from '@/session/session-backend';
import { LodyOperationCoordinator } from '@/orchestration/operation-coordinator';
import { getLodyOperationStorePath, LodyOperationStore } from '@/orchestration/operation-store';
import { __lodyMcpServerInternals, runWithMcpSessionContext } from '@/mcp/lody-mcp-server';
import {
  createSessionResult,
  MachineFlockReadUnavailableError,
  sendSessionChatResult,
  validateSessionCreateOptions,
  type CreateOptions,
  type ResolvedTurnDispatchConfig,
} from './session';

const workspaceId = 'default-fallback-workspace' as WorkspaceId;
const machineId = 'default-fallback-machine' as MachineId;
const sessionId = 'default-fallback-session' as SessionId;
const userId = 'default-fallback-user';
const userTurnId = 'default-fallback-turn';
const roots = new Set<string>();
const mcpStores = new Set<LodyOperationStore>();

const createModelCapability = (): AcpCapabilityCacheEntry => ({
  cliType: 'builtin',
  agentType: 'codex',
  modes: [
    { id: 'agent-auto-review', name: 'Auto' },
    { id: 'plan', name: 'Plan' },
  ],
  models: [
    { modelId: 'model-a', name: 'Model A' },
    { modelId: 'model-b', name: 'Model B' },
  ],
  modelReasoningEfforts: { 'model-a': ['high'], 'model-b': ['xhigh'] },
  declaredModelControls: { 'model-a': { fastMode: false }, 'model-b': { fastMode: true } },
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
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [{ value: 'high', name: 'High' }],
    },
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
    { id: 'approved_option', name: 'Approved option', type: 'boolean', currentValue: false },
  ],
  fetchedAt: 1,
});

/** Real command resolution and Loro history, with only transport/storage replaced. */
function createFixture(agentType: 'codex' | 'claude', capability?: AcpCapabilityCacheEntry) {
  let freshnessConfirmed = false;
  let failDispatchPointer = false;
  let invocationInputConfig: SessionHistoryInput['inputConfig'];
  const machine: MachineMeta = {
    id: machineId,
    name: 'Synthetic machine',
    type: 'local',
    ownerUserId: userId,
    lastSeen: 0,
  };
  const agentConfig: AgentConfigMeta = {
    id: 'default-fallback-agent' as AgentConfigMeta['id'],
    machineId,
    name: 'Synthetic agent',
    cliType: 'builtin',
    agentType,
    env: {},
  };
  const metadata = new Map<string, object>([[getMachineRoomId(machineId), machine]]);
  const sessions = new Map<SessionId, SessionDocument>();
  const dispatched: SessionHistoryInput[] = [];
  const manager = {
    repo: {
      watch: () => ({ unsubscribe: () => undefined }),
      getMeta: () => ({
        scan: async ({ prefix }: { prefix: readonly string[] }) =>
          [...metadata.keys()].map((roomId) => ({
            key: [prefix[0], roomId],
            value: prefix[0] === 'e' ? true : metadata.get(roomId),
          })),
      }),
      getDocMeta: async (roomId: string) => {
        const meta = metadata.get(roomId);
        return meta ? { meta } : undefined;
      },
      upsertDocMeta: async (roomId: string, patch: object) => {
        if (failDispatchPointer && 'latestUserMsgId' in patch) {
          failDispatchPointer = false;
          throw new Error('Synthetic dispatch-pointer write failed');
        }
        metadata.set(roomId, { ...metadata.get(roomId), ...patch });
      },
      openFlockDoc: async () => ({
        flock: {
          // Provider discovery works even when its ACP capability row has not arrived.
          scan: ({ prefix }: { prefix?: readonly unknown[] } = {}) =>
            [
              { key: ['agentConfig', agentConfig.id], value: agentConfig },
              ...(capability
                ? [{ key: ['acpCapability', agentConfig.id], value: capability }]
                : []),
            ].filter((row) => !prefix || prefix.every((part, index) => row.key[index] === part)),
        },
      }),
      flush: async () => undefined,
    },
    getAgentConfigById: async () => agentConfig,
    syncMetaOrThrow: async () => undefined,
    syncDocOrThrow: async () => undefined,
    catalogBaselineReady: async () => true,
    syncFlockDocOrThrow: async (docId: string) => {
      if (docId === getWorkspaceFlockDocId(workspaceId)) return;
      if (!freshnessConfirmed) {
        throw new FlockSyncTimeoutError('Synthetic Machine Flock freshness deadline');
      }
    },
    waitUntilMetaSynced: async () => true,
    getOrCreateSessionDoc: async (id: SessionId) => {
      const existing = sessions.get(id);
      if (existing) return existing;
      const sessionDoc = new SessionDocument(manager.repo, id, async () => {});
      composeTestSessionDoc(sessionDoc, { doc: new LoroDoc() });
      sessionDoc.appendUserTurn = async (entry: SessionHistoryInput) => {
        await sessionDoc.sessionData.commands.appendTurn(entry as unknown as SessionTurn);
      };
      sessionDoc.waitUntilSynced = async () => true;
      sessions.set(id, sessionDoc);
      return sessionDoc;
    },
  } as unknown as LoroDocumentManager;
  const environment = createLocalSessionCommandEnvironment({
    manager,
    workspaceId,
    machineId,
    machineName: machine.name,
    userId,
    host: {
      readInvocation: (id) => ({
        type: 'session/active-invocation-context',
        sessionId: id,
        active: true,
        requesterUserId: userId,
        sourceTurnId: 'earlier-turn',
        inputConfig: invocationInputConfig ?? {},
      }),
      readLiveStatus: async () => {
        throw new Error('Unexpected live-status lookup');
      },
      cancelSession: async () => {
        throw new Error('Unexpected cancellation');
      },
      dispatchSession: async (id) => {
        const doc = await manager.getOrCreateSessionDoc(id);
        const meta = await doc.getMetaState();
        const backend = await createSessionBackend(doc, meta);
        const turn = (await backend.readHistory()).find(
          (entry) => entry.id === meta?.latestUserMsgId
        );
        if (!turn) throw new Error('Dispatch must observe a persisted turn and pointer');
        dispatched.push(turn);
      },
    },
  });
  const history = async (id = sessionId) => {
    const doc = await manager.getOrCreateSessionDoc(id);
    return (await createSessionBackend(doc, await doc.getMetaState())).readHistory();
  };
  const seedChat = async (inputConfig?: SessionHistoryInput['inputConfig'], id = sessionId) => {
    invocationInputConfig = inputConfig;
    metadata.set(getSessionRoomId(id), {
      id,
      machineId,
      userId,
      createdAt: '2026-10-10T00:00:00.000Z',
      cliType: 'builtin',
      agentType,
      agentConfigId: agentConfig.id,
      historyBackend: 'loro',
    } satisfies SessionMeta);
    if (inputConfig) {
      const doc = await manager.getOrCreateSessionDoc(id);
      const backend = await createSessionBackend(doc, await doc.getMetaState());
      await backend.appendHistoryTurn({
        id: 'earlier-turn',
        role: 'user',
        timestamp: '2026-10-10T00:00:00.000Z',
        items: [{ type: 'text', text: 'Earlier prompt' }],
        inputConfig,
        fileDiff: [],
        finished: true,
      });
    }
  };
  const run = (
    command: 'create' | 'chat',
    dispatchConfig: ResolvedTurnDispatchConfig,
    turnId = userTurnId
  ) =>
    runWithSessionCommandEnvironment(environment, () =>
      command === 'create'
        ? createSessionResult(
            environment.auth,
            environment.workspace,
            manager,
            'Continue',
            {
              agentConfig: agentConfig.id,
              sessionId,
              userTurnId: turnId,
              bypassSessionQuota: true,
              historyBackend: 'loro',
            },
            dispatchConfig
          )
        : sendSessionChatResult(
            environment.auth,
            environment.workspace,
            manager,
            sessionId,
            'Continue',
            dispatchConfig,
            undefined,
            undefined,
            { userTurnId: turnId, chainDepth: 0, bypassSessionQuota: true }
          )
    );
  const validateCreate = (dispatchConfig: ResolvedTurnDispatchConfig = {}) =>
    runWithSessionCommandEnvironment(environment, () =>
      validateSessionCreateOptions({
        auth: environment.auth,
        workspace: environment.workspace,
        manager,
        options: { agentConfig: agentConfig.id },
        dispatchConfig,
      })
    );
  return {
    manager,
    environment,
    agentConfig,
    metadata,
    dispatched,
    history,
    seedChat,
    run,
    validateCreate,
    runMcp: async <T>(requesterSessionId: SessionId, invoke: () => Promise<T>): Promise<T> => {
      // The MCP server owns a process-long SQLite connection. Capture that real
      // store only for cleanup so Windows can remove the temporary database too.
      const findMatchingRetry = LodyOperationStore.prototype.findMatchingRetry;
      const captureStore = vi
        .spyOn(LodyOperationStore.prototype, 'findMatchingRetry')
        .mockImplementation(function (this: LodyOperationStore, ...args) {
          mcpStores.add(this);
          return findMatchingRetry.apply(this, args);
        });
      try {
        return await runWithSessionCommandEnvironment(environment, () =>
          runWithMcpSessionContext(
            {
              machineId,
              workspaceId,
              sessionId: requesterSessionId,
              localControlSocketPath: undefined,
              workdir: process.cwd(),
            },
            invoke
          )
        );
      } finally {
        captureStore.mockRestore();
      }
    },
    failNextDispatchPointer: () => {
      failDispatchPointer = true;
    },
    setCapability: (next: AcpCapabilityCacheEntry | undefined, confirmed: boolean) => {
      capability = next;
      freshnessConfirmed = confirmed;
    },
    completeTurn: async (id = sessionId, turnId = userTurnId) => {
      const doc = await manager.getOrCreateSessionDoc(id);
      const backend = await createSessionBackend(doc, await doc.getMetaState());
      await backend.appendHistoryTurn({
        id: `assistant:${turnId}`,
        role: 'assistant',
        userTurnId: turnId,
        timestamp: '2026-10-10T00:00:01.000Z',
        items: [{ type: 'text', text: 'Synthetic completed work' }],
        fileDiff: [],
        finished: true,
      });
    },
  };
}

beforeEach(() => {
  vi.stubEnv('LODY_SESSION_ID', '');
  vi.stubEnv('LODY_AGENT_CONFIG_ID', '');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const store of mcpStores) store.close();
  mcpStores.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe.each(['create', 'chat'] as const)('%s with failed Machine Flock freshness', (command) => {
  it.each([
    ['codex', 'agent-auto-review'],
    ['claude', 'auto'],
  ] as const)(
    'persists and dispatches the builtin %s default without ACP cache',
    async (agentType, modeId) => {
      const fixture = createFixture(agentType);
      if (command === 'chat') await fixture.seedChat();

      await expect(fixture.run(command, {})).resolves.toMatchObject({ sessionId, userTurnId });

      expect(await fixture.history()).toMatchObject([
        {
          id: userTurnId,
          role: 'user',
          items: [{ type: 'text', text: 'Continue' }],
          inputConfig: { cliType: 'builtin', agentType, modeId },
        },
      ]);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
        latestUserMsgId: userTurnId,
      });
      expect(fixture.dispatched).toEqual(await fixture.history());
      const doc = await fixture.manager.getOrCreateSessionDoc(sessionId);
      expect((await doc.getDocState())?.humanInputReceipts?.[userTurnId]).toMatchObject({ userId });
    }
  );

  it.each([
    ['mode', { modeId: 'plan' }],
    ['builtin default mode', { modeId: 'agent-auto-review' }],
    ['model', { modelId: 'selected-model' }],
    ['config option', { configOptionValues: { approval_policy: 'never' } }],
  ] satisfies Array<[string, ResolvedTurnDispatchConfig]>)(
    'rejects an explicit %s without ACP cache before history or dispatch changes',
    async (_selection, dispatchConfig) => {
      const fixture = createFixture('codex');
      if (command === 'chat') await fixture.seedChat();
      const previousMetadata = fixture.metadata.get(getSessionRoomId(sessionId));

      await expect(fixture.run(command, dispatchConfig)).rejects.toBeInstanceOf(
        MachineFlockReadUnavailableError
      );

      expect(await fixture.history()).toEqual([]);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toEqual(previousMetadata);
      expect(fixture.dispatched).toEqual([]);
    }
  );

  it.each([
    ['nondefault mode', { modeId: 'plan' }],
    ['model', { modelId: 'inherited-model' }],
    ['option', { configOptionValues: { unknown_option: true } }],
  ] as const)(
    'drops an inherited %s without ACP cache and dispatches the fallback',
    async (_selection, inheritedSelection) => {
      const fixture = createFixture('codex');
      const inherited = {
        prompt: 'Earlier prompt',
        cliType: 'builtin' as const,
        agentType: 'codex',
        ...inheritedSelection,
      };
      if (command === 'chat') await fixture.seedChat(inherited);
      const previousHistory = await fixture.history();
      await fixture.run(
        command,
        command === 'create' ? { frozenInheritedInputConfig: inherited } : {}
      );

      const history = await fixture.history();
      expect(history.slice(0, -1)).toEqual(previousHistory);
      const latest = history.at(-1);
      expect(latest).toMatchObject({
        id: userTurnId,
        inputConfig: { cliType: 'builtin', agentType: 'codex', modeId: 'agent-auto-review' },
      });
      expect(latest?.inputConfig?.modelId).toBeUndefined();
      expect(latest?.inputConfig?.configOptionValues).toBeUndefined();
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
        latestUserMsgId: userTurnId,
      });
      expect(fixture.dispatched).toEqual([latest]);
    }
  );

  it.each(['mode', 'model'] as const)(
    'dispatches an explicit cached %s instead of an unavailable inherited selector option',
    async (category) => {
      const selectedId = `current-${category}`;
      const capability: AcpCapabilityCacheEntry = {
        cliType: 'builtin',
        agentType: 'codex',
        modes: [{ id: 'current-mode', name: 'Current mode' }],
        models: [{ modelId: 'current-model', name: 'Current model' }],
        configOptions: [
          {
            id: category,
            name: category,
            category,
            type: 'select',
            currentValue: selectedId,
            options: [{ value: selectedId, name: selectedId }],
          },
        ],
        fetchedAt: 1,
      };
      const fixture = createFixture('codex', capability);
      const inherited = {
        prompt: 'Earlier prompt',
        cliType: 'builtin' as const,
        agentType: 'codex',
        configOptionValues: { [category]: `unavailable-${category}` },
      };
      if (command === 'chat') await fixture.seedChat(inherited);
      const selection = category === 'mode' ? { modeId: selectedId } : { modelId: selectedId };

      await fixture.run(command, {
        ...selection,
        ...(command === 'create' ? { frozenInheritedInputConfig: inherited } : {}),
      });

      const latest = (await fixture.history()).at(-1);
      expect(latest).toMatchObject({ id: userTurnId, inputConfig: selection });
      expect(latest?.inputConfig?.configOptionValues?.[category]).toBeUndefined();
      expect(fixture.dispatched).toEqual([latest]);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
        latestUserMsgId: userTurnId,
      });
    }
  );
});

describe.each(['create', 'chat'] as const)(
  '%s model-dependent option types with failed Machine Flock freshness',
  (command) => {
    const malformedOptions: Array<{
      name: string;
      optionId: string;
      configOptionValues: Record<string, string | boolean>;
      advertiseBooleanFast: boolean;
    }> = [
      {
        name: 'boolean reasoning effort with unknown target-model choices',
        optionId: 'reasoning_effort',
        configOptionValues: { reasoning_effort: true },
        advertiseBooleanFast: false,
      },
      {
        name: 'malformed Fast string without a probe option',
        optionId: 'fast',
        configOptionValues: { fast: 'malformed' },
        advertiseBooleanFast: false,
      },
      {
        name: 'string on for an advertised boolean Fast option',
        optionId: 'fast',
        configOptionValues: { fast: 'on' },
        advertiseBooleanFast: true,
      },
    ];
    it.each(malformedOptions)(
      'rejects $name as a permanent input error before history or dispatch changes',
      async ({ optionId, configOptionValues, advertiseBooleanFast }) => {
        const capability = createModelCapability();
        capability.modelReasoningEfforts = { 'model-a': ['high'] };
        if (advertiseBooleanFast) {
          capability.configOptions = [
            ...(capability.configOptions ?? []),
            { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
          ];
        }
        const fixture = createFixture('codex', capability);
        if (command === 'chat') await fixture.seedChat();
        const previousMetadata = fixture.metadata.get(getSessionRoomId(sessionId));
        const failure = await fixture.run(command, { modelId: 'model-b', configOptionValues }).then(
          () => undefined,
          (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(MachineFlockReadUnavailableError);
        expect(failure).toMatchObject({ message: expect.stringContaining(optionId) });
        expect(await fixture.history()).toEqual([]);
        expect(fixture.metadata.get(getSessionRoomId(sessionId))).toEqual(previousMetadata);
        expect(fixture.dispatched).toEqual([]);
      }
    );

    it.each([true, 'on', 'custom-fast'] as const)(
      'preserves the valid raw Fast representation %s',
      async (value) => {
        const capability = createModelCapability();
        if (value === 'custom-fast') {
          capability.configOptions = [
            ...(capability.configOptions ?? []),
            {
              id: 'fast',
              name: 'Fast',
              type: 'select',
              currentValue: 'custom-fast',
              options: [{ value: 'custom-fast', name: 'Custom Fast' }],
            },
          ];
        }
        const fixture = createFixture('codex', capability);
        if (command === 'chat') await fixture.seedChat();
        await fixture.run(command, { modelId: 'model-b', configOptionValues: { fast: value } });
        const history = await fixture.history();
        expect(history).toHaveLength(1);
        expect(history[0]?.inputConfig?.configOptionValues).toEqual({ fast: value });
        expect(fixture.dispatched).toEqual(history);
      }
    );

    it('dispatches string effort when only the non-probe model effort choices are unknown', async () => {
      const capability = createModelCapability();
      capability.modelReasoningEfforts = { 'model-a': ['high'] };
      const fixture = createFixture('codex', capability);
      if (command === 'chat') await fixture.seedChat();

      await fixture.run(command, {
        modelId: 'model-b',
        configOptionValues: { reasoning_effort: 'xhigh' },
      });

      const history = await fixture.history();
      expect(history).toMatchObject([
        {
          id: userTurnId,
          inputConfig: { modelId: 'model-b', configOptionValues: { reasoning_effort: 'xhigh' } },
        },
      ]);
      expect(history).toHaveLength(1);
      expect(fixture.dispatched).toEqual(history);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
        latestUserMsgId: userTurnId,
      });
    });
  }
);

describe.each(['create', 'chat'] as const)('%s inherited catalog fallback', (command) => {
  it.each([
    {
      name: 'complete cache with a different probe model',
      capability: createModelCapability(),
      inherited: {
        modelId: 'model-b',
        configOptionValues: {
          reasoning_effort: 'xhigh',
          fast: true,
          approval_policy: 'on-request',
        },
      },
      expected: {
        modeId: 'agent-auto-review',
        modelId: 'model-b',
        configOptionValues: {
          reasoning_effort: 'xhigh',
          fast: true,
          approval_policy: 'on-request',
        },
      },
    },
    {
      name: 'missing inherited model',
      capability: createModelCapability(),
      inherited: { modelId: 'retired-model', configOptionValues: { approved_option: true } },
      expected: {
        modeId: 'agent-auto-review',
        modelId: undefined,
        configOptionValues: { approved_option: true },
      },
    },
    {
      name: 'no capability cache',
      capability: undefined,
      inherited: {
        modeId: 'retired-mode',
        modelId: 'retired-model',
        configOptionValues: { approved_option: true },
      },
      expected: { modeId: 'agent-auto-review', modelId: undefined, configOptionValues: undefined },
    },
    {
      name: 'unsupported nonbuiltin inherited mode',
      capability: createModelCapability(),
      inherited: {
        modeId: 'retired-mode',
        modelId: 'model-a',
        configOptionValues: { approval_policy: 'on-request' },
      },
      expected: {
        modeId: 'agent-auto-review',
        modelId: 'model-a',
        configOptionValues: { approval_policy: 'on-request' },
      },
    },
    {
      name: 'compatible inherited cache',
      capability: createModelCapability(),
      inherited: {
        modeId: 'plan',
        modelId: 'model-a',
        configOptionValues: { reasoning_effort: 'high', approval_policy: 'on-request' },
      },
      expected: {
        modeId: 'plan',
        modelId: 'model-a',
        configOptionValues: { reasoning_effort: 'high', approval_policy: 'on-request' },
      },
    },
  ] satisfies Array<{
    name: string;
    capability: AcpCapabilityCacheEntry | undefined;
    inherited: ResolvedTurnDispatchConfig;
    expected: ResolvedTurnDispatchConfig;
  }>)(
    'persists and dispatches $name through failed freshness',
    async ({
      capability,
      inherited,
      expected,
    }: {
      capability: AcpCapabilityCacheEntry | undefined;
      inherited: ResolvedTurnDispatchConfig;
      expected: ResolvedTurnDispatchConfig;
    }) => {
      const fixture = createFixture('codex', capability);
      const inputConfig = {
        prompt: 'Earlier prompt',
        cliType: 'builtin' as const,
        agentType: 'codex',
        ...inherited,
      };
      if (command === 'chat') await fixture.seedChat(inputConfig);
      const previousHistory = await fixture.history();
      const dispatchConfig =
        command === 'create'
          ? await fixture.validateCreate({ frozenInheritedInputConfig: inputConfig })
          : {};
      if (command === 'create') {
        expect(dispatchConfig.modeId).toEqual(expected.modeId);
        expect(dispatchConfig.modelId).toEqual(expected.modelId);
        expect(dispatchConfig.configOptionValues).toEqual(expected.configOptionValues);
        expect(await fixture.history()).toEqual(previousHistory);
        expect(fixture.metadata.get(getSessionRoomId(sessionId))).toBeUndefined();
      }

      await fixture.run(
        command,
        JSON.parse(JSON.stringify(dispatchConfig)) as ResolvedTurnDispatchConfig
      );

      const history = await fixture.history();
      const latest = history.at(-1);
      expect(history.slice(0, -1)).toEqual(previousHistory);
      expect(latest).toMatchObject({
        id: userTurnId,
        inputConfig: { cliType: 'builtin', agentType: 'codex' },
      });
      expect(latest?.inputConfig?.modeId).toEqual(expected.modeId);
      expect(latest?.inputConfig?.modelId).toEqual(expected.modelId);
      expect(latest?.inputConfig?.configOptionValues).toEqual(expected.configOptionValues);
      expect(latest?.inputConfig).not.toHaveProperty('inheritedDispatchConfig');
      expect(fixture.dispatched).toEqual([latest]);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
        latestUserMsgId: userTurnId,
      });
    }
  );
});

describe('create inherited configuration replay', () => {
  it('validates current explicit options against the inherited model before and after JSON replay', async () => {
    const fixture = createFixture('codex', createModelCapability());
    const validated = await fixture.validateCreate({
      frozenInheritedInputConfig: { cliType: 'builtin', agentType: 'codex', modelId: 'model-b' },
      configOptionValues: { reasoning_effort: 'xhigh', fast: true, approval_policy: 'never' },
    });
    await fixture.run(
      'create',
      JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig
    );
    expect(await fixture.history()).toMatchObject([
      {
        inputConfig: {
          modelId: 'model-b',
          configOptionValues: { reasoning_effort: 'xhigh', fast: true, approval_policy: 'never' },
        },
      },
    ]);
    expect(fixture.dispatched).toEqual(await fixture.history());
  });

  it('resolves current semantic effort against an inherited model through frozen replay', async () => {
    const fixture = createFixture('codex', createModelCapability());
    const validated = await fixture.validateCreate({
      frozenInheritedInputConfig: { cliType: 'builtin', agentType: 'codex', modelId: 'model-b' },
      runConfig: { reasoningEffort: 'xhigh' },
    });
    expect(validated).toMatchObject({
      modelId: 'model-b',
      inheritedDispatchConfig: { modelId: 'model-b' },
      configOptionValues: { reasoning_effort: 'xhigh' },
    });
    expect(validated.inheritedDispatchConfig?.configOptionValues).toBeUndefined();

    await fixture.run(
      'create',
      JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig
    );

    expect(await fixture.history()).toMatchObject([
      { inputConfig: { modelId: 'model-b', configOptionValues: { reasoning_effort: 'xhigh' } } },
    ]);
    expect(fixture.dispatched).toEqual(await fixture.history());
  });

  it.each(['high', 'xhigh'] as const)(
    'validates semantic %s against the probe after replacing a raw-only inherited model map',
    async (reasoningEffort) => {
      const capability = createModelCapability();
      capability.configOptions = capability.configOptions?.map((option) =>
        option.category === 'model' ? { ...option, id: 'model_picker' } : option
      );
      const fixture = createFixture('codex', capability);
      const config: ResolvedTurnDispatchConfig = {
        frozenInheritedInputConfig: {
          cliType: 'builtin',
          agentType: 'codex',
          configOptionValues: { model_picker: 'model-b' },
        },
        runConfig: { reasoningEffort },
      };
      if (reasoningEffort === 'xhigh') {
        await expect(fixture.validateCreate(config)).rejects.toBeInstanceOf(
          MachineFlockReadUnavailableError
        );
        expect(await fixture.history()).toEqual([]);
        expect(fixture.dispatched).toEqual([]);
        return;
      }
      const validated = await fixture.validateCreate(config);
      expect(validated.modelId).toBeUndefined();
      expect(validated.configOptionValues).toEqual({ reasoning_effort: 'high' });

      await fixture.run(
        'create',
        JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig
      );

      const history = await fixture.history();
      expect(history[0]?.inputConfig?.modelId).toBeUndefined();
      expect(history[0]?.inputConfig?.configOptionValues).toEqual({ reasoning_effort: 'high' });
      expect(fixture.dispatched).toEqual(history);
    }
  );

  it('retains an explicit raw model alias with semantic effort through actual create replay', async () => {
    const capability = createModelCapability();
    capability.configOptions = capability.configOptions?.map((option) =>
      option.category === 'model' ? { ...option, id: 'model_picker' } : option
    );
    const fixture = createFixture('codex', capability);
    const validated = await fixture.validateCreate({
      configOptionValues: { model_picker: 'model-b' },
      runConfig: { reasoningEffort: 'xhigh' },
    });

    await fixture.run(
      'create',
      JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig
    );

    const history = await fixture.history();
    const input = history[0]?.inputConfig;
    expect(input?.modelId ?? input?.configOptionValues?.model_picker).toBe('model-b');
    expect(input?.configOptionValues?.reasoning_effort).toBe('xhigh');
    expect(fixture.dispatched).toEqual(history);
  });

  it('drops inherited model-dependent controls after an explicit model switch and preserves permissions', async () => {
    const fixture = createFixture('codex', createModelCapability());
    const validated = await fixture.validateCreate({
      frozenInheritedInputConfig: {
        cliType: 'builtin',
        agentType: 'codex',
        modelId: 'model-b',
        configOptionValues: {
          reasoning_effort: 'xhigh',
          fast: true,
          approval_policy: 'on-request',
        },
      },
      modelId: 'model-a',
    });
    expect(validated.modelId).toBe('model-a');
    expect(validated.configOptionValues).toEqual({ approval_policy: 'on-request' });
    expect(validated.inheritedDispatchConfig?.modelId).toBeUndefined();

    await fixture.run(
      'create',
      JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig
    );

    expect(await fixture.history()).toMatchObject([
      {
        inputConfig: { modelId: 'model-a', configOptionValues: { approval_policy: 'on-request' } },
      },
    ]);
    expect(fixture.dispatched).toEqual(await fixture.history());
  });

  it.each([
    ['mode', { modeId: 'selected-missing-mode' }],
    ['model', { modelId: 'selected-missing-model' }],
    ['options', { configOptionValues: { selected_missing_option: true } }],
  ] satisfies Array<[string, ResolvedTurnDispatchConfig]>)(
    'does not treat a new explicit %s override as frozen inheritance',
    async (_selection, override) => {
      const fixture = createFixture('codex', createModelCapability());
      const validated = await fixture.validateCreate({
        frozenInheritedInputConfig: {
          cliType: 'builtin',
          agentType: 'codex',
          modeId: 'plan',
          modelId: 'model-b',
          configOptionValues: { reasoning_effort: 'xhigh' },
        },
      });
      const replayed = JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig;

      await expect(fixture.run('create', { ...replayed, ...override })).rejects.toBeInstanceOf(
        MachineFlockReadUnavailableError
      );

      expect(await fixture.history()).toEqual([]);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toBeUndefined();
      expect(fixture.dispatched).toEqual([]);
    }
  );

  it.each([true, false])(
    'filters accepted inherited selections after catalog changes (confirmed=%s)',
    async (confirmed) => {
      const capability = createModelCapability();
      const fixture = createFixture('codex', capability);
      const validated = await fixture.validateCreate({
        frozenInheritedInputConfig: {
          cliType: 'builtin',
          agentType: 'codex',
          modeId: 'plan',
          modelId: 'model-b',
          configOptionValues: { approved_option: true },
        },
      });
      expect(validated).toMatchObject({
        modeId: 'plan',
        modelId: 'model-b',
        configOptionValues: { approved_option: true },
      });
      fixture.setCapability({ ...capability, modes: [], models: [], configOptions: [] }, confirmed);

      await fixture.run(
        'create',
        JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig
      );

      const history = await fixture.history();
      expect(history).toHaveLength(1);
      expect(history[0]?.inputConfig?.modeId).toBeUndefined();
      expect(history[0]?.inputConfig?.modelId).toBeUndefined();
      expect(history[0]?.inputConfig?.configOptionValues).toBeUndefined();
      expect(fixture.dispatched).toEqual(history);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
        latestUserMsgId: userTurnId,
      });
    }
  );
});

describe('interrupted inherited create replay', () => {
  const prepareMixedOriginInterruptedCreate = async () => {
    const capability = createModelCapability();
    const fixture = createFixture('codex', capability);
    const validated = await fixture.validateCreate({
      frozenInheritedInputConfig: { cliType: 'builtin', agentType: 'codex', modelId: 'model-b' },
      configOptionValues: { reasoning_effort: 'xhigh' },
    });
    expect(validated).toMatchObject({
      modelId: 'model-b',
      inheritedDispatchConfig: { modelId: 'model-b' },
      configOptionValues: { reasoning_effort: 'xhigh' },
    });
    expect(validated.inheritedDispatchConfig?.configOptionValues).toBeUndefined();
    const replayed = JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig;
    fixture.failNextDispatchPointer();
    await expect(fixture.run('create', replayed)).rejects.toThrow(
      'Synthetic dispatch-pointer write failed'
    );
    const authoredHistory = await fixture.history();
    expect(authoredHistory).toMatchObject([
      {
        id: userTurnId,
        inputConfig: { modelId: 'model-b', configOptionValues: { reasoning_effort: 'xhigh' } },
      },
    ]);
    expect(authoredHistory).toHaveLength(1);
    expect(fixture.dispatched).toEqual([]);
    const authoredMetadata = fixture.metadata.get(getSessionRoomId(sessionId));
    expect(authoredMetadata).not.toHaveProperty('latestUserMsgId');
    fixture.setCapability(
      {
        ...capability,
        models: [{ modelId: 'model-a', name: 'Model A' }],
        configOptions: capability.configOptions?.map((option) =>
          option.category === 'model' && option.type === 'select'
            ? { ...option, options: [{ value: 'model-a', name: 'Model A' }] }
            : option
        ),
      },
      false
    );
    return { fixture, replayed, authoredHistory, authoredMetadata };
  };

  it('recovers an authored inherited model with current explicit effort after selector removal', async () => {
    const { fixture, replayed, authoredHistory } = await prepareMixedOriginInterruptedCreate();

    await fixture.run('create', replayed);

    expect(await fixture.history()).toEqual(authoredHistory);
    expect(fixture.dispatched).toEqual(authoredHistory);
    expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
      latestUserMsgId: userTurnId,
    });
  });

  const changedExplicitOptions: Array<{
    name: string;
    configOptionValues: Record<string, string | boolean>;
    error: string | typeof MachineFlockReadUnavailableError;
  }> = [
    {
      name: 'invalid explicit effort',
      configOptionValues: { reasoning_effort: 'unsupported-effort' },
      error: MachineFlockReadUnavailableError,
    },
    {
      name: 'changed explicit option',
      configOptionValues: { reasoning_effort: 'xhigh', approval_policy: 'never' },
      error: 'Prepared Session Turn identity conflict',
    },
  ];
  it.each(changedExplicitOptions)(
    'rejects $name during mixed-origin replay without rewriting or dispatch',
    async ({ configOptionValues, error }) => {
      const { fixture, replayed, authoredHistory, authoredMetadata } =
        await prepareMixedOriginInterruptedCreate();

      await expect(fixture.run('create', { ...replayed, configOptionValues })).rejects.toThrow(
        error
      );

      expect(await fixture.history()).toEqual(authoredHistory);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toEqual(authoredMetadata);
      expect(fixture.dispatched).toEqual([]);
    }
  );

  it.each(['retained', 'filtered'] as const)(
    'keeps already-authored %s inherited selections after the cache changes',
    async (authored) => {
      const capability = createModelCapability();
      const fixture = createFixture('codex', capability);
      const validated = await fixture.validateCreate({
        frozenInheritedInputConfig: {
          cliType: 'builtin',
          agentType: 'codex',
          modeId: 'plan',
          modelId: 'model-b',
          configOptionValues: {
            reasoning_effort: 'xhigh',
            fast: true,
            approval_policy: 'on-request',
          },
        },
      });
      const replayed = JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig;
      if (authored === 'filtered')
        fixture.setCapability({ ...capability, modes: [], models: [], configOptions: [] }, false);
      fixture.failNextDispatchPointer();
      await expect(fixture.run('create', replayed)).rejects.toThrow(
        'Synthetic dispatch-pointer write failed'
      );
      const authoredHistory = await fixture.history();
      expect(authoredHistory).toHaveLength(1);
      expect(authoredHistory[0]?.inputConfig?.modeId).toBe(
        authored === 'retained' ? 'plan' : undefined
      );
      expect(authoredHistory[0]?.inputConfig?.modelId).toBe(
        authored === 'retained' ? 'model-b' : undefined
      );
      expect(authoredHistory[0]?.inputConfig?.configOptionValues).toEqual(
        authored === 'retained'
          ? { reasoning_effort: 'xhigh', fast: true, approval_policy: 'on-request' }
          : undefined
      );
      expect(fixture.dispatched).toEqual([]);
      fixture.setCapability(
        authored === 'retained'
          ? { ...capability, modes: [], models: [], configOptions: [] }
          : capability,
        false
      );

      await fixture.run('create', replayed);

      expect(await fixture.history()).toEqual(authoredHistory);
      expect(fixture.dispatched).toEqual(authoredHistory);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
        latestUserMsgId: userTurnId,
      });
    }
  );
});

describe('Role create with failed Machine Flock freshness', () => {
  it('authors and dispatches the Role target and run config after clearing invalid manual overrides', async () => {
    const fixture = createFixture('codex', createModelCapability());
    const role: AgentRole = {
      v: 1,
      id: 'default-fallback-role' as AgentRole['id'],
      ownerUserId: userId,
      visibility: 'private',
      name: 'Synthetic reviewer',
      machineId,
      agentConfigId: fixture.agentConfig.id,
      runConfig: {
        modeId: 'plan',
        modelId: 'model-b',
        configOptionValues: { reasoning_effort: 'xhigh', approval_policy: 'never' },
      },
      promptPrefix: 'Review carefully.',
      revision: 7,
      createdAt: 1,
      updatedAt: 1,
    };
    const options: CreateOptions = {
      machine: 'invalid-manual-machine',
      agent: 'invalid-manual-agent',
      agentConfig: 'invalid-manual-config',
      mode: 'invalid-manual-mode',
      model: 'invalid-manual-model',
      configOption: ['invalid_manual_option=invalid-value'],
      sessionId,
      userTurnId,
      bypassSessionQuota: true,
      historyBackend: 'loro',
    };
    const resolved = resolveAgentRoleCreate({ role, prompt: 'Continue', overrides: options });
    applyAgentRoleCreateTarget(options, resolved);

    await runWithSessionCommandEnvironment(fixture.environment, () =>
      createSessionResult(
        fixture.environment.auth,
        fixture.environment.workspace,
        fixture.manager,
        resolved.prompt,
        options,
        resolved.dispatchConfig
      )
    );

    const history = await fixture.history();
    expect(history).toMatchObject([
      {
        id: userTurnId,
        // The visible turn keeps only the authored prompt; the Role
        // instruction is injected into the execution prompt.
        items: [{ type: 'text', text: 'Continue' }],
        inputConfig: {
          prompt: 'Review carefully.\n\nContinue',
          ...role.runConfig,
          agentRoleId: role.id,
          agentRoleRevision: role.revision,
          agentRoleSnapshot: snapshotAgentRole(role),
        },
      },
    ]);
    expect(history).toHaveLength(1);
    expect(fixture.dispatched).toEqual(history);
    expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
      machineId: role.machineId,
      agentConfigId: role.agentConfigId,
      agentRoleId: role.id,
      agentRoleRevision: role.revision,
      latestUserMsgId: userTurnId,
    });
  });
});

describe('agent-originated MCP inherited fallback', () => {
  it.each(['stale selectors', 'model-b effort'] as const)(
    'accepts and materializes a no-Role mixed create batch with inherited %s',
    async (selection) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'lody-inherited-batch-'));
      roots.add(root);
      vi.stubEnv('LODY_DATA_DIR', root);
      const fixture = createFixture('codex', createModelCapability());
      const requesterSessionId = 'inherited-batch-requester' as SessionId;
      await fixture.seedChat(
        {
          prompt: 'Earlier prompt',
          cliType: 'builtin',
          agentType: 'codex',
          modeId: selection === 'stale selectors' ? 'retired-mode' : 'plan',
          modelId: selection === 'stale selectors' ? 'retired-model' : 'model-b',
          configOptionValues:
            selection === 'stale selectors'
              ? { removed_option: true }
              : { reasoning_effort: 'xhigh', fast: true, approval_policy: 'on-request' },
        },
        requesterSessionId
      );
      const operationId = 'inherited-mixed-create';

      await fixture.runMcp(requesterSessionId, () =>
        __lodyMcpServerInternals.startSessionCreateManyOperation({
          operationId,
          items: [
            { label: 'inherit', prompt: 'Use compatible defaults' },
            {
              label: 'explicit',
              prompt: 'Use selected model',
              modeId: 'agent-auto-review',
              modelId: 'model-b',
              configOptionValues: { reasoning_effort: 'xhigh', approval_policy: 'on-request' },
            },
            {
              label: 'invalid',
              prompt: 'Reject malformed option',
              configOptionValues: { approved_option: 'not-a-boolean' },
            },
          ],
        })
      );

      const store = new LodyOperationStore(getLodyOperationStorePath(machineId));
      try {
        const operation = store.get(requesterSessionId, operationId);
        expect(operation).toMatchObject({
          kind: 'session_create_many',
          state: 'active',
          items: [
            { label: 'inherit', status: 'active', inputDurable: true },
            { label: 'explicit', status: 'active', inputDurable: true },
            {
              label: 'invalid',
              status: 'failed',
              error: { code: 'INVALID_ITEM', retryable: false },
            },
          ],
        });
        for (const item of operation.items) {
          if (item.status !== 'active') continue;
          const history = await fixture.history(item.target.sessionId);
          expect(history).toHaveLength(1);
          expect(history[0]).toMatchObject({
            id: item.target.userTurnId,
            author: { kind: 'agent', sessionId: requesterSessionId, turnId: 'earlier-turn' },
            inputConfig: {
              cliType: 'builtin',
              agentType: 'codex',
              modeId:
                item.label === 'inherit' && selection === 'model-b effort'
                  ? 'plan'
                  : 'agent-auto-review',
            },
          });
          expect(history[0]?.inputConfig?.modelId).toBe(
            item.label === 'explicit' || selection === 'model-b effort' ? 'model-b' : undefined
          );
          expect(history[0]?.inputConfig?.configOptionValues).toEqual(
            item.label === 'explicit'
              ? { reasoning_effort: 'xhigh', approval_policy: 'on-request' }
              : selection === 'model-b effort'
                ? { reasoning_effort: 'xhigh', fast: true, approval_policy: 'on-request' }
                : undefined
          );
          expect(fixture.dispatched).toContainEqual(history[0]);
          expect(fixture.metadata.get(getSessionRoomId(item.target.sessionId))).toMatchObject({
            latestUserMsgId: item.target.userTurnId,
          });
        }
        expect(fixture.dispatched).toHaveLength(2);
        if (selection === 'model-b effort') {
          expect(operation.frozenContinuationConfig.targetDispatchConfigs?.[0]).toMatchObject({
            inheritedDispatchConfig: {
              modeId: 'plan',
              modelId: 'model-b',
              configOptionValues: {
                reasoning_effort: 'xhigh',
                fast: true,
                approval_policy: 'on-request',
              },
            },
          });
        }
      } finally {
        store.close();
      }
    }
  );

  it.each(['missing model', 'no cache', 'unsupported mode'] as const)(
    'finishes an accepted chat follow-up with %s instead of leaving it in materialization retry',
    async (missing) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'lody-inherited-chat-'));
      roots.add(root);
      vi.stubEnv('LODY_DATA_DIR', root);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime('2026-10-10T00:00:00.000Z');
      const fixture = createFixture(
        'codex',
        missing === 'no cache' ? undefined : createModelCapability()
      );
      await fixture.seedChat({
        prompt: 'Earlier target prompt',
        cliType: 'builtin',
        agentType: 'codex',
        ...(missing === 'unsupported mode'
          ? { modeId: 'retired-mode' }
          : { modelId: 'retired-model' }),
      });
      const targetHistory = await fixture.history();
      const requesterSessionId = 'inherited-chat-requester' as SessionId;
      await fixture.seedChat(
        { prompt: 'Delegate a follow-up', cliType: 'builtin', agentType: 'codex' },
        requesterSessionId
      );
      const operationId = 'inherited-chat-operation';
      await fixture.runMcp(requesterSessionId, () =>
        __lodyMcpServerInternals.startSessionChatOperation({
          operationId,
          sessionId,
          prompt: 'Continue',
        })
      );

      const storePath = getLodyOperationStorePath(machineId);
      const store = new LodyOperationStore(storePath);
      const coordinator = new LodyOperationCoordinator({
        workspaceId,
        machineId,
        userId,
        workspaceDocument: fixture.manager,
        executionService: { getExecutionSnapshot: () => ({ hasActiveTurn: false }) } as never,
        dispatchWatcher: { hasPendingDispatch: () => false } as never,
        logger: { warn: () => undefined, debug: () => undefined } as never,
        storePath,
        storeFactory: () => new LodyOperationStore(storePath),
        operationStoreWatchFactory: () => ({ close: () => undefined }),
        confirmTargetReadable: async () => undefined,
        materializeTarget: async () => {
          throw new Error('A persisted chat must not be rematerialized');
        },
      });
      try {
        const accepted = store.get(requesterSessionId, operationId);
        expect(accepted).toMatchObject({
          state: 'active',
          items: [{ status: 'active', inputDurable: true }],
        });
        const item = accepted.items[0];
        if (!item || item.status !== 'active') throw new Error('Expected active accepted chat');
        const latest = (await fixture.history()).at(-1);
        expect((await fixture.history()).slice(0, -1)).toEqual(targetHistory);
        expect(latest).toMatchObject({
          id: item.target.userTurnId,
          inputConfig: { modeId: 'agent-auto-review' },
        });
        expect(latest?.inputConfig?.modelId).toBeUndefined();
        expect(fixture.dispatched).toEqual([latest]);
        expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
          latestUserMsgId: item.target.userTurnId,
        });
        coordinator.start();
        await coordinator.idle();
        await fixture.completeTurn(sessionId, item.target.userTurnId);
        await coordinator.wake('synthetic-target-completed');
        await coordinator.idle();

        expect(store.get(requesterSessionId, operationId)).toMatchObject({
          state: 'finished',
          items: [{ status: 'succeeded', target: item.target }],
          completion: { type: 'result', value: { items: [{ status: 'succeeded' }] } },
        });
        expect(fixture.dispatched).toEqual([latest]);
      } finally {
        await coordinator.idle();
        await coordinator.stop();
        store.close();
      }
    }
  );
});

describe.each([
  ['codex', 'agent-auto-review'],
  ['claude', 'auto'],
] as const)('%s default through command boundaries', (agentType, modeId) => {
  it('survives create prevalidation and durable JSON replay without ACP cache', async () => {
    const fixture = createFixture(agentType);
    const validated = await fixture.validateCreate();
    const replayed = JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig;

    expect(replayed).toMatchObject({ modeId, builtinDefaultModeId: modeId });
    expect(fixture.metadata.get(getSessionRoomId(sessionId))).toBeUndefined();
    expect(await fixture.history()).toEqual([]);
    await fixture.run('create', replayed);

    expect(await fixture.history()).toMatchObject([
      { id: userTurnId, inputConfig: { cliType: 'builtin', agentType, modeId } },
    ]);
    expect(fixture.dispatched).toEqual(await fixture.history());
    expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
      latestUserMsgId: userTurnId,
    });
  });

  it.each(['absent', 'excluding'] as const)(
    'replays legacy inherited-default provenance with an %s cache',
    async (cache) => {
      const fixture = createFixture(
        agentType,
        cache === 'absent'
          ? undefined
          : {
              cliType: 'builtin',
              agentType,
              modes: [{ id: 'plan', name: 'Plan' }],
              models: [],
              fetchedAt: 1,
            }
      );
      await fixture.run('create', {
        modeId,
        inheritedBuiltinDefaultModeId: modeId,
        inheritSessionDefaults: false,
      });
      const history = await fixture.history();
      expect(history).toHaveLength(1);
      expect(history[0]?.inputConfig?.modeId).toBe(cache === 'absent' ? modeId : undefined);
      expect(fixture.dispatched).toEqual(history);
    }
  );

  it('retains the persisted builtin default when the next chat still has no ACP cache', async () => {
    const fixture = createFixture(agentType);
    await fixture.run('create', {});
    await fixture.run('chat', {}, 'next-user-turn');

    expect(await fixture.history()).toMatchObject([
      { id: userTurnId, inputConfig: { cliType: 'builtin', agentType, modeId } },
      { id: 'next-user-turn', inputConfig: { cliType: 'builtin', agentType, modeId } },
    ]);
    expect(fixture.dispatched).toEqual(await fixture.history());
    expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
      latestUserMsgId: 'next-user-turn',
    });
  });

  it.each(['absent', 'supported'] as const)(
    'preserves an inherited default from an initially %s cache through no-cache JSON replay',
    async (initialCache) => {
      const fixture = createFixture(
        agentType,
        initialCache === 'supported'
          ? {
              cliType: 'builtin',
              agentType,
              modes: [{ id: modeId, name: 'Supported builtin mode' }],
              models: [],
              fetchedAt: 1,
            }
          : undefined
      );
      const validated = await fixture.validateCreate({
        frozenInheritedInputConfig: { cliType: 'builtin', agentType, modeId },
      });
      expect(validated).toMatchObject({ modeId, inheritedDispatchConfig: { modeId } });
      expect(validated.builtinDefaultModeId).toBeUndefined();
      fixture.setCapability(undefined, false);

      await fixture.run(
        'create',
        JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig
      );

      expect(await fixture.history()).toMatchObject([
        { id: userTurnId, inputConfig: { cliType: 'builtin', agentType, modeId } },
      ]);
      expect(fixture.dispatched).toEqual(await fixture.history());
    }
  );

  describe.each([
    ['confirmed freshness', true],
    ['failed freshness with a readable cache', false],
  ] as const)('replay after capability arrival with %s', (_freshness, confirmed) => {
    const capability = {
      cliType: 'builtin' as const,
      agentType,
      modes: [{ id: 'plan', name: 'Plan only' }],
      models: [],
      configOptions: [],
      fetchedAt: 1,
    } satisfies AcpCapabilityCacheEntry;

    it('omits an unoffered derived default and persists and dispatches the replayed create', async () => {
      const fixture = createFixture(agentType);
      const validated = await fixture.validateCreate();
      const replayed = JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig;
      expect(replayed).toMatchObject({ modeId, builtinDefaultModeId: modeId });

      fixture.setCapability(capability, confirmed);
      await expect(fixture.run('create', replayed)).resolves.toMatchObject({
        sessionId,
        userTurnId,
      });

      const history = await fixture.history();
      expect(history).toMatchObject([
        { id: userTurnId, inputConfig: { cliType: 'builtin', agentType } },
      ]);
      expect(history[0]?.inputConfig?.modeId).toBeUndefined();
      expect(fixture.dispatched).toEqual(history);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
        latestUserMsgId: userTurnId,
      });
    });

    it.each(['explicit', 'inherited'] as const)(
      'preserves frozen %s mode provenance when it is no longer advertised',
      async (source) => {
        const fixture = createFixture(agentType, {
          ...capability,
          modes: [{ id: modeId, name: 'Supported builtin mode' }],
        });
        const validated = await fixture.validateCreate(
          source === 'explicit'
            ? { modeId }
            : {
                frozenInheritedInputConfig: { cliType: 'builtin', agentType, modeId },
              }
        );
        expect(validated.modeId).toBe(modeId);
        expect(validated.builtinDefaultModeId).toBeUndefined();
        expect(validated.inheritedDispatchConfig).toEqual(
          source === 'inherited' ? { modeId } : undefined
        );
        const replayed = JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig;

        fixture.setCapability(capability, confirmed);
        if (source === 'explicit') {
          await expect(fixture.run('create', replayed)).rejects.toThrow(
            confirmed
              ? `Unsupported ACP mode for the selected agent: ${modeId}`
              : `ACP mode is absent from the local replica: ${modeId}`
          );
          expect(await fixture.history()).toEqual([]);
          expect(fixture.metadata.get(getSessionRoomId(sessionId))).toBeUndefined();
          expect(fixture.dispatched).toEqual([]);
        } else {
          await fixture.run('create', replayed);
          const history = await fixture.history();
          expect(history).toMatchObject([{ id: userTurnId }]);
          expect(history[0]?.inputConfig?.modeId).toBeUndefined();
          expect(fixture.dispatched).toEqual(history);
          expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
            latestUserMsgId: userTurnId,
          });
        }
      }
    );

    it('drops an inherited no-cache default once a readable catalog excludes it', async () => {
      const fixture = createFixture(agentType);
      const validated = await fixture.validateCreate({
        frozenInheritedInputConfig: { cliType: 'builtin', agentType, modeId },
      });
      expect(validated).toMatchObject({ modeId, inheritedDispatchConfig: { modeId } });
      expect(validated.builtinDefaultModeId).toBeUndefined();
      fixture.setCapability(capability, confirmed);

      await fixture.run(
        'create',
        JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig
      );

      const history = await fixture.history();
      expect(history).toMatchObject([{ id: userTurnId }]);
      expect(history[0]?.inputConfig?.modeId).toBeUndefined();
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
        latestUserMsgId: userTurnId,
      });
      expect(fixture.dispatched).toEqual(history);
    });

    it.each([
      ['model', { modelId: 'unavailable-model' }],
      ['config option', { configOptionValues: { unknown_option: true } }],
    ] satisfies Array<[string, ResolvedTurnDispatchConfig]>)(
      'still validates an explicit %s alongside a derived mode',
      async (selection, explicit) => {
        const fixture = createFixture(agentType);
        const validated = await fixture.validateCreate();
        fixture.setCapability(capability, confirmed);

        await expect(fixture.run('create', { ...validated, ...explicit })).rejects.toThrow(
          selection === 'model'
            ? confirmed
              ? 'Unsupported ACP model for the selected agent: unavailable-model'
              : 'ACP model is absent from the local replica: unavailable-model'
            : confirmed
              ? 'Unknown ACP config option for the selected agent: unknown_option'
              : 'ACP config option is absent from the local replica: unknown_option'
        );

        expect(await fixture.history()).toEqual([]);
        expect(fixture.metadata.get(getSessionRoomId(sessionId))).toBeUndefined();
        expect(fixture.dispatched).toEqual([]);
      }
    );

    it('preserves a frozen explicit model and option when the derived mode is omitted', async () => {
      const supportedCapability: AcpCapabilityCacheEntry = {
        ...capability,
        modes: [{ id: modeId, name: 'Supported builtin mode' }],
        models: [{ modelId: 'selected-model', name: 'Selected model' }],
        configOptions: [
          { id: 'approved_option', name: 'Approved option', type: 'boolean', currentValue: false },
        ],
      };
      const fixture = createFixture(agentType, supportedCapability);
      const explicit = {
        modelId: 'selected-model',
        configOptionValues: { approved_option: true },
      };
      const validated = await fixture.validateCreate(explicit);
      expect(validated).toMatchObject({ ...explicit, modeId, builtinDefaultModeId: modeId });
      fixture.setCapability({ ...supportedCapability, modes: capability.modes }, confirmed);

      await fixture.run(
        'create',
        JSON.parse(JSON.stringify(validated)) as ResolvedTurnDispatchConfig
      );

      const history = await fixture.history();
      expect(history).toMatchObject([{ id: userTurnId, inputConfig: explicit }]);
      expect(history[0]?.inputConfig?.modeId).toBeUndefined();
      expect(fixture.dispatched).toEqual(history);
    });

    it.each(['unwritten', 'builtin', 'omitted'] as const)(
      'recovers an accepted Operation with %s input and finishes after real create and target completion',
      async (initialInput) => {
        const fixture = createFixture(agentType);
        const validated = await fixture.validateCreate();
        expect(validated).toMatchObject({ modeId, builtinDefaultModeId: modeId });
        const root = await mkdtemp(path.join(os.tmpdir(), 'lody-default-replay-'));
        roots.add(root);
        const storePath = path.join(root, 'operations.sqlite3');
        const now = () => Date.parse('2026-10-10T00:00:00.000Z');
        const requesterSessionId = 'default-fallback-requester' as SessionId;
        const operationId = 'default-fallback-operation';
        const acceptingStore = new LodyOperationStore(storePath, now);
        try {
          acceptingStore.accept({
            workspaceId,
            ownerMachineId: machineId,
            requesterSessionId,
            requesterUserId: userId,
            operationId,
            kind: 'session_create',
            canonicalCommand: { prompt: 'Continue' },
            frozenContinuationConfig: {
              inputConfig: { cliType: 'builtin', agentType },
              targetDispatchConfigs: [validated],
            },
            initiatorChainDepth: 0,
            createdAt: '2026-10-10T00:00:00.000Z',
            deadlineAt: '2026-10-11T00:00:00.000Z',
            items: [{ status: 'active', target: { sessionId, userTurnId }, inputDurable: false }],
          });
        } finally {
          acceptingStore.close();
        }
        if (initialInput !== 'unwritten') {
          if (initialInput === 'omitted') fixture.setCapability(capability, confirmed);
          fixture.failNextDispatchPointer();
          await expect(fixture.run('create', validated)).rejects.toThrow(
            'Synthetic dispatch-pointer write failed'
          );
          expect(await fixture.history()).toMatchObject([{ id: userTurnId }]);
          expect((await fixture.history())[0]?.inputConfig?.modeId).toBe(
            initialInput === 'builtin' ? modeId : undefined
          );
          expect(fixture.metadata.get(getSessionRoomId(sessionId))).not.toHaveProperty(
            'latestUserMsgId'
          );
          expect(fixture.dispatched).toEqual([]);
        }
        const beforeRecovery = await fixture.history();
        if (initialInput === 'omitted') fixture.setCapability(undefined, false);
        else fixture.setCapability(capability, confirmed);
        const recoveryWarnings: string[] = [];
        const coordinator = new LodyOperationCoordinator({
          workspaceId,
          machineId,
          userId,
          workspaceDocument: fixture.manager,
          executionService: {
            getExecutionSnapshot: () => ({ hasActiveTurn: false }),
          } as never,
          dispatchWatcher: { hasPendingDispatch: () => false } as never,
          logger: {
            warn: (message: string) => recoveryWarnings.push(message),
            debug: () => undefined,
          } as never,
          storePath,
          storeFactory: () => new LodyOperationStore(storePath, now),
          now,
          operationStoreWatchFactory: () => ({ close: () => undefined }),
          confirmTargetReadable: async () => undefined,
          materializeTarget: async (operation) => {
            const recovered = operation.frozenContinuationConfig.targetDispatchConfigs?.[0];
            if (!recovered) throw new Error('Expected persisted create configuration');
            await fixture.run('create', recovered);
          },
        });
        const recoveredStore = new LodyOperationStore(storePath, now);
        try {
          coordinator.start();
          await coordinator.idle();

          expect(
            recoveredStore.get(requesterSessionId, operationId),
            recoveryWarnings.join('\n')
          ).toMatchObject({
            state: 'active',
            items: [{ status: 'active', inputDurable: true }],
          });
          expect(fixture.dispatched).toEqual(await fixture.history());
          expect(fixture.dispatched).toHaveLength(1);
          expect(fixture.dispatched[0]?.inputConfig?.modeId).toBe(
            initialInput === 'builtin' ? modeId : undefined
          );
          if (initialInput !== 'unwritten') expect(await fixture.history()).toEqual(beforeRecovery);
          expect(fixture.metadata.get(getSessionRoomId(sessionId))).toMatchObject({
            latestUserMsgId: userTurnId,
          });

          await fixture.completeTurn();
          await coordinator.wake('synthetic-target-completed');
          await coordinator.idle();

          expect(recoveredStore.get(requesterSessionId, operationId)).toMatchObject({
            state: 'finished',
            items: [{ status: 'succeeded', target: { sessionId, userTurnId } }],
            completion: { type: 'result', value: { items: [{ status: 'succeeded' }] } },
          });
        } finally {
          await coordinator.idle();
          await coordinator.stop();
          recoveredStore.close();
        }
      }
    );

    it.each([
      ['mode', { modeId: 'plan' }],
      ['model', { modelId: 'selected-model' }],
      ['config option', { configOptionValues: { approved_option: true } }],
    ] satisfies Array<[string, ResolvedTurnDispatchConfig]>)(
      'rejects an interrupted create with a conflicting persisted %s without rewriting or dispatch',
      async (_selection, differentConfig) => {
        const fixture = createFixture(agentType);
        const validated = await fixture.validateCreate();
        const supportedCapability: AcpCapabilityCacheEntry = {
          ...capability,
          modes: [...capability.modes, { id: modeId, name: 'Supported builtin mode' }],
          models: [{ modelId: 'selected-model', name: 'Selected model' }],
          configOptions: [
            {
              id: 'approved_option',
              name: 'Approved option',
              type: 'boolean',
              currentValue: false,
            },
          ],
        };
        fixture.setCapability(supportedCapability, confirmed);
        fixture.failNextDispatchPointer();
        await expect(fixture.run('create', { ...validated, ...differentConfig })).rejects.toThrow(
          'Synthetic dispatch-pointer write failed'
        );
        const previousHistory = await fixture.history();
        const previousMetadata = fixture.metadata.get(getSessionRoomId(sessionId));
        expect(previousHistory).toHaveLength(1);
        fixture.setCapability({ ...supportedCapability, modes: capability.modes }, confirmed);

        await expect(fixture.run('create', validated)).rejects.toThrow(
          'Prepared Session Turn identity conflict'
        );

        expect(await fixture.history()).toEqual(previousHistory);
        expect(fixture.metadata.get(getSessionRoomId(sessionId))).toEqual(previousMetadata);
        expect(fixture.dispatched).toEqual([]);
      }
    );
  });

  it.each([
    ['explicit default without provenance', {}],
    ['mismatched default provenance', { builtinDefaultModeId: 'unrelated-mode' }],
    ['matching nondefault provenance', { modeId: 'plan', builtinDefaultModeId: 'plan' }],
    ['changed mode after default resolution', { modeId: 'plan' }],
    ['model alongside a derived default', { modelId: 'unavailable-model' }],
    ['option alongside a derived default', { configOptionValues: { unknown_option: true } }],
  ] satisfies Array<[string, ResolvedTurnDispatchConfig]>)(
    'rejects %s before any create writes or dispatch',
    async (name, overrides) => {
      const fixture = createFixture(agentType);
      const dispatchConfig = {
        modeId,
        ...(name === 'explicit default without provenance' ? {} : { builtinDefaultModeId: modeId }),
        ...overrides,
      };

      await expect(fixture.run('create', dispatchConfig)).rejects.toBeInstanceOf(
        MachineFlockReadUnavailableError
      );

      expect(await fixture.history()).toEqual([]);
      expect(fixture.metadata.get(getSessionRoomId(sessionId))).toBeUndefined();
      expect(fixture.dispatched).toEqual([]);
    }
  );
});
