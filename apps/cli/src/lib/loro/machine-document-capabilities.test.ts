import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACP_CAPABILITY_FETCH_TIME_RENEW_AFTER_MS,
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

  it("stores each model's declared controls in its own row, writing only on change", async () => {
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
      modelCapabilities?: Record<string, { effortValues?: string[]; fastMode?: boolean }>
    ) =>
      document.updateAcpCapabilities(
        'config-1' as AgentConfigId,
        'builtin',
        'codex',
        [],
        [{ modelId: 'gpt-6', name: 'GPT-6' }],
        undefined,
        undefined,
        false,
        'codex@1',
        undefined,
        false,
        undefined,
        { modelCapabilities }
      );
    const modelRow = () =>
      flock.rows.get(JSON.stringify(['acpModelCapability', 'config-1']))?.value;
    const declared = { 'gpt-6': { effortValues: ['low', 'ultra'], fastMode: true } };

    await write(declared);
    await write(declared);
    expect(flock.commits).toBe(2);
    expect(markDirty).toHaveBeenCalledTimes(1);
    expect(modelRow()).toEqual({ version: 1, sourceVersion: 'codex@1', models: declared });

    // Only the declaration changed: one write, to the per-model row.
    const changed = { 'gpt-6': { effortValues: ['low'], fastMode: false } };
    await write(changed);
    expect(flock.commits).toBe(3);
    expect(modelRow()).toMatchObject({ models: changed });

    // A response without a declaration leaves the stored one alone.
    await write(undefined);
    expect(flock.commits).toBe(3);
    expect(modelRow()).toMatchObject({ models: changed });
  });
});
