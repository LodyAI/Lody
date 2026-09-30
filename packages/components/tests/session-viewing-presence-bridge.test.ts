import { afterEach, describe, expect, it, vi } from 'vitest';
import { EphemeralStore, type Value } from 'loro-crdt';
import {
  getLodySessionViewingPresenceKey,
  parseLodyPresenceStates,
  type LodyPresenceInstanceId,
  type WorkspaceId,
} from '@lody/shared';

import { WorkspacePresenceTransport } from '../src/providers/workspace-presence-transport';
import type { EphemeralRoomAuthCallback } from '../src/providers/ephemeral-room-transport';

/**
 * Milestone-0 proof for the CLI PR poller: a local `EphemeralStore` write is
 * encoded and broadcast by `EphemeralStoreAdaptor` — the same adaptor both the
 * CLI publisher (`CliPresenceRuntime`) and the web `WorkspacePresenceTransport`
 * wire into `EphemeralStreamCrdt`. Bridging two stores with encode/apply
 * exercises the exact wasm primitives the adaptor drives over the wire, so a
 * browser-side `store.set` is observed by every room peer.
 */
describe('session-viewing presence over EphemeralStore', () => {
  it('propagates set/delete between bridged stores and survives schema parsing', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const publisher = new EphemeralStore(90_000);
    const observer = new EphemeralStore(90_000);
    publisher.subscribeLocalUpdates((bytes) => {
      observer.apply(bytes);
    });

    const key = getLodySessionViewingPresenceKey('user-1', 'instance-1' as LodyPresenceInstanceId);
    const state = {
      kind: 'session-viewing',
      userId: 'user-1',
      instanceId: 'instance-1',
      sessionId: 'session-1',
      since: 1_000,
      updatedAt: 2_000,
    };

    publisher.set(key, state as unknown as Value);
    // The observer parses the entry through the same schema the CLI poller uses.
    expect(
      parseLodyPresenceStates(observer.getAllStates() as Record<string, unknown>)[key]
    ).toEqual(state);

    vi.setSystemTime(1_000_001);
    publisher.delete(key);
    expect(observer.getAllStates()[key]).toBeUndefined();

    publisher.destroy();
    observer.destroy();
  });
});

// Expose the production factory; do not inject a fake transport or adaptor.
class ProductionPresenceTransport extends WorkspacePresenceTransport {
  open(store: EphemeralStore, auth: EphemeralRoomAuthCallback = async () => 'test-token') {
    return this.createTransport({
      streamUrl: 'https://streams.example.com/v1/streams/presence?ephemeral=presence',
      store,
      auth,
    });
  }
}

function bootstrapResponse(signal?: AbortSignal | null): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: bootstrap\ndata: AA==\n\n'));
        signal?.addEventListener('abort', () => controller.close(), { once: true });
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream', 'Stream-SSE-Data-Encoding': 'base64' } }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('production presence transport with the published Streams runtime', () => {
  it.each(['set', 'delete'] as const)(
    'coalesces unsent values through a final %s, preserving in-flight bytes and the sync barrier',
    async (operation) => {
      // Loro timestamps are part of the wire value: explicitly order mutations.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_000_000);
      const store = new EphemeralStore(90_000);
      const peer = new EphemeralStore(90_000);
      const posts: Uint8Array[] = [];
      const firstStarted = Promise.withResolvers<void>();
      const lastStarted = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const releaseLast = Promise.withResolvers<void>();
      vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
        if (init?.method !== 'POST') return bootstrapResponse(init?.signal);
        const bytes = new Uint8Array(init.body as Uint8Array);
        posts.push(bytes);
        if (posts.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else if (posts.length === 3) {
          lastStarted.resolve();
          await releaseLast.promise;
        }
        peer.apply(bytes);
        return new Response(null, { status: 204 });
      });
      const factory = new ProductionPresenceTransport({
        workspaceId: 'workspace-test' as WorkspaceId,
      });
      const transport = factory.open(store);
      try {
        const result = await transport.join({});
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        store.set('viewing', { sessionId: 'first' });
        await firstStarted.promise;
        for (let i = 0; i < 100; i += 1) {
          vi.setSystemTime(1_000_001 + i);
          store.set('viewing', { sessionId: `session-${i}` });
        }
        let synced = false;
        const barrier = result.value.waitUntilSynced().then(() => {
          synced = true;
        });
        store.set('heartbeat', { updatedAt: 123 });
        vi.setSystemTime(1_000_101);
        if (operation === 'delete') store.delete('viewing');
        else store.set('viewing', { sessionId: 'latest' });
        releaseFirst.resolve();
        await lastStarted.promise;
        // Only the original in-flight write and the independent heartbeat arrived.
        expect(peer.getAllStates()).toEqual({
          viewing: { sessionId: 'first' },
          heartbeat: { updatedAt: 123 },
        });
        expect(synced).toBe(false);
        releaseLast.resolve();
        await barrier;
        expect(posts).toHaveLength(3);
        expect(peer.getAllStates()).toEqual(
          operation === 'delete'
            ? { heartbeat: { updatedAt: 123 } }
            : { viewing: { sessionId: 'latest' }, heartbeat: { updatedAt: 123 } }
        );
        expect(result.value.pendingLocalCount).toBe(0);
      } finally {
        releaseFirst.resolve();
        releaseLast.resolve();
        await transport.close();
        store.destroy();
        peer.destroy();
      }
    }
  );

  it.each(['request', 'unauthorized'] as const)(
    'recovers after a stalled %s token callback reaches the default deadline',
    async (reason) => {
      vi.useFakeTimers();
      const store = new EphemeralStore(90_000);
      const tokenStalled = Promise.withResolvers<void>();
      const recovering = Promise.withResolvers<void>();
      const appended = Promise.withResolvers<void>();
      let stall = true;
      let rejectPost = reason === 'unauthorized';
      let allowStall = false;
      vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
        if (init?.method !== 'POST') return bootstrapResponse(init?.signal);
        if (rejectPost) {
          rejectPost = false;
          return new Response(null, { status: 401 });
        }
        appended.resolve();
        return new Response(null, { status: 204 });
      });
      const factory = new ProductionPresenceTransport({
        workspaceId: 'workspace-test' as WorkspaceId,
      });
      const transport = factory.open(store, async (context) => {
        if (allowStall && stall && context?.reason === reason) {
          tokenStalled.resolve();
          return new Promise<string>(() => {});
        }
        return 'test-token';
      });
      try {
        const result = await transport.join({
          onStatusChange: (status) => {
            if (status === 'reconnecting') recovering.resolve();
          },
        });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        allowStall = true;
        store.set('viewing', { sessionId: 'latest' });
        const barrier = result.value.waitUntilSynced();
        await tokenStalled.promise;
        stall = false;
        await vi.advanceTimersByTimeAsync(10_001);
        await recovering.promise;
        await appended.promise;
        await barrier;
        expect(result.value.pendingLocalCount).toBe(0);
        expect(result.value.status).toBe('joined');
      } finally {
        await transport.close();
        store.destroy();
      }
    }
  );
});
