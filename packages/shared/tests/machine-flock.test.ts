import { describe, expect, it } from 'vitest';

import {
  applyMachineFlockRowEvents,
  applyProviderSetupCancellationToFlock,
  buildMachineArchiveSessionCommand,
  buildMachineDeleteLocalProjectCommand,
  buildMachineDeleteSessionCommand,
  deleteAgentConfigFromFlock,
  deleteMachineFlockRowFromFlock,
  getMachineFlockAcpCapabilities,
  getMachineFlockAgentConfigs,
  getMachineFlockBuiltinAgentOptOuts,
  getMachineFlockDeleteLocalProjectEntries,
  getMachineFlockDeleteLocalProjectIds,
  getMachineFlockDotlodyPath,
  getMachineFlockDocId,
  getMachineFlockLocalProjects,
  getMachineFlockRateLimits,
  getMachineFlockSessionLaunchConfig,
  getSessionLaunchConfigLegacyFields,
  isMachineFlockDocId,
  machineDeleteCommandToQueueItem,
  machineFlockKeys,
  mergeSessionLaunchConfig,
  parseMachineFlockDocId,
  parseMachineFlockKey,
  readMachineFlockRowsFromFlock,
  serializeMachineFlockKey,
  writeAgentConfigToFlock,
  writeMachineFlockRowToFlock,
  type AgentConfigMeta,
  type MachineFlockKey,
  type MachineFlockWritableFlock,
} from '../src/machine-flock';
import {
  getRateLimitEntryKey,
  getAcpCapabilityCacheKey,
  type AgentConfigId,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionLegacyMetaFields,
  type SessionMeta,
  type WorkspaceId,
} from '../src';

class FakeMachineFlock implements MachineFlockWritableFlock {
  readonly rows = new Map<string, { key: MachineFlockKey; value: unknown }>();
  readonly scanOptions: Array<{ prefix?: readonly unknown[] } | undefined> = [];
  commits = 0;

  scan(options?: { prefix?: readonly unknown[] }): Iterable<{
    readonly key: readonly unknown[];
    readonly value: unknown;
  }> {
    this.scanOptions.push(options);
    return [...this.rows.values()]
      .filter((row) => {
        const prefix = options?.prefix;
        return !prefix || prefix.every((part, index) => row.key[index] === part);
      })
      .map((row) => ({
        key: row.key,
        value: row.value,
      }));
  }

  set(key: MachineFlockKey, value: unknown): void {
    this.rows.set(JSON.stringify(key), { key: [...key] as MachineFlockKey, value });
  }

  delete(key: MachineFlockKey): void {
    this.rows.delete(JSON.stringify(key));
  }

  commit(): void {
    this.commits += 1;
  }
}

describe('machine Flock helpers', () => {
  it('builds compact command values', () => {
    expect(buildMachineArchiveSessionCommand({ requestedAt: 123 })).toEqual({
      v: 1,
      requestedAt: 123,
    });
    expect(buildMachineDeleteLocalProjectCommand({ requestedAt: 234 })).toEqual({
      v: 1,
      requestedAt: 234,
    });
    expect(
      buildMachineDeleteLocalProjectCommand({
        requestedAt: 235,
        projectName: 'Lody',
        originalRootPath: '/Users/developer/Code/lody',
        cleanupWorktrees: true,
      })
    ).toEqual({
      v: 1,
      requestedAt: 235,
      projectName: 'Lody',
      originalRootPath: '/Users/developer/Code/lody',
      cleanupWorktrees: true,
    });

    expect(
      buildMachineDeleteSessionCommand({
        session: {
          repoFullName: 'owner/repo',
          branchName: 'lody/session-1',
          baseBranch: 'main',
          isWorktree: true,
        },
        requestedAt: 456,
      })
    ).toEqual({
      v: 1,
      repoFullName: 'owner/repo',
      branchName: 'lody/session-1',
      baseBranchName: 'main',
      isWorktree: true,
      requestedAt: 456,
    });

    expect(
      buildMachineDeleteSessionCommand({
        session: {
          repoFullName: 'owner/repo',
          branchName: 'new-branch',
          isWorktree: true,
        },
        requestedAt: 789,
        existing: {
          v: 1,
          requestedAt: 456,
          branchName: 'old-branch',
          keptWorktreePath: '/tmp/kept',
        },
      })
    ).toEqual({
      v: 1,
      repoFullName: 'owner/repo',
      branchName: 'new-branch',
      isWorktree: true,
      requestedAt: 789,
    });

    expect(
      buildMachineDeleteSessionCommand({
        session: {
          parentSessionId: 'parent-session' as SessionId,
          repoFullName: 'owner/repo',
          isWorktree: true,
        },
        requestedAt: 456,
      })
    ).toBeNull();

    expect(machineDeleteCommandToQueueItem({ v: 1, requestedAt: 1 })).toEqual({
      requestedAt: 1,
    });
  });

  it('builds and parses workspace-scoped machine Flock doc ids', () => {
    const workspaceId = 'workspace-1' as WorkspaceId;
    const machineId = 'machine-1' as MachineId;
    const docId = getMachineFlockDocId(workspaceId, machineId);

    expect(docId).toBe('workspace-1:mf:machine-1');
    expect(isMachineFlockDocId(docId)).toBe(true);
    expect(parseMachineFlockDocId(docId)).toEqual({ workspaceId, machineId });
    expect(isMachineFlockDocId('machine-1:flock')).toBe(false);
  });

  it('builds and parses tuple keys', () => {
    const sessionId = 'session-1' as SessionId;
    const localProjectId = 'project-1' as LocalProjectId;

    expect(parseMachineFlockKey(machineFlockKeys.dotlodyPath())).toEqual({
      kind: 'dotlodyPath',
      key: ['dotlodyPath'],
    });
    expect(parseMachineFlockKey(machineFlockKeys.archiveSessionCommand(sessionId))).toMatchObject({
      kind: 'archiveSessionCommand',
      sessionId,
    });
    expect(
      parseMachineFlockKey(machineFlockKeys.deleteLocalProjectCommand(localProjectId))
    ).toMatchObject({
      kind: 'deleteLocalProjectCommand',
      localProjectId,
    });
    expect(parseMachineFlockKey(machineFlockKeys.sessionLaunchConfig(sessionId))).toMatchObject({
      kind: 'sessionLaunchConfig',
      sessionId,
    });
    expect(parseMachineFlockKey(machineFlockKeys.localProject(localProjectId))).toMatchObject({
      kind: 'localProject',
      localProjectId,
    });
    expect(
      parseMachineFlockKey(machineFlockKeys.agentConfig('config-1' as AgentConfigId))
    ).toMatchObject({
      kind: 'agentConfig',
      agentConfigId: 'config-1',
    });
    expect(parseMachineFlockKey(['workspacePath', sessionId])).toBeUndefined();
  });

  it('reads, writes, and deletes current-value rows', () => {
    const flock = new FakeMachineFlock();
    const dotlodyPathRow = {
      key: machineFlockKeys.dotlodyPath(),
      value: '/Users/developer/.lody',
    };
    const archiveRow = {
      key: machineFlockKeys.archiveSessionCommand('session-1' as SessionId),
      value: { v: 1, requestedAt: 123 },
    } as const;

    expect(writeMachineFlockRowToFlock(flock, dotlodyPathRow, 1)).toBe(true);
    expect(writeMachineFlockRowToFlock(flock, dotlodyPathRow, 2)).toBe(false);
    expect(writeMachineFlockRowToFlock(flock, archiveRow, 3)).toBe(true);
    expect(flock.commits).toBe(2);

    flock.rows.set('legacy-workspace-path', {
      key: ['workspacePath', 'session-1'] as unknown as MachineFlockKey,
      value: '/tmp/workspace',
    });

    const rows = readMachineFlockRowsFromFlock(flock);
    expect(rows[serializeMachineFlockKey(dotlodyPathRow.key)]).toEqual(dotlodyPathRow);
    expect(rows[serializeMachineFlockKey(archiveRow.key)]).toEqual(archiveRow);
    expect(Object.values(rows)).toHaveLength(2);
    expect(getMachineFlockDotlodyPath(rows)).toBe('/Users/developer/.lody');

    expect(deleteMachineFlockRowFromFlock(flock, archiveRow.key, 4)).toBe(true);
    expect(deleteMachineFlockRowFromFlock(flock, archiveRow.key, 5)).toBe(false);
    expect(flock.commits).toBe(3);
  });

  it('reads only requested row family prefixes', () => {
    const flock = new FakeMachineFlock();
    const localProjectId = 'project-prefix' as LocalProjectId;
    const agentConfigId = 'agent-prefix' as AgentConfigId;
    flock.set(machineFlockKeys.localProject(localProjectId), {
      id: localProjectId,
      name: 'lody',
      rootPath: '/repo/lody',
      createdAtMs: 1,
    });
    flock.set(machineFlockKeys.agentConfig(agentConfigId), {
      id: agentConfigId,
      machineId: 'machine-prefix',
      name: 'Custom',
      cliType: 'custom',
      agentType: 'custom-agent',
      env: {},
      prompt: '',
    });

    const rows = readMachineFlockRowsFromFlock(flock, { families: ['localProject'] });

    expect(Object.keys(rows)).toEqual([
      serializeMachineFlockKey(machineFlockKeys.localProject(localProjectId)),
    ]);
    expect(flock.scanOptions.at(-1)).toEqual({ prefix: ['localProject'] });

    readMachineFlockRowsFromFlock(flock, { families: ['deleteLocalProjectCommand'] });
    expect(flock.scanOptions.at(-1)).toEqual({ prefix: ['cmd', 'deleteLocalProject'] });
  });

  it('reads and merges per-session launch config rows', () => {
    const flock = new FakeMachineFlock();
    const sessionId = 'session-1' as SessionId;
    const launchConfig = {
      customAcp: { command: 'node', args: ['agent.js'] },
      env: { TOKEN: 'secret' },
      worktreeSetup: { scripts: { bash: 'pnpm install' }, timeoutMs: 30_000 },
    };

    expect(
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.sessionLaunchConfig(sessionId),
        value: launchConfig,
      })
    ).toBe(true);

    const rows = readMachineFlockRowsFromFlock(flock);
    expect(getMachineFlockSessionLaunchConfig(rows, sessionId)).toEqual(launchConfig);
    expect(
      mergeSessionLaunchConfig(getMachineFlockSessionLaunchConfig(rows, sessionId), {
        env: { FALLBACK: 'ignored' },
        worktreeCleanup: { scripts: { bash: 'cleanup' } },
      })
    ).toEqual({
      ...launchConfig,
      worktreeCleanup: { scripts: { bash: 'cleanup' } },
    });
  });

  it('reads legacy launch config fields from old session meta', () => {
    expect(
      getSessionLaunchConfigLegacyFields({
        id: 'session-1' as SessionId,
        machineId: 'machine-1' as MachineId,
        userId: 'user-1',
        createdAt: '2026-04-19T00:00:00.000Z',
        cliType: 'custom',
        agentType: 'custom-agent',
        customAcp: { command: 'node' },
        env: { TOKEN: 'legacy' },
      } as SessionMeta & SessionLegacyMetaFields)
    ).toEqual({
      customAcp: { command: 'node' },
      env: { TOKEN: 'legacy' },
    });
  });

  it('applies Flock row events without rescanning unrelated rows', () => {
    const previous = {
      [serializeMachineFlockKey(machineFlockKeys.dotlodyPath())]: {
        key: machineFlockKeys.dotlodyPath(),
        value: '/Users/developer/.lody',
      },
    };

    const archiveKey = machineFlockKeys.archiveSessionCommand('session-1' as SessionId);
    const next = applyMachineFlockRowEvents(previous, [
      { key: archiveKey, value: { v: 1, requestedAt: 123 } },
      { key: machineFlockKeys.dotlodyPath(), value: undefined },
      { key: ['rateLimit', 'custom', 'bad'], value: {} },
    ]);

    expect(next).toEqual({
      [serializeMachineFlockKey(archiveKey)]: {
        key: archiveKey,
        value: { v: 1, requestedAt: 123 },
      },
    });
    expect(next).not.toBe(previous);
  });

  it('extracts local project rows', () => {
    const localProjectId = 'project-1' as LocalProjectId;
    const row = {
      key: machineFlockKeys.localProject(localProjectId),
      value: {
        id: localProjectId,
        name: 'lody',
        rootPath: '/Users/developer/Code/lody',
        createdAtMs: 1,
      },
    } as const;

    expect(
      getMachineFlockLocalProjects({
        [serializeMachineFlockKey(row.key)]: row,
      })
    ).toEqual({
      [localProjectId]: row.value,
    });
  });

  it('extracts pending local project delete commands', () => {
    const localProjectId = 'project-delete' as LocalProjectId;
    const row = {
      key: machineFlockKeys.deleteLocalProjectCommand(localProjectId),
      value: { v: 1, requestedAt: 123 },
    } as const;
    const rows = {
      [serializeMachineFlockKey(row.key)]: row,
    };

    expect(getMachineFlockDeleteLocalProjectEntries(rows)).toEqual([[localProjectId, row.value]]);
    expect(getMachineFlockDeleteLocalProjectIds(rows)).toEqual(new Set([localProjectId]));
  });

  it('round-trips completed local project cleanup results', () => {
    const localProjectId = 'project-delete' as LocalProjectId;
    const sessionId = 'session-clean' as SessionId;
    const flock = new FakeMachineFlock();
    const key = machineFlockKeys.deleteLocalProjectCommand(localProjectId);
    const value = {
      v: 1 as const,
      requestedAt: 123,
      projectName: 'Lody',
      originalRootPath: '/Users/developer/Code/lody',
      cleanupWorktrees: true as const,
      status: 'completed' as const,
      cleanupResult: {
        completedAt: 456,
        deleted: [{ sessionId, title: 'Clean session', path: '/tmp/session-clean' }],
        skippedDirty: [],
        failed: [],
      },
    };

    expect(writeMachineFlockRowToFlock(flock, { key, value })).toBe(true);
    expect(getMachineFlockDeleteLocalProjectEntries(readMachineFlockRowsFromFlock(flock))).toEqual([
      [localProjectId, value],
    ]);
  });

  it('extracts ACP capability rows independently for configs sharing a provider', () => {
    const configId = 'config-1' as AgentConfigId;
    const secondConfigId = 'config-2' as AgentConfigId;
    const row = {
      key: machineFlockKeys.acpCapability(configId),
      value: {
        cliType: 'custom',
        agentType: 'agent',
        cacheVersion: 2,
        sourceVersion: 'v1',
        modes: [],
        models: [],
        fetchedAt: 1,
      },
    } as const;
    const secondRow = {
      key: machineFlockKeys.acpCapability(secondConfigId),
      value: { ...row.value, fetchedAt: 2 },
    } as const;

    expect(
      getMachineFlockAcpCapabilities({
        [serializeMachineFlockKey(row.key)]: row,
        [serializeMachineFlockKey(secondRow.key)]: secondRow,
      })
    ).toEqual({
      [getAcpCapabilityCacheKey(configId)]: row.value,
      [getAcpCapabilityCacheKey(secondConfigId)]: secondRow.value,
    });
  });

  it('extracts agent config rows', () => {
    const agentConfigId = 'config-1' as AgentConfigId;
    const row = {
      key: machineFlockKeys.agentConfig(agentConfigId),
      value: {
        id: agentConfigId,
        machineId: 'machine-1' as MachineId,
        name: 'Codex',
        cliType: 'builtin',
        agentType: 'codex',
        env: {},
        prompt: '',
      },
    } as const;

    expect(
      getMachineFlockAgentConfigs({
        [serializeMachineFlockKey(row.key)]: row,
      })
    ).toEqual({
      [agentConfigId]: row.value,
    });
  });

  it('rejects an agent config whose value id does not match its row key', () => {
    const flock = new FakeMachineFlock();
    flock.set(machineFlockKeys.agentConfig('trusted-config' as AgentConfigId), {
      id: 'different-config',
      machineId: 'machine-1',
      name: 'Mismatched provider',
      cliType: 'custom',
      agentType: 'custom-agent',
      customAcp: { command: '/tmp/untrusted-acp' },
      env: {},
    });

    expect(readMachineFlockRowsFromFlock(flock, { families: ['agentConfig'] })).toEqual({});
  });

  it('normalizes null optional fields in agent config rows', () => {
    const agentConfigId = 'config-null-optionals' as AgentConfigId;
    const row = {
      key: machineFlockKeys.agentConfig(agentConfigId),
      value: {
        id: agentConfigId,
        machineId: 'machine-1',
        name: 'Custom provider',
        description: null,
        cliType: 'custom',
        agentType: 'custom-agent',
        customAcp: {
          command: '/bin/cat',
        },
        env: {},
        prompt: '',
        runtimeOverrides: null,
        titleGeneration: null,
        brandId: null,
      },
    } as const;
    const flock = new FakeMachineFlock();
    flock.set(row.key, row.value);

    expect(readMachineFlockRowsFromFlock(flock)).toEqual({
      [serializeMachineFlockKey(row.key)]: {
        key: row.key,
        value: {
          id: agentConfigId,
          machineId: 'machine-1',
          name: 'Custom provider',
          cliType: 'custom',
          agentType: 'custom-agent',
          customAcp: {
            command: '/bin/cat',
          },
          env: {},
          prompt: '',
        },
      },
    });
  });

  it('normalizes null optional fields in other machine Flock rows', () => {
    const archiveSessionId = 'session-archive-null-optionals' as SessionId;
    const deleteSessionId = 'session-delete-null-optionals' as SessionId;
    const launchSessionId = 'session-launch-null-optionals' as SessionId;
    const localProjectId = 'project-null-optionals' as LocalProjectId;
    const flock = new FakeMachineFlock();

    flock.set(machineFlockKeys.archiveSessionCommand(archiveSessionId), {
      v: 1,
      requestedAt: 1,
      requestedBy: null,
    });
    flock.set(machineFlockKeys.deleteSessionCommand(deleteSessionId), {
      v: 1,
      requestedAt: 2,
      repoFullName: null,
      branchName: 'feature/null-optionals',
      baseBranchName: null,
      localProjectId: null,
      originalRootPath: null,
      isWorktree: null,
      keptWorktreePath: null,
    });
    flock.set(machineFlockKeys.localProject(localProjectId), {
      id: localProjectId,
      name: 'lody',
      rootPath: '/Users/developer/Code/lody',
      createdAtMs: 3,
      lastOpenedAtMs: null,
      history: null,
    });
    flock.set(machineFlockKeys.sessionLaunchConfig(launchSessionId), {
      customAcp: null,
      env: null,
      runtimeOverrides: null,
      worktreeSetup: {
        scripts: {
          bash: null,
          powershell: 'pnpm install',
        },
        timeoutMs: null,
      },
      worktreeCleanup: null,
    });

    expect(readMachineFlockRowsFromFlock(flock)).toEqual({
      [serializeMachineFlockKey(machineFlockKeys.archiveSessionCommand(archiveSessionId))]: {
        key: machineFlockKeys.archiveSessionCommand(archiveSessionId),
        value: {
          v: 1,
          requestedAt: 1,
        },
      },
      [serializeMachineFlockKey(machineFlockKeys.deleteSessionCommand(deleteSessionId))]: {
        key: machineFlockKeys.deleteSessionCommand(deleteSessionId),
        value: {
          v: 1,
          requestedAt: 2,
          branchName: 'feature/null-optionals',
        },
      },
      [serializeMachineFlockKey(machineFlockKeys.localProject(localProjectId))]: {
        key: machineFlockKeys.localProject(localProjectId),
        value: {
          id: localProjectId,
          name: 'lody',
          rootPath: '/Users/developer/Code/lody',
          createdAtMs: 3,
        },
      },
      [serializeMachineFlockKey(machineFlockKeys.sessionLaunchConfig(launchSessionId))]: {
        key: machineFlockKeys.sessionLaunchConfig(launchSessionId),
        value: {
          worktreeSetup: {
            scripts: {
              powershell: 'pnpm install',
            },
          },
        },
      },
    });
  });

  it('extracts rate limit rows', () => {
    const row = {
      key: machineFlockKeys.rateLimit('codex', 'codex_bengalfox'),
      value: {
        limitId: 'codex_bengalfox',
        used: 10,
        limit: 100,
      },
    } as const;

    expect(
      getMachineFlockRateLimits({
        [serializeMachineFlockKey(row.key)]: row,
      })
    ).toEqual({
      [getRateLimitEntryKey('codex', 'codex_bengalfox')]: row.value,
    });
  });

  describe('builtin agent opt-out rows', () => {
    const machineId = 'machine-1' as MachineId;

    it('round-trips a removal through the flock', () => {
      const flock = new FakeMachineFlock();
      const key = machineFlockKeys.builtinAgentOptOut('kimi');

      expect(
        writeMachineFlockRowToFlock(flock, {
          key,
          value: { v: 1, removedAt: 1700 },
        })
      ).toBe(true);

      expect(
        getMachineFlockBuiltinAgentOptOuts(
          readMachineFlockRowsFromFlock(flock, { families: ['builtinAgentOptOut'] })
        )
      ).toEqual(new Set(['kimi']));

      expect(deleteMachineFlockRowFromFlock(flock, key)).toBe(true);
      expect(
        getMachineFlockBuiltinAgentOptOuts(
          readMachineFlockRowsFromFlock(flock, { families: ['builtinAgentOptOut'] })
        )
      ).toEqual(new Set());
    });

    it('rejects a row whose key names a provider type outside startup auto-registration', () => {
      const flock = new FakeMachineFlock();

      // The provider type lives only in the key, so the key is the single thing
      // that can be wrong: a type the startup skip logic never checks must not be stored.
      expect(
        writeMachineFlockRowToFlock(flock, {
          key: ['builtinAgentOptOut', 'deepseek'],
          value: { v: 1, removedAt: 1700 },
        } as never)
      ).toBe(false);
    });

    const kimi = (id: string): AgentConfigMeta =>
      ({
        id: id as AgentConfigId,
        machineId,
        name: 'Kimi',
        cliType: 'builtin',
        agentType: 'kimi',
        env: {},
      }) as AgentConfigMeta;
    const optOuts = (flock: FakeMachineFlock) =>
      getMachineFlockBuiltinAgentOptOuts(
        readMachineFlockRowsFromFlock(flock, { families: ['builtinAgentOptOut'] })
      );

    it('deleting the last config of a type records the opt-out in one commit', () => {
      const flock = new FakeMachineFlock();
      writeAgentConfigToFlock(flock, kimi('a'));
      flock.commits = 0;

      expect(deleteAgentConfigFromFlock(flock, kimi('a'), 1700)).toBe(true);

      expect(flock.commits).toBe(1);
      expect(getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock))).toEqual({});
      expect(optOuts(flock)).toEqual(new Set(['kimi']));
    });

    it('deleting one of several configs of a type does not record an opt-out', () => {
      // One Kimi is left, so the user did not remove Kimi, startup adds nothing back and no
      // opt-out should be recorded.
      const flock = new FakeMachineFlock();
      writeAgentConfigToFlock(flock, kimi('a'));
      writeAgentConfigToFlock(flock, kimi('b'));

      deleteAgentConfigFromFlock(flock, kimi('a'), 1700);

      expect(optOuts(flock)).toEqual(new Set());
    });

    it('does not rewrite an existing opt-out on repeated deletes', () => {
      // The opt-out carries a timestamp, so a rewrite broadcasts a change to every peer; with
      // the row already gone and the opt-out already there, nothing must change.
      const flock = new FakeMachineFlock();
      deleteAgentConfigFromFlock(flock, kimi('a'), 1700);

      expect(deleteAgentConfigFromFlock(flock, kimi('a'), 1800)).toBe(false);
      expect(
        flock.rows.get(JSON.stringify(machineFlockKeys.builtinAgentOptOut('kimi')))?.value
      ).toMatchObject({ removedAt: 1700 });
    });

    it('writing a config of an opted-out type retracts the opt-out in the same commit', () => {
      const flock = new FakeMachineFlock();
      deleteAgentConfigFromFlock(flock, kimi('a'), 1700);
      flock.commits = 0;

      expect(writeAgentConfigToFlock(flock, kimi('b'))).toBe(true);

      expect(flock.commits).toBe(1);
      expect(optOuts(flock)).toEqual(new Set());
      expect(
        Object.keys(getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock)))
      ).toEqual(['b']);
    });

    it('rewriting an identical config is a no-op', () => {
      const flock = new FakeMachineFlock();
      writeAgentConfigToFlock(flock, kimi('a'));

      expect(writeAgentConfigToFlock(flock, kimi('a'))).toBe(false);
    });

    it('cancelling a published provider setup records the opt-out', () => {
      // Cancelling a published setup is also removing the provider; without the opt-out the CLI
      // adds it back on the next startup.
      const flock = new FakeMachineFlock();
      writeAgentConfigToFlock(flock, kimi('setup-1'));

      applyProviderSetupCancellationToFlock(flock, {
        v: 1,
        id: 'setup-1' as AgentConfigId,
        machineId,
        cancelledAt: 1700,
      });

      expect(getMachineFlockAgentConfigs(readMachineFlockRowsFromFlock(flock))).toEqual({});
      expect(optOuts(flock)).toEqual(new Set(['kimi']));
    });

    it('cancelling an unpublished provider setup records no opt-out', () => {
      // It was never published, so it was never in the list and there is nothing to remove.
      const flock = new FakeMachineFlock();
      applyProviderSetupCancellationToFlock(flock, {
        v: 1,
        id: 'setup-1' as AgentConfigId,
        machineId,
        cancelledAt: 1700,
      });

      expect(optOuts(flock)).toEqual(new Set());
    });

    it('rejects an agentType that has no managed runtime', () => {
      // deepseek is a builtin provider but stays outside startup auto-registration, so it must
      // have no opt-out record.
      expect(parseMachineFlockKey(['builtinAgentOptOut', 'deepseek'])).toBeUndefined();
      expect(parseMachineFlockKey(['builtinAgentOptOut', 'kimi'])).toEqual({
        kind: 'builtinAgentOptOut',
        key: machineFlockKeys.builtinAgentOptOut('kimi'),
        agentType: 'kimi',
      });
    });
  });
});
