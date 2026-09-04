import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
