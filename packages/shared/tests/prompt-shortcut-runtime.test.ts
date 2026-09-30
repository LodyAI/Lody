import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { getShortcutBodyStreamId, type ShortcutResource } from '../src/prompt-shortcuts/access';
import {
  projectShortcutIndex,
  type PromptShortcutIndexEntry,
} from '../src/prompt-shortcuts/catalog';
import { PromptShortcutDocument } from '../src/prompt-shortcuts/document';
import { LocalShortcutStore } from '../src/prompt-shortcuts/local-store';
import type { PromptShortcut } from '../src/prompt-shortcuts/model';
import {
  PromptShortcutRuntime,
  type ShortcutPublicationPort,
} from '../src/prompt-shortcuts/runtime';

const workspaceId = 'workspace-a';
const userId = 'user-a';

function shortcut(id: string): PromptShortcut {
  return {
    v: 1,
    id,
    workspaceId,
    ownerUserId: userId,
    visibility: 'workspace',
    name: `Shortcut ${id}`,
    slug: id,
    prompt: `Prompt ${id}`,
    mentions: [],
    scope: {},
    revision: `revision-${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

function noopPublicationPort(acquire: ShortcutPublicationPort['acquire']): ShortcutPublicationPort {
  return {
    acquire,
    stage: vi.fn(async () => 'active'),
    activate: vi.fn(async () => {}),
    settle: vi.fn(async () => 'active'),
    revoke: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

async function createRuntime(
  values: readonly PromptShortcut[],
  acquire: ShortcutPublicationPort['acquire']
) {
  const repo = await LoroRepo.create({});
  const store = await LocalShortcutStore.open({ repo, workspaceId, userId });
  const entries = values.map((value) => projectShortcutIndex(value, `body-${value.id}`));
  await store.cacheDiscovery({
    entries,
    directory: entries.map((entry) => ({
      shortcutId: entry.id,
      bodyDocId: entry.bodyDocId,
      ownerUserId: entry.ownerUserId,
      visibility: entry.visibility,
      revision: entry.revision,
    })),
  });
  const runtime = new PromptShortcutRuntime(store, noopPublicationPort(acquire));
  return {
    entries,
    repo,
    runtime,
    async close() {
      await runtime.dispose();
      await repo.destroy();
    },
  };
}

async function saveBody(repo: LoroRepo, entry: PromptShortcutIndexEntry, value: PromptShortcut) {
  const docId = getShortcutBodyStreamId(entry.bodyDocId);
  const lease = await repo.acquireDoc(docId);
  try {
    new PromptShortcutDocument(lease.doc).save(value, []);
    await repo.persistDocNow(docId, lease.doc);
  } finally {
    await lease.release();
  }
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('PromptShortcutRuntime body warming', () => {
  it('coalesces a foreground read with the same in-flight body fetch', async () => {
    const value = shortcut('review');
    const gate = Promise.withResolvers<void>();
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    const acquire = vi.fn(async () => ({
      sync: async () => {
        await gate.promise;
        await saveBody(fixture.repo, fixture.entries[0]!, value);
      },
      join: async () => {},
      release: async () => {},
    }));
    fixture = await createRuntime([value], acquire);
    cleanups.push(fixture.close);

    const warm = fixture.runtime.prefetch(fixture.entries);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    const foreground = fixture.runtime.read(fixture.entries[0]!);
    gate.resolve();

    await expect(Promise.all([warm, foreground])).resolves.toEqual([undefined, value]);
    expect(acquire).toHaveBeenCalledTimes(1);
    await expect(fixture.runtime.read(fixture.entries[0]!)).resolves.toEqual(value);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('warms current bodies serially and continues after a failed body', async () => {
    const values = [shortcut('first'), shortcut('second'), shortcut('third')];
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    let active = 0;
    let maxActive = 0;
    let firstFailures = 1;
    const acquired: string[] = [];
    const acquire = vi.fn(async (resource: ShortcutResource) => {
      if (resource.kind !== 'body') throw new Error('Unexpected index acquisition');
      acquired.push(resource.bodyDocId);
      return {
        sync: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            await Promise.resolve();
            if (resource.bodyDocId === 'body-first' && firstFailures > 0) {
              firstFailures -= 1;
              throw new Error('offline');
            }
            const index = fixture.entries.find((entry) => entry.bodyDocId === resource.bodyDocId)!;
            const value = values.find((item) => item.id === index.id)!;
            await saveBody(fixture.repo, index, value);
          } finally {
            active -= 1;
          }
        },
        join: async () => {},
        release: async () => {},
      };
    });
    fixture = await createRuntime(values, acquire);
    cleanups.push(fixture.close);

    await expect(fixture.runtime.prefetch(fixture.entries)).resolves.toBeUndefined();
    expect(acquired).toEqual(['body-first', 'body-second', 'body-third']);
    expect(maxActive).toBe(1);

    await fixture.runtime.prefetch(fixture.entries);
    expect(acquired).toEqual(['body-first', 'body-second', 'body-third', 'body-first']);
    await fixture.runtime.prefetch(fixture.entries);
    expect(acquired).toHaveLength(4);
  });

  it('serializes overlapping prefetch batches', async () => {
    const values = [shortcut('old'), shortcut('new')];
    const firstGate = Promise.withResolvers<void>();
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    let active = 0;
    let maxActive = 0;
    const acquired: string[] = [];
    const acquire = vi.fn(async (resource: ShortcutResource) => {
      if (resource.kind !== 'body') throw new Error('Unexpected index acquisition');
      acquired.push(resource.bodyDocId);
      return {
        sync: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            if (resource.bodyDocId === 'body-old') await firstGate.promise;
            const index = fixture.entries.find((entry) => entry.bodyDocId === resource.bodyDocId)!;
            const value = values.find((item) => item.id === index.id)!;
            await saveBody(fixture.repo, index, value);
          } finally {
            active -= 1;
          }
        },
        join: async () => {},
        release: async () => {},
      };
    });
    fixture = await createRuntime(values, acquire);
    cleanups.push(fixture.close);

    const first = fixture.runtime.prefetch([fixture.entries[0]!]);
    await vi.waitFor(() => expect(acquired).toEqual(['body-old']));
    const second = fixture.runtime.prefetch([fixture.entries[1]!]);
    try {
      await Promise.resolve();
      expect(acquired).toEqual(['body-old']);
    } finally {
      firstGate.resolve();
    }

    await Promise.all([first, second]);
    expect(acquired).toEqual(['body-old', 'body-new']);
    expect(maxActive).toBe(1);
  });

  it('stops queued bodies when the prefetch scope is cancelled', async () => {
    const values = [shortcut('active'), shortcut('queued')];
    const activeGate = Promise.withResolvers<void>();
    let fixture!: Awaited<ReturnType<typeof createRuntime>>;
    const acquired: string[] = [];
    const acquire = vi.fn(async (resource: ShortcutResource) => {
      if (resource.kind !== 'body') throw new Error('Unexpected index acquisition');
      acquired.push(resource.bodyDocId);
      return {
        sync: async () => {
          if (resource.bodyDocId === 'body-active') await activeGate.promise;
          const index = fixture.entries.find((entry) => entry.bodyDocId === resource.bodyDocId)!;
          const value = values.find((item) => item.id === index.id)!;
          await saveBody(fixture.repo, index, value);
        },
        join: async () => {},
        release: async () => {},
      };
    });
    fixture = await createRuntime(values, acquire);
    cleanups.push(fixture.close);
    const controller = new AbortController();

    const warming = fixture.runtime.prefetch(fixture.entries, { signal: controller.signal });
    await vi.waitFor(() => expect(acquired).toEqual(['body-active']));
    controller.abort();
    activeGate.resolve();
    await warming;

    expect(acquired).toEqual(['body-active']);
  });
});
