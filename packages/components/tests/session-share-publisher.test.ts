import { it, expect, vi } from 'vitest';
import { decodeShareHistoryBytes } from '@lody/shared/session-sharing';
import { captureSessionShare } from '../src/lib/session-share-publisher';
vi.mock('@/lib', () => ({ API_BASE_URL: 'https://api.example.test' }));

it('acquires sources concurrently but preserves selected order and releases all leases', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const released: string[] = [],
    syncReleased: string[] = [];
  let acquired = 0;
  const runtime = {
    workspaceId: 'workspace',
    prepareSessionTarget: async () => {},
    acquireSessionStore: async (id: string) => {
      acquired++;
      if (acquired === 4) release();
      // The first finishes after the others, reproducing completion-order bugs.
      if (id === 's0') await ready;
      return {
        sessionId: id,
        firstSynced: Promise.resolve(),
        acquireSync: () => () => syncReleased.push(id),
        sessionData: {
          history: {
            readAll: async () => [
              { id: 't', role: 'assistant', items: [{ type: 'text', text: id.repeat(1000) }] },
            ],
          },
        },
      };
    },
    releaseSessionStoreRef: (id: string) => released.push(id),
  };
  const result = await captureSessionShare({
    runtime,
    sessions: Array.from({ length: 4 }, (_, i) => ({
      id: `s${i}`,
      title: `Title ${i}`,
      machineId: 'machine',
    })),
    rootSessionId: 's0',
    token: 'test',
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof captureSessionShare>[0]);
  for (const [i, conversation] of result.manifest.conversations.entries()) {
    expect(conversation.title).toBe(`Title ${i}`);
    const descriptor = result.manifest.objects.find((o) => o.id === conversation.historyObjectId)!;
    const bytes = decodeShareHistoryBytes(result.objects.get(descriptor.id)!, descriptor);
    expect(JSON.parse(new TextDecoder().decode(bytes))[0].items[0].text).toBe(`s${i}`.repeat(1000));
  }
  expect(released.sort()).toEqual(['s0', 's1', 's2', 's3']);
  expect(syncReleased.sort()).toEqual(released);
});

it('drains acquisitions after a sibling fails before releasing their source references', async () => {
  let fail!: () => void;
  const failure = new Promise<never>((_, reject) => {
    fail = () => reject(new Error('Source unavailable'));
  });
  const held = new Set<string>();
  let started = 0;
  const runtime = {
    prepareSessionTarget: async () => {},
    acquireSessionStore: async (id: string) => {
      if (++started === 4) fail();
      if (id === 's0') return failure;
      await Promise.resolve();
      held.add(id);
      return { sessionId: id, acquireSync: () => () => {}, firstSynced: Promise.resolve() };
    },
    releaseSessionStoreRef: (id: string) => held.delete(id),
  };
  await expect(
    captureSessionShare({
      runtime,
      sessions: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}` })),
      rootSessionId: 's0',
      token: 'test',
      signal: new AbortController().signal,
    } as unknown as Parameters<typeof captureSessionShare>[0])
  ).rejects.toThrow('Source unavailable');
  expect(started).toBe(4);
  expect(held.size).toBe(0);
});
