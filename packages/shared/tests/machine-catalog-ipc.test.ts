import { describe, expect, it } from 'vitest';
import {
  MACHINE_CATALOG_COMMAND_MAX_BYTES,
  MachineCatalogIpcError,
  machineCatalogIpcEditorRequestSchema,
  machineCatalogIpcExecuteRequestSchema,
  machineCatalogIpcUploadRequestSchema,
  machineCatalogIpcEditorResultSchema,
  machineCatalogIpcCommandResultSchema,
  machineCatalogIpcUploadResultSchema,
  machineCatalogIpcCancelResultSchema,
  machineCatalogIpcErrorCode,
  machineCatalogIpcRequestSchema,
  machineCatalogIpcUnsubscribeSchema,
  parseMachineCatalogIpcCommand,
  parseMachineCatalogIpcEditor,
  parseMachineCatalogIpcSnapshot,
  parseMachineCatalogIpcEvent,
} from '../src/machine-catalog-ipc';
import {
  MachineCatalogError,
  prepareAgentConfigEdit,
  type MachineCatalogCommand,
} from '../src/machine-catalog';
import type { AgentConfigMeta } from '../src/schema';

const machineId = 'synthetic-machine';
const config = {
  id: 'synthetic-agent',
  machineId,
  name: 'Synthetic',
  description: 'Public description',
  cliType: 'custom',
  agentType: 'custom-synthetic',
  env: { TOKEN: 'synthetic-private-token' },
  customAcp: { command: 'synthetic-acp', args: ['--synthetic'] },
  prompt: 'synthetic-private-prompt',
} as const;
const summary = {
  id: config.id,
  machineId,
  name: config.name,
  description: config.description,
  cliType: config.cliType,
  agentType: config.agentType,
};
const task = {
  v: 1,
  id: config.id,
  machineId,
  config: { ...config, cliType: 'builtin', agentType: 'claude', customAcp: undefined },
  status: 'queued',
  attempt: 1,
  createdAt: 1,
  updatedAt: 1,
};
const projection = () => ({
  agents: [config],
  projects: [
    {
      id: 'project',
      name: 'Public project',
      rootPath: '/synthetic/project',
      createdAtMs: 1,
      history: { secret: 'hidden-history' },
    },
  ],
  memories: [
    {
      machineId,
      providerId: 'provider',
      memoryId: 'memory',
      name: 'Public memory',
      privateRuntime: 'hidden',
    },
  ],
  acp: [
    {
      configId: config.id,
      cliType: 'custom',
      agentType: config.agentType,
      fetchedAt: 1,
      sourceVersion: 'builtin+override:synthetic-private-launch',
      modes: [{ id: 'mode', name: 'Mode', secret: 'hidden' }],
      models: [{ modelId: 'model', name: 'Model', secret: 'hidden' }],
      optionIds: ['option'],
      sessionFork: true,
      sessionTitle: true,
      acknowledgedSteer: false,
      env: config.env,
    },
  ],
  modelCapabilities: [
    {
      configId: config.id,
      sourceVersion: 'builtin+override:synthetic-private-launch',
      modelIds: ['model'],
      env: config.env,
    },
  ],
  modelOptions: [{ configId: config.id, modelId: 'model', shape: 'shape', config: config.env }],
  modelShapes: [
    { configId: config.id, shapeId: 'shape', optionIds: ['option'], config: config.env },
  ],
  quotas: [
    { configId: config.id, cliType: 'custom', limitId: 'quota', remaining: 3, env: config.env },
  ],
  optOuts: [{ agentType: 'claude', removedAt: 2 }],
  providerSetups: [
    {
      ...task,
      config: { ...config, profile: 'private-profile', codexAuth: { token: 'hidden-auth' } },
    },
  ],
  commandCounts: {
    archiveSession: 1,
    deleteSession: 2,
    deleteLocalProject: 3,
    providerCancellation: 4,
  },
  localProjectDeletionResults: [
    {
      projectId: 'project',
      completedAt: 1,
      deletedCount: 1,
      skippedDirtyCount: 0,
      failedCount: 0,
      paths: ['private-path'],
    },
  ],
  legacyLaunchCount: 1,
  rawRows: [{ env: config.env }],
});

describe('machine catalog IPC management boundary', () => {
  it('accepts every existing finite UI command and delegates row validation to the existing business parser', () => {
    const cases: Record<MachineCatalogCommand['kind'], unknown> = {
      'import-magpie': {
        kind: 'import-magpie',
        request: { gatewayUrl: 'http://localhost:3425/', targets: ['claude'] },
      },
      'create-agent': { kind: 'create-agent', config },
      'edit-agent': {
        kind: 'edit-agent',
        id: config.id,
        editToken: 'edit',
        changes: { name: 'Renamed', env: { kind: 'keep' } },
      },
      'remove-agent': { kind: 'remove-agent', id: config.id, editToken: 'edit', now: 2 },
      'set-dot-lody-path': { kind: 'set-dot-lody-path', path: '/synthetic/dotlody' },
      'clear-dot-lody-path': { kind: 'clear-dot-lody-path' },
      'dismiss-local-project-deletion': {
        kind: 'dismiss-local-project-deletion',
        projectId: 'project',
        completedAt: 2,
      },
      'ensure-local-project': {
        kind: 'ensure-local-project',
        project: { id: 'project', name: 'Project', rootPath: '/synthetic/project', createdAtMs: 1 },
      },
      'edit-local-project': {
        kind: 'edit-local-project',
        id: 'project',
        changes: {
          standaloneVisible: false,
          githubRepoFullName: { kind: 'set', value: 'owner/repo' },
        },
      },
      'invalidate-project-history-import': {
        kind: 'invalidate-project-history-import',
        projectId: 'project',
        provider: { cliType: 'builtin', agentType: 'claude', agentConfigId: 'provider' },
        sourceAcpSessionId: 'external',
        importedSessionId: 'session',
      },
      'remove-session-launch-reference': {
        kind: 'remove-session-launch-reference',
        sessionId: 'session',
      },
      'save-local-project': {
        kind: 'save-local-project',
        project: { id: 'project', name: 'Project', rootPath: '/synthetic/project', createdAtMs: 1 },
      },
      'associate-memory': {
        kind: 'associate-memory',
        association: { machineId, providerId: 'provider', memoryId: 'memory', name: 'Memory' },
      },
      'link-memory': {
        kind: 'link-memory',
        association: { machineId, providerId: 'provider', memoryId: 'memory', name: 'Memory' },
      },
      'edit-memory': {
        kind: 'edit-memory',
        association: { machineId, providerId: 'provider', memoryId: 'memory', name: 'Renamed' },
      },
      'remove-memory': { kind: 'remove-memory', providerId: 'provider', memoryId: 'memory' },
      'archive-session': {
        kind: 'archive-session',
        sessionId: 'session',
        command: { v: 1, requestedAt: 1 },
      },
      'delete-session': {
        kind: 'delete-session',
        sessionId: 'session',
        command: { v: 1, requestedAt: 1, originalRootPath: '/synthetic/project' },
      },
      'delete-local-project': {
        kind: 'delete-local-project',
        projectId: 'project',
        command: { v: 1, requestedAt: 1, cleanupWorktrees: true },
      },
      'queue-provider-setup': { kind: 'queue-provider-setup', task },
      'retry-provider-setup': {
        kind: 'retry-provider-setup',
        id: config.id,
        expected: { attempt: 1, status: 'failed', updatedAt: 1 },
        now: 2,
      },
      'cancel-provider-setup': {
        kind: 'cancel-provider-setup',
        cancellation: { v: 1, id: config.id, machineId, cancelledAt: 2 },
      },
      'set-builtin-opt-out': { kind: 'set-builtin-opt-out', agentType: 'claude', removedAt: 2 },
    };
    for (const command of Object.values(cases))
      expect(parseMachineCatalogIpcCommand(command, machineId).kind).toBe(
        (command as { kind: string }).kind
      );
    expect(parseMachineCatalogIpcCommand(cases['import-magpie'], machineId)).toEqual({
      kind: 'import-magpie',
      request: { gatewayUrl: 'http://localhost:3425', targets: ['claude'] },
    });
  });

  it('rejects wrong-machine rows, runtime acknowledgements and caller-selected storage/identity', () => {
    const invalid = [
      { kind: 'create-agent', config: { ...config, machineId: 'other' } },
      {
        kind: 'queue-provider-setup',
        task: { ...task, config: { ...task.config, machineId: 'other' } },
      },
      { kind: 'queue-provider-setup', task: { ...task, status: 'verifying' } },
      { kind: 'queue-provider-setup', task: { ...task, failureCode: 'verification-failed' } },
      {
        kind: 'delete-local-project',
        projectId: 'project',
        command: { v: 1, requestedAt: 1, status: 'completed' },
      },
      { kind: 'create-agent', config: { ...config, runtimeHandle: 'private' } },
      { kind: 'clear-dot-lody-path', namespace: 'other', room: 'other', accountId: 'other' },
      { kind: 'runtime-read', family: 'agentConfig' },
      {
        kind: 'import-magpie',
        request: { gatewayUrl: 'https://example.com', targets: ['claude'] },
      },
      {
        kind: 'import-magpie',
        request: { gatewayUrl: 'http://localhost:3425', targets: ['claude', 'claude'] },
      },
    ];
    for (const command of invalid)
      expect(() => parseMachineCatalogIpcCommand(command, machineId)).toThrow(
        MachineCatalogIpcError
      );
  });

  it('preserves existing secrets through keep and supports deliberate replace/clear edits', () => {
    const previous = { ...config, future: { retained: true } } as unknown as AgentConfigMeta;
    const parsed = parseMachineCatalogIpcCommand(
      {
        kind: 'edit-agent',
        id: config.id,
        editToken: 'edit',
        changes: { name: 'Renamed', env: { kind: 'keep' } },
      },
      machineId
    );
    if (parsed.kind !== 'edit-agent') throw new Error('wrong command');
    const kept = prepareAgentConfigEdit(previous, parsed.changes);
    expect(kept.config.env).toEqual(config.env);
    expect(kept.launchChanged).toBe(false);
    const replaced = parseMachineCatalogIpcCommand(
      {
        kind: 'edit-agent',
        id: config.id,
        editToken: 'edit',
        changes: {
          envEntries: [{ name: 'TOKEN', value: { kind: 'replace', value: 'new-synthetic' } }],
          prompt: { kind: 'clear' },
        },
      },
      machineId
    );
    if (replaced.kind !== 'edit-agent') throw new Error('wrong command');
    const changed = prepareAgentConfigEdit(previous, replaced.changes);
    expect(changed.config.env).toEqual({ TOKEN: 'new-synthetic' });
    expect(changed.config.prompt).toBeUndefined();
    expect(changed.launchChanged).toBe(true);
    expect(() =>
      parseMachineCatalogIpcCommand(
        {
          ...parsed,
          changes: { customAcp: { kind: 'replace', value: { command: 'acp', rawSDK: {} } } },
        },
        machineId
      )
    ).toThrow();
    expect(() =>
      parseMachineCatalogIpcCommand(
        { ...parsed, changes: { envEntries: [{ name: '__proto__', value: { kind: 'clear' } }] } },
        machineId
      )
    ).toThrow();
  });

  it('constructs the complete safe projection/editor without forwarding stored credentials or unknown fields', () => {
    const raw = {
      machineId,
      generation: 'generation',
      synced: true,
      projection: projection(),
      namespace: 'private',
    };
    const safe = parseMachineCatalogIpcSnapshot(raw);
    expect(safe.projection.agents).toEqual([summary]);
    expect(safe.projection.providerSetups[0]?.config).toEqual(summary);
    expect(safe.projection.commandCounts.deleteSession).toBe(2);
    expect(safe.projection.projects[0]?.rootPath).toBe('/synthetic/project');
    const encoded = JSON.stringify(safe);
    for (const secret of [
      'synthetic-private',
      'private-profile',
      'hidden-auth',
      'hidden-history',
      'rawRows',
      'privateRuntime',
      'private-path',
      'namespace',
    ])
      expect(encoded).not.toContain(secret);
    expect(raw.projection.agents[0]?.env).toEqual(config.env);
    const edit = parseMachineCatalogIpcEditor({
      ...config,
      editToken: 'edit',
      expiresAt: 100,
      credentials: {
        envPresent: true,
        customLaunchPresent: true,
        runtimeOverridesPresent: false,
        profilePresent: false,
        env: config.env,
      },
      hasPrompt: true,
      credentialVerification: 'unknown',
    });
    expect(edit.credentials.envPresent).toBe(true);
    expect(edit.editToken).toBe('edit');
    expect(JSON.stringify(edit)).not.toContain('synthetic-private');
    expect(() => parseMachineCatalogIpcSnapshot({ ...raw, machineId: 'other' })).toThrow();
  });

  it('enforces UTF-8 budgets and reports only finite errors', () => {
    const command = {
      kind: 'create-agent',
      config: { ...config, env: { TOKEN: 'a'.repeat(30_000) } },
    };
    expect(parseMachineCatalogIpcCommand(command, machineId).kind).toBe('create-agent');
    command.config.env.TOKEN = '界'.repeat(30_000);
    expect(new TextEncoder().encode(JSON.stringify(command)).byteLength).toBeGreaterThan(
      MACHINE_CATALOG_COMMAND_MAX_BYTES
    );
    expect(() => parseMachineCatalogIpcCommand(command, machineId)).toThrow(
      'machine_catalog_invalid_request'
    );
    expect(machineCatalogIpcErrorCode(new Error('synthetic-private-token'))).toBe(
      'operation_failed'
    );
    expect(machineCatalogIpcErrorCode(new MachineCatalogError('edit_conflict'))).toBe(
      'edit_conflict'
    );
    expect(
      machineCatalogIpcErrorCode(Object.assign(new Error('private'), { code: 'restart_required' }))
    ).toBe('restart_required');
    expect(
      machineCatalogIpcErrorCode(Object.assign(new Error('private'), { code: 'synthetic-secret' }))
    ).toBe('operation_failed');
  });

  it('requires the mounted generation on stateful calls and authoritative generation receipts', () => {
    const request = {
      machineId,
      registrationId: '00000000-0000-4000-8000-000000000001',
      requestId: '00000000-0000-4000-8000-000000000002',
    };
    expect(machineCatalogIpcRequestSchema.parse(request)).toEqual(request);
    const stateful = { ...request, expectedGeneration: 'server-generation' };
    expect(
      machineCatalogIpcEditorRequestSchema.parse({ ...stateful, id: config.id }).expectedGeneration
    ).toBe('server-generation');
    expect(
      machineCatalogIpcExecuteRequestSchema.parse({
        ...stateful,
        command: { kind: 'clear-dot-lody-path' },
      }).expectedGeneration
    ).toBe('server-generation');
    expect(machineCatalogIpcUploadRequestSchema.parse(stateful)).toEqual(stateful);
    for (const expectedGeneration of [undefined, '', 'g'.repeat(513)]) {
      expect(() =>
        machineCatalogIpcEditorRequestSchema.parse({
          ...request,
          id: config.id,
          expectedGeneration,
        })
      ).toThrow();
      expect(() =>
        machineCatalogIpcExecuteRequestSchema.parse({
          ...request,
          command: { kind: 'clear-dot-lody-path' },
          expectedGeneration,
        })
      ).toThrow();
      expect(() =>
        machineCatalogIpcUploadRequestSchema.parse({ ...request, expectedGeneration })
      ).toThrow();
    }
    expect(
      machineCatalogIpcCommandResultSchema.parse({ generation: 'server-generation', changed: true })
    ).toEqual({ generation: 'server-generation', changed: true });
    expect(machineCatalogIpcUploadResultSchema.parse({ generation: 'server-generation' })).toEqual({
      generation: 'server-generation',
    });
    expect(() => machineCatalogIpcCommandResultSchema.parse({ changed: true })).toThrow();
    expect(() => machineCatalogIpcUploadResultSchema.parse({})).toThrow();
    const safeEditor = {
      ...config,
      editToken: 'edit',
      expiresAt: 100,
      credentials: {
        envPresent: true,
        customLaunchPresent: true,
        runtimeOverridesPresent: false,
        profilePresent: false,
      },
      hasPrompt: true,
      credentialVerification: 'unknown',
    };
    const receipt = machineCatalogIpcEditorResultSchema.parse({
      generation: 'server-generation',
      editor: safeEditor,
    });
    expect(receipt.generation).toBe('server-generation');
    expect(JSON.stringify(receipt)).not.toContain('synthetic-private');
    expect(() => machineCatalogIpcEditorResultSchema.parse({ editor: safeEditor })).toThrow();
    expect(machineCatalogIpcCancelResultSchema.parse({ canceled: true })).toEqual({
      canceled: true,
    });
    expect(() => machineCatalogIpcCancelResultSchema.parse({ canceled: false })).toThrow();
    expect(() =>
      machineCatalogIpcCancelResultSchema.parse({ canceled: true, generation: 'server-generation' })
    ).toThrow();
  });

  it('requires exact registration/request/lease IDs and does not accept renderer account/workspace/room grants', () => {
    const request = {
      machineId,
      registrationId: '00000000-0000-4000-8000-000000000001',
      requestId: '00000000-0000-4000-8000-000000000002',
    };
    expect(machineCatalogIpcRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      machineCatalogIpcRequestSchema.parse({ ...request, workspaceId: 'other' })
    ).toThrow();
    expect(() =>
      machineCatalogIpcUnsubscribeSchema.parse({ ...request, leaseId: 'wrong' })
    ).toThrow();
    const correlation = { ...request, leaseId: '00000000-0000-4000-8000-000000000003' };
    const snapshot = { machineId, generation: 'g', synced: true, projection: projection() };
    const event = parseMachineCatalogIpcEvent({ ...correlation, type: 'snapshot', snapshot });
    expect(event.type).toBe('snapshot');
    expect(JSON.stringify(event)).not.toContain('synthetic-private');
    expect(() =>
      parseMachineCatalogIpcEvent({
        ...correlation,
        machineId: 'other',
        type: 'snapshot',
        snapshot,
      })
    ).toThrow();
    expect(() =>
      parseMachineCatalogIpcEvent({ ...correlation, type: 'error', code: 'synthetic-secret' })
    ).toThrow();
  });
});
