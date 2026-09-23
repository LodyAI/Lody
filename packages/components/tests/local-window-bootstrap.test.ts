import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { LoroDoc } from 'loro-crdt';
import {
  createLocalWindowBootstrap,
  readSessionBootstrapSnapshot,
} from '../src/providers/local-window-bootstrap';

function channelFactory() {
  const channels = new Set<{ name: string; onmessage: BroadcastChannel['onmessage'] }>();
  const registry = new Map<string, Set<string>>();
  const createRegistry = (scope: string, id: string) => {
    const peers = registry.get(scope) ?? new Set<string>();
    registry.set(scope, peers);
    peers.add(id);
    return {
      peers: async () => [...peers].filter((peer) => peer !== id),
      close: () => {
        peers.delete(id);
      },
    };
  };
  const createChannel = (name: string) => {
    const channel = {
      name,
      onmessage: null as BroadcastChannel['onmessage'],
      postMessage(data: unknown) {
        for (const peer of channels) {
          if (peer !== channel && peer.name === name) {
            peer.onmessage?.call(
              peer as BroadcastChannel,
              { data: structuredClone(data) } as MessageEvent
            );
          }
        }
      },
      close() {
        channels.delete(channel);
      },
    };
    channels.add(channel);
    return channel;
  };
  return { createChannel, createRegistry };
}

afterEach(() => vi.useRealTimers());

describe('local window bootstrap', () => {
  it('reuses metadata and loaded history while merging independent edits', async () => {
    vi.useFakeTimers();
    const { createChannel, createRegistry } = channelFactory();
    const source = await LoroRepo.create({});
    const target = await LoroRepo.create({});
    const doc = new LoroDoc();
    doc.getText('history').insert(0, 'already loaded');
    doc.commit();
    await source.upsertDocMeta('session:test', { title: 'Existing conversation' });
    const owner = createLocalWindowBootstrap(
      source,
      'workspace',
      new Map([['session:test', doc]]),
      createChannel,
      createRegistry
    );
    const projected = new Promise<void>((resolve) => {
      const watch = target.watch((event) => {
        if (event.kind === 'doc-metadata') {
          watch.unsubscribe();
          resolve();
        }
      });
    });
    const empty = createLocalWindowBootstrap(
      target,
      'workspace',
      new Map(),
      createChannel,
      createRegistry
    );
    const receiver = createLocalWindowBootstrap(
      target,
      'workspace',
      new Map(),
      createChannel,
      createRegistry
    );
    await projected;
    expect((await target.getDocMeta('session:test'))?.meta).toMatchObject({
      title: 'Existing conversation',
    });
    const snapshot = await receiver.readDocument('session:test');
    const local = new LoroDoc();
    local.getMap('draft').set('text', 'unsent edit');
    local.commit();
    local.import(snapshot!);
    expect(local.getText('history').toString()).toBe('already loaded');
    expect(local.getMap('draft').get('text')).toBe('unsent edit');
    owner.close();
    empty.close();
    receiver.close();
    await source.destroy();
    await target.destroy();
  });

  it('isolates workspaces and resolves misses and pending requests on close', async () => {
    vi.useFakeTimers();
    const { createChannel, createRegistry } = channelFactory();
    const repo = await LoroRepo.create({});
    const doc = new LoroDoc();
    doc.getText('history').insert(0, 'private');
    doc.commit();
    const owner = createLocalWindowBootstrap(
      repo,
      'one',
      new Map([['session:test', doc]]),
      createChannel,
      createRegistry
    );
    const receiver = createLocalWindowBootstrap(
      repo,
      'two',
      new Map(),
      createChannel,
      createRegistry
    );
    const missing = receiver.readDocument('session:test');
    expect(await missing).toBeUndefined();
    const pending = receiver.readDocument('session:test');
    receiver.close();
    expect(await pending).toBeUndefined();
    expect(await receiver.readDocument('session:test')).toBeUndefined();
    owner.close();
    await repo.destroy();
  });

  it('falls through immediately when live peers do not own the requested document', async () => {
    vi.useFakeTimers();
    const { createChannel, createRegistry } = channelFactory();
    const repo = await LoroRepo.create({});
    const owner = createLocalWindowBootstrap(
      repo,
      'workspace',
      new Map(),
      createChannel,
      createRegistry
    );
    const receiver = createLocalWindowBootstrap(
      repo,
      'workspace',
      new Map(),
      createChannel,
      createRegistry
    );
    expect(await receiver.readDocument('session:missing')).toBeUndefined();
    owner.close();
    expect(await receiver.readDocument('session:closed-peer')).toBeUndefined();
    receiver.close();
    await repo.destroy();
  });

  it('uses the disk snapshot before peer state and tolerates disk failure', async () => {
    const disk = new Uint8Array([1]);
    const peer = new Uint8Array([2]);
    expect(
      await readSessionBootstrapSnapshot(
        async () => disk,
        async () => peer
      )
    ).toEqual(disk);
    expect(
      await readSessionBootstrapSnapshot(
        async () => {
          throw new Error('broken cache');
        },
        async () => peer
      )
    ).toEqual(peer);
    expect(
      await readSessionBootstrapSnapshot(
        async () => undefined,
        async () => undefined
      )
    ).toBeUndefined();
  });
});
