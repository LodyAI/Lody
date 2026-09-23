import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { LoroDoc } from 'loro-crdt';
import {
  createLocalWindowBootstrap,
  firstAvailableSnapshot,
} from '../src/providers/local-window-bootstrap';

function channelFactory() {
  const channels = new Set<{ name: string; onmessage: BroadcastChannel['onmessage'] }>();
  return (name: string) => {
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
}

afterEach(() => vi.useRealTimers());

describe('local window bootstrap', () => {
  it('reuses metadata and loaded history while merging independent edits', async () => {
    vi.useFakeTimers();
    const createChannel = channelFactory();
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
      createChannel
    );
    const projected = new Promise<void>((resolve) => {
      const watch = target.watch((event) => {
        if (event.kind === 'doc-metadata') {
          watch.unsubscribe();
          resolve();
        }
      });
    });
    const receiver = createLocalWindowBootstrap(target, 'workspace', new Map(), createChannel);
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
    receiver.close();
    await source.destroy();
    await target.destroy();
  });

  it('isolates workspaces and resolves misses and pending requests on close', async () => {
    vi.useFakeTimers();
    const createChannel = channelFactory();
    const repo = await LoroRepo.create({});
    const doc = new LoroDoc();
    doc.getText('history').insert(0, 'private');
    doc.commit();
    const owner = createLocalWindowBootstrap(
      repo,
      'one',
      new Map([['session:test', doc]]),
      createChannel
    );
    const receiver = createLocalWindowBootstrap(repo, 'two', new Map(), createChannel);
    const missing = receiver.readDocument('session:test');
    await vi.advanceTimersByTimeAsync(150);
    expect(await missing).toBeUndefined();
    const pending = receiver.readDocument('session:test');
    receiver.close();
    expect(await pending).toBeUndefined();
    expect(await receiver.readDocument('session:test')).toBeUndefined();
    owner.close();
    await repo.destroy();
  });

  it('does not wait for a slow disk cache or let a cache miss discard peer state', async () => {
    const snapshot = new Uint8Array([1, 2, 3]);
    expect(
      await firstAvailableSnapshot([new Promise(() => {}), Promise.resolve(snapshot)])
    ).toEqual(snapshot);
    expect(
      await firstAvailableSnapshot([Promise.resolve(undefined), Promise.resolve(snapshot)])
    ).toEqual(snapshot);
    expect(
      await firstAvailableSnapshot([
        Promise.resolve(undefined),
        Promise.reject(new Error('cache unavailable')),
      ])
    ).toBeUndefined();
  });
});
