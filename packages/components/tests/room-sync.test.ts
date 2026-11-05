import { describe, expect, it, vi } from 'vitest';
import { waitForRoomToSync, type SyncRoomSubscription } from '../src/providers/room-sync';

const createSubscription = (
  firstSyncedWithRemote: Promise<void> = Promise.resolve()
): SyncRoomSubscription & { unsubscribe: ReturnType<typeof vi.fn> } => ({
  firstSyncedWithRemote,
  unsubscribe: vi.fn(),
});

describe('waitForRoomToSync', () => {
  it('keeps a returned room subscription when initial sync fails', async () => {
    const failedFirstSync = Promise.reject(new Error('bootstrap failed with status 404'));
    void failedFirstSync.catch(() => {});
    const badSub = createSubscription(failedFirstSync);
    const joinRoom = vi.fn().mockResolvedValueOnce(badSub);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();

    await expect(
      waitForRoomToSync(joinRoom, {
        roomId: 'session-1',
        sleep,
        warn,
      })
    ).rejects.toThrow('bootstrap failed with status 404');

    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(badSub.unsubscribe).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[session-1] initial room sync unavailable, continuing offline-first: bootstrap failed with status 404'
    );
  });
});

describe('waitForRoomToSync firstSynced selector', () => {
  it('gates on the selected binding promise, not the aggregate', async () => {
    // Dual-homed rooms must select one plane's first-sync promise: the
    // aggregate getter throws there, so the selector is the only legal gate.
    const bindingFirstSynced = Promise.resolve();
    const sub = {
      get firstSyncedWithRemote(): Promise<void> {
        throw new Error('aggregate first-sync must not be read on dual-homed rooms');
      },
      unsubscribe: () => undefined,
    };
    const result = await waitForRoomToSync(async () => sub, {
      roomId: 'room-selector',
      firstSynced: () => bindingFirstSynced,
    });
    expect(result).toBe(sub);
  });
});
