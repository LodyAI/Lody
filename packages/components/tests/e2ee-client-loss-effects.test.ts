import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientLossEffects } from '../src/lib/e2ee-client-loss-effects';

type Report = { workspaceId: string; effects: Record<string, number | boolean> };

const install = () => {
  const reports: Report[] = [];
  vi.stubGlobal('window', {
    __LODY_E2E_CLIENT_LOSS__: true,
    ipc: {
      send: (channel: string, payload: Report) => {
        expect(channel).toBe('e2ee.clientLossEffects');
        reports.push(structuredClone(payload));
      },
    },
  });
  return reports;
};
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

afterEach(() => vi.unstubAllGlobals());

describe('E2E client-loss transport effects', () => {
  it('does nothing outside a window whose main registered the probe', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('window', { ipc: { send: (...args: unknown[]) => sent.push(args) } });
    expect(clientLossEffects('workspace-off')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('counts completed protected writes and reads, appended dispatches, and live pending work', async () => {
    const reports = install();
    const effects = clientLossEffects('workspace-counts')!;
    const write = deferred<string>();
    const running = effects.track('write', () => write.promise);
    expect(reports.at(-1)).toEqual({
      workspaceId: 'workspace-counts',
      effects: {
        contentWrites: 0,
        contentReadEvents: 0,
        turnStarts: 0,
        activeContentStreams: 0,
        pendingWrites: 1,
        pendingDispatches: 0,
        // Work still in flight is never reported as a closed, drained owner.
        transportOwnerClosed: false,
      },
    });
    write.resolve('frame');
    await expect(running).resolves.toBe('frame');
    await expect(effects.track('write', () => Promise.reject(new Error('closed')))).rejects.toThrow(
      'closed'
    );
    await effects.track('read', async () => 'plain');
    const dispatch = deferred<null>();
    const sending = effects.track('dispatch', () => dispatch.promise);
    expect(reports.at(-1)?.effects.pendingDispatches).toBe(1);
    // A settled send is not a turn: only an appended dispatch frame counts.
    dispatch.resolve(null);
    await sending;
    expect(reports.at(-1)?.effects.turnStarts).toBe(0);
    effects.turnDispatched();
    expect(reports.at(-1)?.effects).toMatchObject({
      contentWrites: 1,
      contentReadEvents: 1,
      turnStarts: 1,
      pendingWrites: 0,
      pendingDispatches: 0,
    });
  });

  it('reports the transport owner closed only after every stream is removed and close succeeded', () => {
    const reports = install();
    const effects = clientLossEffects('workspace-owner')!;
    effects.ownerOpened();
    effects.streamAttached();
    expect(reports.at(-1)?.effects).toMatchObject({
      activeContentStreams: 1,
      transportOwnerClosed: false,
    });
    // A removal failure keeps the stream counted, so close cannot prove a drain.
    effects.streamRemoved(false);
    effects.ownerClosed(true);
    expect(reports.at(-1)?.effects).toMatchObject({
      activeContentStreams: 1,
      transportOwnerClosed: false,
    });
    effects.streamRemoved(true);
    expect(reports.at(-1)?.effects.transportOwnerClosed).toBe(true);

    const failed = clientLossEffects('workspace-failed')!;
    failed.ownerOpened();
    failed.ownerClosed(false);
    expect(reports.at(-1)).toMatchObject({
      workspaceId: 'workspace-failed',
      effects: { transportOwnerClosed: false },
    });
  });

  it('keeps cumulative counters per workspace across runtime instances', async () => {
    const reports = install();
    await clientLossEffects('workspace-shared')!.track('read', async () => 1);
    await clientLossEffects('workspace-shared')!.track('read', async () => 2);
    expect(reports.at(-1)?.effects.contentReadEvents).toBe(2);
  });
});
