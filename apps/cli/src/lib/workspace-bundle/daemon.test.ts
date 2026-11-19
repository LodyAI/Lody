import { describe, expect, it } from 'vitest';
import { daemonBundleWorkspace } from './daemon';

describe('daemonBundleWorkspace', () => {
  it('syncs rooms through the manager only when the workspace has a remote', async () => {
    const calls: string[] = [];
    const manager = {
      repo: {} as never,
      syncMetaOrThrow: async (options: { reason?: string }) =>
        void calls.push(`meta:${options.reason}`),
      syncDocOrThrow: async (id: string) => void calls.push(`doc:${id}`),
      syncFlockDocOrThrow: async (id: string) => void calls.push(`flock:${id}`),
      getSessionHistorySnapshot: async (id: string) => [{ id: `turn-of-${id}` }],
    };
    const synced = daemonBundleWorkspace('ws', manager, { sync: true });
    await synced.syncRoom?.('meta', 'meta');
    await synced.syncRoom?.('session-1', 'loro');
    await synced.syncRoom?.('ws:sr', 'flock');
    expect(calls).toEqual(['meta:workspace-bundle', 'doc:session-1', 'flock:ws:sr']);
    expect(daemonBundleWorkspace('ws', manager, { sync: false }).syncRoom).toBeUndefined();
    expect(await synced.readRoostHistory?.('s1')).toEqual([{ id: 'turn-of-s1' }]);
  });
});
