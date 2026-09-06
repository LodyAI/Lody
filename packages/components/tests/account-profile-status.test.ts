import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { getAccountProfileStatusStore } from '../src/components/settings/account-profile-status';

type Response = Awaited<ReturnType<WorkspaceRuntime['requestAccountProfiles']>>;
const target = {
  workspaceId: 'workspace',
  machineId: 'machine',
  agentType: 'codex' as const,
  configId: 'config',
};
const success = (identity: string): Response => ({
  type: 'machine/account-profiles_response',
  machineId: 'machine',
  requestId: 'request',
  success: true,
  profiles: [
    {
      accountProfileId: 'system-default',
      label: 'System Default',
      status: 'authenticated',
      identity,
    },
  ],
});
const runtime = () => ({
  requestAccountProfiles: vi.fn<WorkspaceRuntime['requestAccountProfiles']>(async () =>
    success('first')
  ),
});
afterEach(() => vi.restoreAllMocks());

describe('shared account profile status', () => {
  it('shares concurrent requests and cached success until freshness expires', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const host = runtime();
    const first = getAccountProfileStatusStore(host, target);
    expect(getAccountProfileStatusStore(host, target)).toBe(first);
    await Promise.all([first.refresh(), first.refresh()]);
    expect(first.getSnapshot().profiles[0]?.identity).toBe('first');
    clock.mockReturnValue(30_999);
    await first.refresh();
    expect(host.requestAccountProfiles).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(31_000);
    host.requestAccountProfiles.mockResolvedValue(success('fresh'));
    await first.refresh();
    expect(first.getSnapshot().profiles[0]?.identity).toBe('fresh');
    expect(host.requestAccountProfiles).toHaveBeenCalledTimes(2);
  });

  it('isolates runtime, workspace, machine, provider and configuration', async () => {
    const host = runtime();
    const initial = getAccountProfileStatusStore(host, target);
    await initial.refresh();
    for (const change of [
      { workspaceId: 'other' },
      { machineId: 'other' },
      { agentType: 'claude' as const },
      { configId: 'other' },
    ]) {
      const other = getAccountProfileStatusStore(host, { ...target, ...change });
      expect(other).not.toBe(initial);
      expect(other.getSnapshot().profiles).toEqual([]);
    }
    expect(getAccountProfileStatusStore(runtime(), target).getSnapshot().profiles).toEqual([]);
  });

  it('does not cache failures as fresh and explicit refresh bypasses successful cache', async () => {
    const host = runtime();
    host.requestAccountProfiles.mockRejectedValueOnce(new Error('offline'));
    const store = getAccountProfileStatusStore(host, target);
    await store.refresh();
    expect(store.getSnapshot().error?.message).toBe('offline');
    await store.refresh();
    expect(store.getSnapshot().error).toBeNull();
    host.requestAccountProfiles.mockResolvedValue(success('retry'));
    await store.refresh({ force: true });
    expect(store.getSnapshot().profiles[0]?.identity).toBe('retry');
    expect(host.requestAccountProfiles).toHaveBeenCalledTimes(3);
  });

  it('discards a pre-mutation result and coalesces invalidation into one follow-up probe', async () => {
    const host = runtime();
    const old = Promise.withResolvers<Response>();
    host.requestAccountProfiles.mockImplementationOnce(() => old.promise);
    const store = getAccountProfileStatusStore(host, target);
    const snapshots: string[] = [];
    const unsubscribe = store.subscribe(() => {
      const identity = store.getSnapshot().profiles[0]?.identity;
      if (identity) snapshots.push(identity);
    });
    const pending = store.refresh();
    const firstInvalidation = store.refresh({ invalidate: true });
    const secondInvalidation = store.refresh({ invalidate: true });
    expect(firstInvalidation).toBe(secondInvalidation);
    host.requestAccountProfiles.mockResolvedValue(success('after-login'));
    old.resolve(success('before-login'));
    await Promise.all([pending, firstInvalidation, secondInvalidation]);
    expect(snapshots).toEqual(['after-login']);
    expect(host.requestAccountProfiles).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('bounds inactive scope history while retaining subscribed stores', async () => {
    const host = runtime();
    const active = getAccountProfileStatusStore(host, target);
    const unsubscribe = active.subscribe(() => {});
    const idle = getAccountProfileStatusStore(host, { ...target, configId: 'idle' });
    for (let index = 0; index < 40; index++) {
      getAccountProfileStatusStore(host, { ...target, configId: `config-${index}` });
    }
    expect(getAccountProfileStatusStore(host, target)).toBe(active);
    expect(getAccountProfileStatusStore(host, { ...target, configId: 'idle' })).not.toBe(idle);
    unsubscribe();
  });
});
