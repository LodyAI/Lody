import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { LoroRepo } from 'loro-repo';
import { StreamsTransportAdapter } from 'loro-repo/transport/streams';
import type {
  RepoTransportRoomSubscription,
  TransportRoomStatus,
  TransportSubscription,
  RepoRoomSubscription,
} from 'loro-repo';
import { createConversationSync, observeConversationDocument } from '../src/lib/conversation-sync';
import { createRoomSyncTracker } from '../src/providers/room-sync-tracker';
import { readinessBinding } from '../src/lib/room-readiness';
import { waitForRoomToSync, type SyncRoomSubscription } from '../src/providers/room-sync';

describe('room-sync-tracker', () => {
  function createSubscription(statuses: TransportRoomStatus[]): TransportSubscription {
    let status = statuses[0] ?? 'connecting';
    return {
      unsubscribe: () => undefined,
      firstSyncedWithRemote: Promise.resolve(),
      waitUntilSynced: async () => undefined,
      get status() {
        return status;
      },
      onStatusChange: (listener) => {
        for (const nextStatus of statuses) {
          status = nextStatus;
          listener(nextStatus);
        }
        return () => undefined;
      },
    };
  }

  function createDeferred() {
    let resolve: (() => void) | undefined;
    let reject: ((error?: unknown) => void) | undefined;
    const promise = new Promise<void>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    if (!resolve || !reject) {
      throw new Error('Failed to create deferred promise');
    }
    return { promise, resolve, reject };
  }

  function createControlledSubscription(initialStatus: TransportRoomStatus): {
    sub: TransportSubscription;
    emit: (status: TransportRoomStatus) => void;
    setFirstSyncedWithRemote: (promise: Promise<void>) => void;
  } {
    let status = initialStatus;
    let firstSyncedWithRemote = Promise.resolve();
    const listeners = new Set<(status: TransportRoomStatus) => void>();
    return {
      sub: {
        unsubscribe: () => undefined,
        get firstSyncedWithRemote() {
          return firstSyncedWithRemote;
        },
        waitUntilSynced: () => firstSyncedWithRemote,
        get status() {
          return status;
        },
        onStatusChange: (listener) => {
          listeners.add(listener);
          listener(status);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      emit: (nextStatus) => {
        status = nextStatus;
        for (const listener of Array.from(listeners)) {
          listener(nextStatus);
        }
      },
      setFirstSyncedWithRemote: (promise) => {
        firstSyncedWithRemote = promise;
      },
    };
  }

  describe('createRoomSyncTracker', () => {
    it('treats a detached binding as idle, never reconnectable', () => {
      // 'detached' means the transport is deliberately absent (signed out, route
      // pending) — the reconnect loop must not spin on it, and the room must not
      // read as broken.
      const controlled = createControlledSubscription('joined');
      const tracker = createRoomSyncTracker('room-detached');
      tracker.attach(controlled.sub);
      controlled.emit('detached' as TransportRoomStatus);
      expect(tracker.getSyncState()).toBe('idle');
      expect(tracker.needsReconnect()).toBe(false);
      // Even a failed first sync must not make a detached room reconnectable.
      tracker.markFirstSyncFailed();
      expect(tracker.needsReconnect()).toBe(false);
      // Re-attach after the transport returns resumes normal tracking.
      controlled.emit('joined');
      tracker.markFirstSynced();
      expect(tracker.getSyncState()).toBe('synced');
    });

    it('rechecks first sync after reconnecting from an initial sync failure', async () => {
      const tracker = createRoomSyncTracker('room-1');
      const subscription = createControlledSubscription('joined');
      tracker.attach(subscription.sub);
      tracker.markFirstSyncFailed();

      expect(tracker.getSyncState()).toBe('error');
      expect(tracker.needsReconnect()).toBe(true);

      const recovered = createDeferred();
      subscription.setFirstSyncedWithRemote(recovered.promise);
      subscription.emit('reconnecting');
      expect(tracker.getSyncState()).toBe('reconnecting');
      expect(tracker.needsReconnect()).toBe(false);

      subscription.emit('joined');
      expect(tracker.getSyncState()).toBe('syncing');
      expect(tracker.needsReconnect()).toBe(false);

      recovered.resolve();
      await recovered.promise;
      await Promise.resolve();

      expect(tracker.getSyncState()).toBe('synced');
      expect(tracker.needsReconnect()).toBe(false);
    });

    it('keeps a recovered join reconnectable when first sync still fails', async () => {
      const tracker = createRoomSyncTracker('room-1');
      const subscription = createControlledSubscription('joined');
      tracker.attach(subscription.sub);
      tracker.markFirstSyncFailed();

      const failed = createDeferred();
      subscription.setFirstSyncedWithRemote(failed.promise);
      subscription.emit('reconnecting');
      subscription.emit('joined');
      expect(tracker.getSyncState()).toBe('syncing');

      failed.reject(new Error('still unavailable'));
      await failed.promise.catch(() => undefined);
      await Promise.resolve();

      expect(tracker.getSyncState()).toBe('error');
      expect(tracker.needsReconnect()).toBe(true);
    });
  });
});

describe('room-readiness', () => {
  const makeSub = (transportIds: string[]): RepoRoomSubscription => {
    const bindings = new Map<string, { transportId: string }>();
    const subscription = (transportId: string) => {
      let binding = bindings.get(transportId);
      if (!binding) {
        binding = { transportId };
        bindings.set(transportId, binding);
      }
      return binding;
    };
    return {
      transportIds: () => transportIds,
      subscription,
      subscriptions: () => transportIds.map(subscription),
    } as unknown as RepoRoomSubscription;
  };

  describe('readinessBinding', () => {
    it('prefers the local plane on dual-homed rooms', () => {
      expect(readinessBinding(makeSub(['local', 'cloud'])).transportId).toBe('local');
    });

    it('falls back to cloud for multi-transport routes without local', () => {
      expect(readinessBinding(makeSub(['a', 'cloud'])).transportId).toBe('cloud');
    });
  });
});

describe('room-sync', () => {
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
});

describe('conversation sync while receiving Roost history', () => {
  it('keeps the wait time across both paths and ignores completion from the previous connection', async () => {
    let now = 100;
    const sync = createConversationSync(true, () => now);
    type Binding = Parameters<typeof observeConversationDocument>[0];
    type Status = Binding['status'];
    type Result = Awaited<ReturnType<RepoTransportRoomSubscription['waitFor']>>;
    const reads = [
      Promise.withResolvers<Result>(),
      Promise.withResolvers<Result>(),
      Promise.withResolvers<Result>(),
    ];
    let status: Status = 'joined';
    let receive: ((status: Status) => void) | undefined;
    const waitFor = vi
      .fn<Binding['waitFor']>()
      .mockImplementationOnce(() => reads[0].promise)
      .mockImplementationOnce(() => reads[1].promise)
      .mockImplementationOnce(() => reads[2].promise);
    const stop = observeConversationDocument(
      {
        transportId: 'cloud',
        get status() {
          return status;
        },
        onStatusChange: (listener) => {
          receive = listener;
          return () => {
            receive = undefined;
          };
        },
        waitFor,
      },
      (step) => sync.update('document', step)
    );
    const move = (phase: Status) => {
      status = phase;
      receive?.(phase);
    };
    const result = (status: Result['status'], generation: number): Result => ({
      status,
      phase: 'caught-up',
      generation,
    });

    sync.update('history', { route: 'cloud', phase: 'retrying', reason: 'timeout' });
    reads[0].resolve(result('timeout', 1));
    await reads[0].promise;
    expect(sync.getSnapshot()).toMatchObject({
      since: 100,
      phase: 'retrying',
      document: { phase: 'syncing', reason: 'timeout' },
      history: { phase: 'retrying', reason: 'timeout' },
    });

    now = 200;
    move('reconnecting');
    move('joined');
    sync.update('history', { phase: 'confirmed' });
    reads[1].resolve(result('complete', 1));
    await reads[1].promise;
    expect(sync.getSnapshot()).toMatchObject({ phase: 'syncing', since: 100 });

    reads[2].resolve(result('complete', 2));
    await reads[2].promise;
    expect(sync.getSnapshot()).toMatchObject({ phase: 'confirmed' });
    now = 300;
    move('disconnected');
    expect(sync.getSnapshot()).toMatchObject({ phase: 'disconnected', since: 300 });
    stop();
  });
});

it('requires a new applied Streams tail after waking and while the live read is behind', async () => {
  const head = '00000000000000000000';
  const doc = new LoroDoc();
  const first = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const second = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  let opened = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith('/bootstrap')) {
      return new Response('--p\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--p--\r\n', {
        headers: {
          'content-type': 'multipart/mixed; boundary=p',
          'stream-snapshot-offset': '-1',
          'stream-next-offset': head,
          'stream-up-to-date': 'true',
        },
      });
    }
    const wire = new ReadableStream<Uint8Array>({
      start(controller) {
        request.signal.addEventListener('abort', () => controller.error(request.signal.reason), {
          once: true,
        });
        (opened ? second : first).resolve(controller);
        opened = true;
      },
    });
    return new Response(wire, {
      headers: { 'content-type': 'text/event-stream', 'stream-sse-data-encoding': 'base64' },
    });
  });
  const repo = await LoroRepo.create({});
  const transport = new StreamsTransportAdapter({
    bucketId: 'test',
    baseUrl: 'https://streams.invalid',
    auth: () => 'synthetic',
    createStreamIfMissing: false,
  });
  try {
    await repo.addTransport('cloud', transport);
    const lease = await repo.acquireDoc('session-test');
    const room = await repo.joinDocRoom('session-test');
    try {
      const sync = createConversationSync(false);
      let waiting: { phase: string; resolve: () => void } | undefined;
      const waitFor = (phase: string) => {
        const next = Promise.withResolvers<void>();
        waiting = { phase, resolve: next.resolve };
        if (sync.getSnapshot().phase === phase) next.resolve();
        return next.promise;
      };
      const binding = room.subscription('cloud');
      const stop = observeConversationDocument(
        binding,
        (step) => {
          sync.update('document', step);
          if (step.phase === waiting?.phase) waiting.resolve();
        },
        (listener) => transport.observeDocReceive('session-test', listener)
      );
      try {
        await waitFor('confirmed');
        await first.promise;
        const rejoined = Promise.withResolvers<void>();
        const stopStatus = binding.onStatusChange((status) => {
          if (status === 'joined') rejoined.resolve();
        });
        transport.revalidateDocReceive('session-test');
        const wire = await second.promise;
        await rejoined.promise;
        stopStatus();
        expect(sync.getSnapshot().phase).toBe('syncing');

        const send = (nextOffset: string, upToDate: boolean, bytes?: Uint8Array) => {
          let data = '';
          if (bytes) {
            const frame = new Uint8Array(4 + bytes.length);
            new DataView(frame.buffer).setUint32(0, bytes.length);
            frame.set(bytes, 4);
            data = 'event: data\ndata: ' + Buffer.from(frame).toString('base64') + '\n\n';
          }
          const control = JSON.stringify({
            streamNextOffset: nextOffset,
            streamCursor: 'test',
            upToDate,
          });
          wire.enqueue(
            new TextEncoder().encode(data + 'event: control\ndata: ' + control + '\n\n')
          );
        };

        send(head, true);
        await waitFor('confirmed');
        const behind = waitFor('syncing');
        send('00000000000000000001', false);
        await behind;
        expect(lease.doc.getText('history').toString()).toBe('');

        const applied = waitFor('confirmed');
        doc.getText('history').insert(0, 'new reply');
        doc.commit();
        send('00000000000000000002', true, doc.export({ mode: 'update' }));
        await applied;
        expect(lease.doc.getText('history').toString()).toBe('new reply');
      } finally {
        stop();
      }
    } finally {
      room.unsubscribe();
      await lease.release();
    }
  } finally {
    await repo.destroy();
    vi.unstubAllGlobals();
  }
});
