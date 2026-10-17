import { beforeEach, afterEach, vi } from 'vitest';
import { Effect, Layer } from 'effect';
import { LocalLoroWriterTurn } from '../src/local-loro-writer';
import {
  makeLocalLoroWriterLegacy,
  type LocalLoroWriterLegacy,
} from '../src/local-loro-writer/legacy';
/**
 * Doc-update chunking on the local Loro data plane (2026-07-24).
 *
 * Before this change an oversized DOC delta was a TERMINAL `payload_too_large`
 * room error: the server dropped the subscription, the renderer marked the room
 * terminal, and reconnect loops deliberately skipped it — the session silently
 * stopped receiving pushes until an app reload ("renderer 缺消息"). A big
 * session doc's first join catch-up export is a realistic oversize, so this was
 * a live failure mode, not a pathological one.
 *
 * Now an oversized doc delta is sliced into `doc-update-chunk` frames at the
 * transport layer (a Loro update blob is causally dependent, so the pieces are
 * reassembled into the full payload before ONE import). These tests pin both
 * directions plus the assembler's defensive behavior.
 */
import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { LocalLoroTransportAdapter } from '../test-support/local-loro-v7-client';
import { LocalLoroDataPlaneServerLegacy } from '../src/local-loro-data-plane-server';
import {
  DocUpdateChunkAssembler,
  buildDocUpdateChunkPayloads,
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneServerMessage,
} from '../src/local-loro-data-plane';

const WORKSPACE_ID = 'ws-chunk';
const MAX_PAYLOAD_BYTES = 512;

/** Lean copy of the RelayHarness chain with a small frame budget on both ends. */
class ChunkHarness {
  private readonly tasks: Array<() => void | Promise<void>> = [];
  private readonly rendererListeners = new Set<(m: LocalLoroDataPlaneServerMessage) => void>();
  private readonly serverDocs = new Map<string, LoroDoc>();
  readonly pushed: LocalLoroDataPlaneServerMessage[] = [];
  readonly engine = new LocalLoroDataPlaneServerLegacy({
    writerLegacy,
    workspaceId: WORKSPACE_ID,
    resolveDoc: async (docId) => this.serverDoc(docId),
    resolveFlockDoc: async () => {
      throw new Error('unused');
    },
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
  });

  private readonly sharedConnection = {
    id: 'dp:relay:1',
    send: (message: LocalLoroDataPlaneServerMessage) => {
      this.pushed.push(message);
      this.tasks.push(() => {
        for (const listener of this.rendererListeners) listener(message);
      });
    },
  };

  serverDoc(docId: string): LoroDoc {
    const existing = this.serverDocs.get(docId);
    if (existing) return existing;
    const doc = new LoroDoc();
    this.serverDocs.set(docId, doc);
    return doc;
  }

  createAdapter(peerId: string): LocalLoroTransportAdapter {
    const connection = {
      send: (message: LocalLoroDataPlaneClientMessage) => {
        this.tasks.push(async () => {
          if (message.type === 'ping') return;
          await this.engine.handleMessage(this.sharedConnection, message);
        });
      },
      onMessage: (listener: (m: LocalLoroDataPlaneServerMessage) => void) => {
        this.rendererListeners.add(listener);
        return () => this.rendererListeners.delete(listener);
      },
      onStatusChange: () => () => {},
      isConnected: () => true,
    };
    return new LocalLoroTransportAdapter({
      workspaceId: WORKSPACE_ID,
      peerId,
      connection,
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
    });
  }

  async settle(): Promise<void> {
    for (let round = 0; round < 500; round += 1) {
      if (this.tasks.length === 0) {
        await vi.advanceTimersByTimeAsync(1);
        if (this.tasks.length === 0) return;
      }
      const batch = this.tasks.splice(0);
      for (const task of batch) {
        await task();
      }
      await vi.advanceTimersByTimeAsync(1);
    }
    throw new Error('settle_did_not_converge');
  }
}

const text = (doc: LoroDoc): string => doc.getText('t').toString();
const insert = (doc: LoroDoc, value: string): void => {
  doc.getText('t').insert(doc.getText('t').length, value);
  doc.commit();
};

// Comfortably above MAX_PAYLOAD_BYTES after base64 + update-blob framing.
const bigText = (seed: string): string => seed.repeat(Math.ceil(4096 / seed.length));

const errorFrames = (pushed: LocalLoroDataPlaneServerMessage[]) =>
  pushed.filter((m) => m.type === 'error');
const chunkFrames = (pushed: LocalLoroDataPlaneServerMessage[]) =>
  pushed.filter((m) => m.type === 'update' && m.payload.kind === 'doc-update-chunk');

describe('local data plane doc-update chunking', () => {
  it('an oversized join catch-up is chunked and converges instead of failing terminally', async () => {
    const harness = new ChunkHarness();
    insert(harness.serverDoc('doc-1'), bigText('server-history '));

    const renderer = harness.createAdapter('renderer:a');
    const docA = new LoroDoc();
    const sub = renderer.joinDocRoom('doc-1', docA);
    await harness.settle();

    expect(errorFrames(harness.pushed)).toEqual([]);
    expect(chunkFrames(harness.pushed).length).toBeGreaterThanOrEqual(2);
    // No single frame above the budget (envelope headroom aside).
    for (const message of harness.pushed) {
      if (message.type !== 'update' && message.type !== 'joined') continue;
      expect(JSON.stringify(message).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES + 512);
    }
    expect(text(docA)).toBe(text(harness.serverDoc('doc-1')));
    expect(sub.status).toBe('joined');
  });

  it('an oversized live push after join is chunked and converges', async () => {
    const harness = new ChunkHarness();
    const renderer = harness.createAdapter('renderer:a');
    const docA = new LoroDoc();
    renderer.joinDocRoom('doc-1', docA);
    await harness.settle();

    insert(harness.serverDoc('doc-1'), bigText('live-burst '));
    await harness.settle();

    expect(errorFrames(harness.pushed)).toEqual([]);
    expect(chunkFrames(harness.pushed).length).toBeGreaterThanOrEqual(2);
    expect(text(docA)).toBe(text(harness.serverDoc('doc-1')));
  });

  it('an oversized renderer up-sync is chunked and reaches the server doc', async () => {
    const harness = new ChunkHarness();
    const renderer = harness.createAdapter('renderer:a');
    const docA = new LoroDoc();
    renderer.joinDocRoom('doc-1', docA);
    await harness.settle();

    insert(docA, bigText('offline-writes '));
    await harness.settle();

    expect(errorFrames(harness.pushed)).toEqual([]);
    expect(text(harness.serverDoc('doc-1'))).toBe(text(docA));
  });

  it('a sibling window converges through a chunked relay of another window’s upload', async () => {
    const harness = new ChunkHarness();
    const windowA = harness.createAdapter('renderer:a');
    const windowB = harness.createAdapter('renderer:b');
    const docA = new LoroDoc();
    const docB = new LoroDoc();
    windowA.joinDocRoom('doc-1', docA);
    windowB.joinDocRoom('doc-1', docB);
    await harness.settle();

    insert(docA, bigText('multi-window '));
    await harness.settle();

    expect(errorFrames(harness.pushed)).toEqual([]);
    expect(text(docB)).toBe(text(docA));
    expect(text(harness.serverDoc('doc-1'))).toBe(text(docA));
  });
});

describe('DocUpdateChunkAssembler', () => {
  const payloadsFor = (data: string, transferId: string) =>
    buildDocUpdateChunkPayloads(data, 4, transferId);

  it('reassembles in-order chunks into the original payload', () => {
    const assembler = new DocUpdateChunkAssembler();
    const payloads = payloadsFor('abcdefghij', 't1');
    expect(payloads.length).toBe(3);
    expect(assembler.push(payloads[0]!)).toBeNull();
    expect(assembler.push(payloads[1]!)).toBeNull();
    expect(assembler.push(payloads[2]!)).toBe('abcdefghij');
  });

  it('a new transferId supersedes a partial transfer', () => {
    const assembler = new DocUpdateChunkAssembler();
    const stale = payloadsFor('stale-transfer', 't1');
    expect(assembler.push(stale[0]!)).toBeNull();
    const fresh = payloadsFor('fresh', 't2');
    expect(assembler.push(fresh[0]!)).toBeNull();
    expect(assembler.push(fresh[1]!)).toBe('fresh');
  });

  it('a gap drops the partial transfer instead of producing a corrupt payload', () => {
    const assembler = new DocUpdateChunkAssembler();
    const payloads = payloadsFor('abcdefghijkl', 't1');
    expect(assembler.push(payloads[0]!)).toBeNull();
    // Skip index 1 — the transfer must be dropped, and the late chunk of the
    // dropped transfer must not resurrect it mid-stream.
    expect(assembler.push(payloads[2]!)).toBeNull();
    expect(assembler.push(payloads[1]!)).toBeNull();
    // A complete retry succeeds.
    const retry = payloadsFor('abcdefghijkl', 't2');
    expect(assembler.push(retry[0]!)).toBeNull();
    expect(assembler.push(retry[1]!)).toBeNull();
    expect(assembler.push(retry[2]!)).toBe('abcdefghijkl');
  });
});

let writerLegacy: LocalLoroWriterLegacy;
beforeEach(() => {
  vi.useFakeTimers();
  writerLegacy = makeLocalLoroWriterLegacy(
    Layer.succeed(LocalLoroWriterTurn, {
      next: Effect.callback<void>((resume) => {
        const handle = setTimeout(() => resume(Effect.void), 0);
        return Effect.sync(() => clearTimeout(handle));
      }),
    })
  );
});
afterEach(async () => {
  const closed = writerLegacy.closeLegacy();
  await vi.runAllTimersAsync();
  await closed;
  vi.useRealTimers();
});
