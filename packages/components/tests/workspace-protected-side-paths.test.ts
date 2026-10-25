import { afterEach, expect, it, vi } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { PromptShortcutSync } from '@lody/shared/prompt-shortcuts/sync';
import { WorkspaceStreamsConfigurationError } from '@lody/shared/workspace-streams-content';
import { createEagerSyncWorkerClient } from '../src/providers/eager-sync-worker-client';
import { runEagerSyncWorkerTask } from '../src/providers/eager-sync-worker-task';

afterEach(() => vi.unstubAllGlobals());
it('protected prefetch and shortcuts refuse before network, auth or local cache work', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => { requests.push(url); throw new Error('unexpected network'); });
  const unwanted: string[] = [];
  const fail = (name: string): never => { unwanted.push(name); throw new Error(name); };
  const client = createEagerSyncWorkerClient({
    content: { mode: 'protected' }, workspaceId: 'workspace', scope: 'scope',
    resolveTransport: async () => fail('transport'), auth: async () => fail('auth'),
    localConnection: () => fail('connection'), createWorker: () => fail('worker'),
    readSnapshot: async () => fail('cache'),
  });
  try {
    await expect(client.prefetch('document', 1, new AbortController().signal)).resolves.toBe('failed');
    await expect(runEagerSyncWorkerTask({ type: 'start', content: { mode: 'protected' } } as Parameters<typeof runEagerSyncWorkerTask>[0], {
      connection: { send: () => fail('send'), onMessage: () => fail('subscribe'), onStatusChange: () => fail('status'), isConnected: () => false },
      auth: async () => fail('auth'), readSnapshot: async () => fail('cache'),
    })).rejects.toBeInstanceOf(WorkspaceStreamsConfigurationError);
    const repo = await LoroRepo.create({});
    try {
      const shortcuts = new PromptShortcutSync({ content: { mode: 'protected' }, repo, grant: async () => fail('grant'), now: () => 0 });
      await expect(shortcuts.acquire({ kind: 'body', bodyDocId: 'synthetic-body' }, true)).rejects.toBeInstanceOf(WorkspaceStreamsConfigurationError);
    } finally { await repo.destroy(); }
    expect(requests).toEqual([]);
    expect(unwanted).toEqual([]);
  } finally { client.dispose(); }
});
