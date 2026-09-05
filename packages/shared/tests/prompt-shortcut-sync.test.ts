import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo, ResourceBusyError } from 'loro-repo';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import {
  PromptShortcutSync,
  readonlyShortcutAdapter,
  type ShortcutStreamGrant,
} from '../src/prompt-shortcuts/sync';

const grant: ShortcutStreamGrant = {
  streamId: 'shortcut-body:body',
  token: 'synthetic-token',
  expiresIn: 900,
  gatewayBaseUrl: 'https://streams.example.test',
};
const resource = { kind: 'body' as const, bodyDocId: 'body' };

describe('shortcut scoped sync', () => {
  it('imports remote content but cannot export or subscribe local edits with a read-only adapter', async () => {
    const remote = new LoroDoc();
    remote.getText('text').insert(0, 'Remote content');
    remote.commit();
    const local = new LoroDoc();
    const adapter = readonlyShortcutAdapter(createLoroDocAdapter(local));
    await adapter.applySnapshot(remote.export({ mode: 'snapshot' }));
    expect(local.getText('text').toString()).toBe('Remote content');
    let localEvents = 0;
    const unsubscribe = adapter.subscribeLocalUpdates(() => localEvents++);
    local.getText('text').insert(0, 'Local change');
    local.commit();
    expect(adapter.exportUpdates(adapter.emptyVersion())).toBeNull();
    expect(localEvents).toBe(0);
    unsubscribe();
  });

  it('holds one ref-counted replica until the last consumer releases it', async () => {
    const repo = await LoroRepo.create({});
    const sync = new PromptShortcutSync({ repo, now: () => 0, grant: async () => grant });
    try {
      const first = await sync.acquire(resource, false);
      const second = await sync.acquire(resource, false);
      await expect(repo.unloadDoc(grant.streamId)).rejects.toBeInstanceOf(ResourceBusyError);
      await first.release();
      await expect(repo.unloadDoc(grant.streamId)).rejects.toBeInstanceOf(ResourceBusyError);
      await second.release();
      await expect(repo.unloadDoc(grant.streamId)).resolves.toBeUndefined();
      await second.release();
    } finally {
      await sync.dispose();
      await repo.destroy();
    }
  });

  it('refuses grant redirection and incompatible concurrent access modes', async () => {
    const repo = await LoroRepo.create({});
    const wrong = new PromptShortcutSync({
      repo,
      now: () => 0,
      grant: async () => ({ ...grant, streamId: 'shortcut-body:other' }),
    });
    const correct = new PromptShortcutSync({ repo, now: () => 0, grant: async () => grant });
    try {
      await expect(wrong.acquire(resource, false)).rejects.toMatchObject({ code: 'forbidden' });
      const reader = await correct.acquire(resource, false);
      await expect(correct.acquire(resource, true)).rejects.toMatchObject({ code: 'forbidden' });
      await reader.release();
      const writer = await correct.acquire(resource, true);
      await writer.release();
    } finally {
      await wrong.dispose();
      await correct.dispose();
      await repo.destroy();
    }
  });

  it('releases a late-opening room when disposed during authorization', async () => {
    const repo = await LoroRepo.create({});
    let authorize!: (value: ShortcutStreamGrant) => void;
    const pending = new Promise<ShortcutStreamGrant>((resolve) => {
      authorize = resolve;
    });
    const sync = new PromptShortcutSync({ repo, now: () => 0, grant: () => pending });
    const acquiring = sync.acquire(resource, false);
    const disposing = sync.dispose();
    const rejected = expect(acquiring).rejects.toThrow('disposed');
    authorize(grant);
    await rejected;
    await disposing;
    await expect(repo.unloadDoc(grant.streamId)).resolves.toBeUndefined();
    await repo.destroy();
  });
});
