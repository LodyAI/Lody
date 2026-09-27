import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS,
  applyAcpCommandScopeDelta,
  type AcpCapabilityCacheEntry,
  type AcpCommandSummary,
  type AgentConfigId,
  type MachineFlockKey,
  type MachineFlockWritableFlock,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';
import { MachineDocument } from './doc';

class FakeMachineFlock implements MachineFlockWritableFlock {
  readonly rows = new Map<string, { key: MachineFlockKey; value: unknown }>();
  commits = 0;

  scan(options?: { prefix?: readonly unknown[] }) {
    return [...this.rows.values()].filter((row) =>
      options?.prefix ? options.prefix.every((part, index) => row.key[index] === part) : true
    );
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

afterEach(() => {
  vi.useRealTimers();
});

describe('MachineDocument ACP capabilities', () => {
  it('does not write or sync when only the fetch time changed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
    const flock = new FakeMachineFlock();
    const flush = vi.fn(async () => undefined);
    const syncOnce = vi.fn(async () => undefined);
    const markDirty = vi.fn();
    const repo = {
      openFlockDoc: vi.fn(async () => ({ flock, syncOnce })),
      flush,
    } as unknown as LoroRepo;
    const document = new MachineDocument(
      repo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId,
      markDirty
    );
    const write = () =>
      document.updateAcpCapabilities(
        'config-1' as AgentConfigId,
        'builtin',
        'codex',
        [{ id: 'agent', name: 'Agent' }],
        [{ modelId: 'gpt-5', name: 'GPT-5' }],
        undefined,
        [{ name: '/help', description: 'Help' }],
        false,
        'builtin:codex:test',
        undefined,
        true
      );

    const first = await write();
    vi.setSystemTime(new Date('2026-07-15T00:01:00.000Z'));
    const second = await write();

    expect(flock.commits).toBe(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(syncOnce).not.toHaveBeenCalled();
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect([...flock.rows.values()][0]?.value).toMatchObject({ acknowledgedSteer: true });
  });

  it('rewrites an unchanged entry only once it is old enough to need renewing', async () => {
    vi.useFakeTimers();
    const start = new Date('2026-07-15T00:00:00.000Z').getTime();
    vi.setSystemTime(start);
    const flock = new FakeMachineFlock();
    const markDirty = vi.fn();
    const repo = {
      openFlockDoc: vi.fn(async () => ({ flock, syncOnce: vi.fn(async () => undefined) })),
      flush: vi.fn(async () => undefined),
    } as unknown as LoroRepo;
    const document = new MachineDocument(
      repo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId,
      markDirty
    );
    const write = () =>
      document.updateAcpCapabilities(
        'config-1' as AgentConfigId,
        'registry',
        'opencode',
        [],
        [{ modelId: 'model-a', name: 'Model A' }],
        undefined,
        undefined,
        false,
        'opencode@1.0.0'
      );
    const storedFetchedAt = () =>
      ([...flock.rows.values()][0]?.value as { fetchedAt: number } | undefined)?.fetchedAt;

    await write();
    vi.setSystemTime(start + ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS - 1);
    await write();

    // Still young: identical content costs no Flock write, flush or sync.
    expect(flock.commits).toBe(1);
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(storedFetchedAt()).toBe(start);

    vi.setSystemTime(start + ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS);
    const renewed = await write();

    expect(flock.commits).toBe(2);
    expect(markDirty).toHaveBeenCalledTimes(2);
    expect(renewed.fetchedAt).toBe(start + ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS);
    expect(storedFetchedAt()).toBe(start + ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS);
  });

  it('persists a capability change that only updates per-model reasoning efforts', async () => {
    const flock = new FakeMachineFlock();
    const flush = vi.fn(async () => undefined);
    const markDirty = vi.fn();
    const repo = {
      openFlockDoc: vi.fn(async () => ({ flock, syncOnce: vi.fn(async () => undefined) })),
      flush,
    } as unknown as LoroRepo;
    const document = new MachineDocument(
      repo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId,
      markDirty
    );
    const write = (efforts: string[]) =>
      document.updateAcpCapabilities(
        'config-1' as AgentConfigId,
        'registry',
        'deepseek',
        [],
        [{ modelId: 'kimi-k3', name: 'Kimi K3' }],
        undefined,
        undefined,
        false,
        'registry:deepseek:test',
        { 'kimi-k3': efforts }
      );

    await write(['low', 'high']);
    const updated = await write(['low', 'high', 'max']);

    expect(flock.commits).toBe(2);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(markDirty).toHaveBeenCalledTimes(2);
    expect(updated.modelReasoningEfforts).toEqual({
      'kimi-k3': ['low', 'high', 'max'],
    });
  });

  it('persists title support changes even when all other capability fields are unchanged', async () => {
    const flock = new FakeMachineFlock();
    const repo = {
      openFlockDoc: async () => ({ flock, syncOnce: async () => {} }),
      flush: async () => {},
    } as unknown as LoroRepo;
    const document = new MachineDocument(
      repo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId,
      () => {}
    );
    const write = (sessionTitle: boolean) =>
      document.updateAcpCapabilities(
        'title-config' as AgentConfigId,
        'custom',
        'title-agent',
        [],
        [],
        undefined,
        undefined,
        false,
        'custom:test',
        undefined,
        false,
        undefined,
        { sessionTitle }
      );
    await write(false);
    await write(true);
    expect([...flock.rows.values()][0]?.value).toMatchObject({ sessionTitle: true });
    await write(false);
    expect([...flock.rows.values()][0]?.value).toMatchObject({ sessionTitle: false });
  });

  it('does not write capabilities when cancelled while opening the Machine Flock', async () => {
    const flock = new FakeMachineFlock();
    let markOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    let releaseOpen!: () => void;
    const openCanFinish = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const flush = vi.fn(async () => undefined);
    const repo = {
      openFlockDoc: vi.fn(async () => {
        markOpenStarted();
        await openCanFinish;
        return { flock, syncOnce: vi.fn(async () => undefined) };
      }),
      flush,
    } as unknown as LoroRepo;
    const document = new MachineDocument(
      repo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId,
      vi.fn()
    );
    const controller = new AbortController();

    const update = document.updateAcpCapabilities(
      'config-1' as AgentConfigId,
      'builtin',
      'codex',
      [{ id: 'agent', name: 'Agent' }],
      [{ modelId: 'gpt-5', name: 'GPT-5' }],
      undefined,
      undefined,
      false,
      'builtin:codex:test',
      undefined,
      false,
      undefined,
      { signal: controller.signal }
    );
    await openStarted;
    controller.abort();
    releaseOpen();

    await expect(update).rejects.toMatchObject({ name: 'AbortError' });
    expect(flock.commits).toBe(0);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('MachineDocument ACP command scopes', () => {
  const base: AcpCommandSummary[] = [
    { name: 'help', description: 'Help' },
    { name: 'review', description: 'Review' },
  ];
  const setup = () => {
    const flock = new FakeMachineFlock();
    const markDirty = vi.fn();
    const repo = {
      openFlockDoc: vi.fn(async () => ({ flock, syncOnce: vi.fn(async () => undefined) })),
      flush: vi.fn(async () => undefined),
    } as unknown as LoroRepo;
    const document = new MachineDocument(
      repo,
      'workspace-1' as WorkspaceId,
      'machine-1' as MachineId,
      markDirty
    );
    const write = (
      commands: AcpCommandSummary[] | undefined,
      options: {
        source?: 'probe' | 'session';
        commandScopeKey?: string;
        sourceVersion?: string;
      } = {}
    ) =>
      document.updateAcpCapabilities(
        'config-1' as AgentConfigId,
        'builtin',
        'claude',
        [],
        [{ modelId: 'opus', name: 'Opus' }],
        undefined,
        commands,
        false,
        options.sourceVersion ?? 'claude@1',
        undefined,
        false,
        undefined,
        { source: options.source, commandScopeKey: options.commandScopeKey }
      );
    const capabilityRow = () =>
      flock.rows.get(JSON.stringify(['acpCapability', 'config-1']))?.value as
        | AcpCapabilityCacheEntry
        | undefined;
    const scopeRow = (scopeKey: string) =>
      flock.rows.get(JSON.stringify(['acpCommandScope', 'config-1', scopeKey]))?.value as
        | Parameters<typeof applyAcpCommandScopeDelta>[2]
        | undefined;
    return { flock, markDirty, write, capabilityRow, scopeRow };
  };

  it('keeps the base list across projects and stores only each project difference', async () => {
    const { flock, write, capabilityRow, scopeRow } = setup();
    await write(base);
    const project1 = [...base, { name: 'p1-skill', description: 'Project one' }];
    const project2 = [base[0]!, { name: 'p2-skill', description: 'Project two' }];

    await write(project1, { source: 'session', commandScopeKey: 'local:p1' });
    await write(project2, { source: 'session', commandScopeKey: 'local:p2' });
    const commitsAfterBothProjects = flock.commits;
    await write(project1, { source: 'session', commandScopeKey: 'local:p1' });

    // Alternating projects never rewrites the large per-config row.
    expect(capabilityRow()?.availableCommands).toEqual(base);
    expect(flock.commits).toBe(commitsAfterBothProjects);
    expect(flock.commits).toBe(3);
    for (const [scopeKey, commands] of [
      ['local:p1', project1],
      ['local:p2', project2],
    ] as const) {
      const merged = applyAcpCommandScopeDelta(
        base,
        capabilityRow()?.sourceVersion,
        scopeRow(scopeKey)
      );
      expect(new Set(merged.map((command) => command.name))).toEqual(
        new Set(commands.map((command) => command.name))
      );
    }
  });

  it('drops a project difference once its commands match the base again', async () => {
    const { write, scopeRow } = setup();
    await write(base);
    await write([...base, { name: 'extra' }], { source: 'session', commandScopeKey: 'local:p1' });
    expect(scopeRow('local:p1')).toBeDefined();

    await write(base, { source: 'session', commandScopeKey: 'local:p1' });

    expect(scopeRow('local:p1')).toBeUndefined();
  });

  it('leaves the project difference in place when a session reports no commands', async () => {
    const { write, scopeRow } = setup();
    await write(base);
    await write([...base, { name: 'extra' }], { source: 'session', commandScopeKey: 'local:p1' });

    await write(undefined, { source: 'session', commandScopeKey: 'local:p1' });

    expect(scopeRow('local:p1')?.added).toEqual([{ name: 'extra' }]);
  });

  it('lets a session seed the base when none exists for its source version', async () => {
    const { write, capabilityRow, scopeRow } = setup();
    await write(base, { sourceVersion: 'claude@1' });
    const upgraded = [...base, { name: 'new-builtin' }];

    await write(upgraded, {
      source: 'session',
      commandScopeKey: 'local:p1',
      sourceVersion: 'claude@2',
    });

    expect(capabilityRow()?.availableCommands).toEqual(upgraded);
    expect(scopeRow('local:p1')).toBeUndefined();
  });

  it('replaces the base when a probe reports a different list', async () => {
    const { write, capabilityRow } = setup();
    await write(base);
    const changed = [...base, { name: 'user-skill' }];

    await write(changed, { source: 'probe' });

    expect(capabilityRow()?.availableCommands).toEqual(changed);
  });
});
