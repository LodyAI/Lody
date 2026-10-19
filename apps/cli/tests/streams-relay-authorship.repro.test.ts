/**
 * DUAL-AUTHOR INVARIANT GUARD (originally the 2026-07-05 characterization of
 * 「本地创建会话不上云」).
 *
 * These tests pin the physical basis of the dual-author architecture
 * (specs/local-first-two-plane.md 作者规则): streams-crdt's live up-link is
 * author-scoped, so a replica CANNOT relay ops another replica authored — an op
 * imported over the local data plane never reaches the cloud through the
 * importer's connection. Therefore each node uploads its own authored ops over
 * its own Streams connection: the renderer for user/UI durable data, the CLI
 * for agent output. If someone attempts to reintroduce a proxy/relay design
 * (CLI uploading renderer-authored ops), these tests document exactly why it
 * silently drops data.
 *
 * Causal summary (3 lines):
 *  1. In local-first mode every user action is authored by the RENDERER replica and
 *     reaches the CLI as an IMPORT over the local data plane.
 *  2. The CLI's Streams live up-link only forwards ops its own replica authored —
 *     flock drain: `batch.source === 'local'` gate + `exportJson({from, peerId})`
 *     ("export only entries written by this peer", flock-wasm README:619);
 *     doc drain: `doc.subscribeLocalUpdates` (local commits only).
 *  3. So the renderer-authored `['e', sessionId]` existence entry (what `listDoc`
 *     scans) and later renderer doc ops never reach the meta/doc streams live —
 *     the session is invisible on every remote device.
 *
 * Note: a Streams re-join happens to flush foreign ops too, because join
 * catch-up uses the UNFILTERED export
 * (`performInitialJoinSync` → `exportUpdates(cursor.serverLowerBoundVersion)`,
 * streams-crdt dist/stream-id-*.js:3059-3078) — "stuck until restart, then
 * appears". Since streams-crdt 0.15.1 two more unfiltered append paths exist
 * (both scoped to an apply-incomplete wedge, neither a live relay): the
 * initial-join salvage (`salvageLocalBacklogOnIncompleteInitialSync`) and the
 * degraded pending flush drain queued LOCAL batches while remote apply is
 * wedged. The live up-link stays author-scoped — the invariant these tests
 * pin is unchanged.
 *
 * Production call sites pinned by these tests (shipped dists,
 * @loro-dev/streams-crdt 0.15.1):
 *  - loro-repo dist/transport/streams.js:4,27,644,738 —
 *    `createFlockAdapter(patchFlockExportJson(flock))` builds the meta/flock-doc
 *    Streams sessions; the wrapper only special-cases an empty `from`, keeping the
 *    `peerId` filter intact.
 *  - @loro-dev/streams-crdt dist/flock.js:131-149 — live drain:
 *    `flock.subscribe(batch => { if (batch.source !== 'local') return; ...
 *    flock.exportJson({ from: lastExportedVersion, peerId: flock.peerId() }) ... })`.
 *  - @loro-dev/streams-crdt dist/loro.js:223-232 — doc live drain:
 *    `doc.subscribeLocalUpdates(update => listener({ updates: [update], ... }))`.
 *  - CLI import side that makes the renderer ops "foreign":
 *    packages/shared/src/local-loro-data-plane-server.ts handleUpdate →
 *    `entry.flock.importJson(bundle)` / `entry.doc.import(bytes)` (source
 *    'import' / by 'import'), wired to the repo's internal metaFlock via
 *    apps/cli/src/lib/loro/doc.ts:108-121.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Layer } from 'effect';
import { LocalLoroWriterTurn } from '@lody/shared/local-loro-writer';
import {
  makeLocalLoroWriterLegacy,
  type LocalLoroWriterLegacy,
} from '@lody/shared/local-loro-writer/legacy';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import { createLoroDocAdapter } from '@loro-dev/streams-crdt/loro';
import { createFlockAdapter } from '@loro-dev/streams-crdt/flock';
import {
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneServerMessage,
} from '@lody/shared/local-loro-data-plane';
import { LocalLoroDataPlaneServerLegacy } from '@lody/shared/local-loro-data-plane-server';
import { LocalLoroTransportAdapter } from '../../../packages/shared/test-support/local-loro-v7-client';

const decoder = new TextDecoder();

/**
 * Verbatim copy of loro-repo's wrapper around the flock handed to
 * `createFlockAdapter` (loro-repo dist/transport/streams.js:27-41). It only
 * rewrites an EMPTY `from` version vector; the `peerId` author filter passes
 * through untouched — included so the tests exercise exactly the production
 * export call, not a re-implementation.
 */
function patchFlockExportJson(flock: Flock): Flock {
  const orig = flock.exportJson.bind(flock);
  (flock as { exportJson: unknown }).exportJson = (
    arg?: unknown,
    pruneTombstonesBefore?: number
  ) => {
    if (arg && typeof arg === 'object' && 'from' in arg) {
      const from = (arg as { from?: unknown }).from;
      if (from != null && typeof from === 'object' && Object.keys(from).length === 0) {
        const { from: _from, ...rest } = arg as Record<string, unknown>;
        if (Object.keys(rest).length === 0) {
          return orig();
        }
        return (orig as (a?: unknown, p?: number) => unknown)(rest, pruneTombstonesBefore);
      }
    }
    return arg === undefined
      ? orig()
      : (orig as (a?: unknown, p?: number) => unknown)(arg, pruneTombstonesBefore);
  };
  return flock;
}

/** Flock events are debounced; commit() forces emission, then drain microtasks. */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(5);
  }
}

/** Merge the drained flock wire batches into a "cloud" replica. */
function importDrainedFlockBatches(cloud: Flock, drained: Uint8Array[]): void {
  for (const update of drained) {
    cloud.importJson(JSON.parse(decoder.decode(update)));
  }
  cloud.commit();
}

describe('dual-author invariant: a Streams up-link cannot relay foreign-authored ops', () => {
  it("meta/flock: a renderer-authored ['e', sessionId] entry imported over the data plane must reach the live drain output", async () => {
    // The CLI workspace's internal metaFlock, exactly as loro-repo hands it to
    // the Streams meta session (streams.js:644).
    const cliMeta = patchFlockExportJson(new Flock('cli-meta-peer'));
    const adapter = createFlockAdapter(cliMeta);
    const drained: Uint8Array[] = [];
    adapter.subscribeLocalUpdates?.((batch) => {
      drained.push(...batch.updates);
    });

    // Renderer creates a session locally: its own replica authors the existence
    // entry + creation metadata; the CLI receives the bundle as an IMPORT
    // (LocalLoroDataPlaneServerLegacy.handleUpdate → flock.importJson), preserving the
    // renderer peer's authorship on every entry (dual-author local plane sync).
    const rendererMeta = new Flock('renderer-meta-peer');
    rendererMeta.put(['e', 'session-1'], true);
    rendererMeta.put(['m', 'session-1', 'title'], 'local session');
    rendererMeta.commit();
    cliMeta.importJson(rendererMeta.exportJson());
    cliMeta.commit();
    await settle();

    // The CLI daemon then dispatches the session and writes its own runtime
    // metadata (repo.upsertDocMeta status/acpSessionId writes,
    // apps/cli/src/lib/loro/doc.ts:1553-1560 etc.) — a CLI-local flock write,
    // which is what triggers the production live drain.
    cliMeta.put(['m', 'session-1', 'status'], 'running');
    cliMeta.commit();
    await settle();
    await adapter.flushLocalExports?.();
    await settle();

    // What the cloud meta stream ends up holding = merge of everything drained.
    const cloud = new Flock('cloud-peer');
    importDrainedFlockBatches(cloud, drained);

    // Sanity: the live pipeline itself works — the CLI-authored status write was
    // drained and reached the cloud replica.
    expect(cloud.get(['m', 'session-1', 'status'])).toBe('running');

    // THE INVARIANT: the renderer-authored existence entry is DROPPED by the
    // CLI's up-link (the drain's source gate skips the import event, and the
    // peerId-filtered export excludes foreign-authored entries). Under
    // dual-author the renderer's OWN cloud connection uploads it; the CLI's
    // connection structurally cannot — do not build anything that relies on
    // the CLI relaying renderer ops.
    expect(cloud.get(['e', 'session-1'])).toBeUndefined();
  });

  it('doc: renderer-authored ops imported over the data plane must be carried by the live local-updates pipeline', async () => {
    // The CLI-side session doc, exactly as loro-repo hands it to the Streams doc
    // session (createLoroDocAdapter, loro-repo streams.js doc sessions).
    const cliDoc = new LoroDoc();
    const adapter = createLoroDocAdapter(cliDoc);
    const drained: Uint8Array[] = [];
    adapter.subscribeLocalUpdates?.((batch) => {
      drained.push(...batch.updates);
    });

    // The user's message is authored by the renderer replica and reaches the CLI
    // doc as an import (LocalLoroDataPlaneServerLegacy.handleUpdate → doc.import).
    const rendererDoc = new LoroDoc();
    rendererDoc.getText('history').insert(0, 'user-message');
    rendererDoc.commit();
    cliDoc.import(rendererDoc.export({ mode: 'update' }));
    await settle(2);

    // ACP output is CLI-local and does fire the live pipeline
    // (doc.subscribeLocalUpdates emits only locally-committed batches).
    cliDoc.getText('agent').insert(0, 'acp-output');
    cliDoc.commit();
    await settle(2);

    // Sanity: the CLI-local commit produced live update batches.
    expect(drained.length).toBeGreaterThan(0);

    // THE INVARIANT: the cloud replica = whatever the live pipeline shipped.
    // The renderer's imported ops are NOT part of it —
    // `doc.subscribeLocalUpdates` emits only CLI-authored batches. Under
    // dual-author the renderer's own cloud connection carries the user turn;
    // the CLI's connection structurally cannot.
    const cloud = new LoroDoc();
    for (const update of drained) {
      cloud.import(update);
    }
    expect(cloud.getText('history').toString()).toBe('');
  });

  it("product chain: a session created over the relayed data plane is DROPPED from the Streams sink's live drain", async () => {
    // Faithful compression of the production chain with only the HTTP gateway
    // replaced by a recording sink:
    //   renderer LocalLoroTransportAdapter (v3) → LocalLoroDataPlaneServerLegacy
    //   (resolveMetaFlock → the CLI's real metaFlock, doc.ts:108-121) →
    //   real streams-crdt createFlockAdapter live drain (what
    //   StreamsTransportAdapter's meta session pushes to the cloud).
    // Join catch-up is intentionally NOT wired: it only runs at bridge
    // (re)attach, and the user-visible bug is precisely that nothing after that
    // point ever syncs up.
    const cliMeta = patchFlockExportJson(new Flock('cli-meta-peer'));
    const engine = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
      workspaceId: 'ws',
      resolveDoc: async () => new LoroDoc(),
      resolveFlockDoc: async () => {
        throw new Error('not used');
      },
      resolveMetaFlock: async () => cliMeta,
    });

    // In-memory stand-in for the Electron relay + CLI socket (JSON round-trip =
    // the newline-JSON wire).
    const tasks: Array<() => Promise<void> | void> = [];
    const listeners = new Set<(m: LocalLoroDataPlaneServerMessage) => void>();
    const serverConnection = {
      id: 'dp:1',
      send: (message: LocalLoroDataPlaneServerMessage) => {
        const wire = JSON.parse(JSON.stringify(message)) as LocalLoroDataPlaneServerMessage;
        tasks.push(() => {
          for (const listener of listeners) listener(wire);
        });
      },
    };
    const renderer = new LocalLoroTransportAdapter({
      workspaceId: 'ws',
      peerId: 'renderer:peer',
      connection: {
        send: (message: LocalLoroDataPlaneClientMessage) => {
          const wire = JSON.parse(JSON.stringify(message)) as LocalLoroDataPlaneClientMessage;
          tasks.push(async () => {
            if (wire.type === 'ping') return;
            await engine.handleMessage(serverConnection, wire);
          });
        },
        onMessage: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onStatusChange: () => () => {},
        isConnected: () => true,
      },
    });
    const drainTasks = async () => {
      for (let round = 0; round < 100; round += 1) {
        if (tasks.length === 0) {
          await settle(2);
          if (tasks.length === 0) return;
        }
        for (const task of tasks.splice(0)) {
          await task();
        }
        await settle(2);
      }
      throw new Error('did_not_converge');
    };

    // The CLI's Streams meta live drain, recording what would be appended to the
    // cloud meta stream.
    const streamsAdapter = createFlockAdapter(cliMeta);
    const drained: Uint8Array[] = [];
    streamsAdapter.subscribeLocalUpdates?.((batch) => {
      drained.push(...batch.updates);
    });

    // Renderer joins the meta room and creates a session (upsertDocMeta writes
    // in ITS replica: existence entry + creation metadata).
    const rendererMeta = new Flock('renderer-meta-peer');
    const sub = renderer.joinMetaRoom(rendererMeta as never);
    await drainTasks();
    await sub.firstSyncedWithRemote;
    rendererMeta.put(['e', 'session-1'], true);
    rendererMeta.put(['m', 'session-1', 'title'], 'local session');
    rendererMeta.commit();
    await drainTasks();

    // Confirm the data plane delivered the session to the CLI metaFlock (this is
    // the part that works — dispatch fires, the session runs locally).
    expect(cliMeta.get(['e', 'session-1'])).toBe(true);

    // The daemon's own runtime meta write (status) triggers the live drain.
    cliMeta.put(['m', 'session-1', 'status'], 'running');
    cliMeta.commit();
    await drainTasks();
    await streamsAdapter.flushLocalExports?.();
    await settle();

    const cloud = new Flock('cloud-peer');
    importDrainedFlockBatches(cloud, drained);

    // Sanity: CLI-authored ops do stream up.
    expect(cloud.get(['m', 'session-1', 'status'])).toBe('running');
    // THE INVARIANT: the renderer-authored existence entry — the thing remote
    // devices' session lists are built from — never reaches the sink via the
    // CLI. The renderer's own dual-homed cloud member is its only up-path.
    expect(cloud.get(['e', 'session-1'])).toBeUndefined();
  });

  it('dual-author convergence: the renderer and CLI drains together reconstruct the full session; each alone is incomplete', async () => {
    // End-to-end shape of an offline local conversation converging to the
    // cloud: renderer and CLI exchange ops over the real local data plane
    // (renderer LocalLoroTransportAdapter ↔ LocalLoroDataPlaneServerLegacy), while
    // each side's OWN Streams live drain records what its cloud connection
    // would upload. The cloud replica is the merge of BOTH drains — and only
    // both: author scoping makes either drain alone incomplete. This is the
    // dual-author acceptance criterion (specs/local-first-two-plane.md 验收).
    const cliMeta = patchFlockExportJson(new Flock('cli-meta-peer'));
    const cliSessionDoc = new LoroDoc();
    const engine = new LocalLoroDataPlaneServerLegacy({
      writerLegacy,
      workspaceId: 'ws',
      resolveDoc: async (docId) => {
        if (docId !== 'session-1') throw new Error(`unexpected doc ${docId}`);
        return cliSessionDoc;
      },
      resolveFlockDoc: async () => {
        throw new Error('not used');
      },
      resolveMetaFlock: async () => cliMeta,
    });

    const tasks: Array<() => Promise<void> | void> = [];
    const listeners = new Set<(m: LocalLoroDataPlaneServerMessage) => void>();
    const serverConnection = {
      id: 'dp:1',
      send: (message: LocalLoroDataPlaneServerMessage) => {
        const wire = JSON.parse(JSON.stringify(message)) as LocalLoroDataPlaneServerMessage;
        tasks.push(() => {
          for (const listener of listeners) listener(wire);
        });
      },
    };
    const rendererMeta = patchFlockExportJson(new Flock('renderer-meta-peer'));
    const rendererDoc = new LoroDoc();
    const renderer = new LocalLoroTransportAdapter({
      workspaceId: 'ws',
      peerId: 'renderer:peer',
      connection: {
        send: (message: LocalLoroDataPlaneClientMessage) => {
          const wire = JSON.parse(JSON.stringify(message)) as LocalLoroDataPlaneClientMessage;
          tasks.push(async () => {
            if (wire.type === 'ping') return;
            await engine.handleMessage(serverConnection, wire);
          });
        },
        onMessage: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onStatusChange: () => () => {},
        isConnected: () => true,
      },
    });
    const drainTasks = async () => {
      for (let round = 0; round < 100; round += 1) {
        if (tasks.length === 0) {
          await settle(2);
          if (tasks.length === 0) return;
        }
        for (const task of tasks.splice(0)) {
          await task();
        }
        await settle(2);
      }
      throw new Error('did_not_converge');
    };

    // Each side's own cloud connection, online from the start: record what the
    // author-scoped live drains would upload.
    const rendererMetaAdapter = createFlockAdapter(rendererMeta);
    const rendererMetaDrained: Uint8Array[] = [];
    rendererMetaAdapter.subscribeLocalUpdates?.((batch) => {
      rendererMetaDrained.push(...batch.updates);
    });
    const rendererDocAdapter = createLoroDocAdapter(rendererDoc);
    const rendererDocDrained: Uint8Array[] = [];
    rendererDocAdapter.subscribeLocalUpdates?.((batch) => {
      rendererDocDrained.push(...batch.updates);
    });
    const cliMetaAdapter = createFlockAdapter(cliMeta);
    const cliMetaDrained: Uint8Array[] = [];
    cliMetaAdapter.subscribeLocalUpdates?.((batch) => {
      cliMetaDrained.push(...batch.updates);
    });
    const cliDocAdapter = createLoroDocAdapter(cliSessionDoc);
    const cliDocDrained: Uint8Array[] = [];
    cliDocAdapter.subscribeLocalUpdates?.((batch) => {
      cliDocDrained.push(...batch.updates);
    });

    // Renderer joins both rooms and direct-authors the session: meta existence,
    // dispatch pointer, and the user turn in the session doc.
    const metaSub = renderer.joinMetaRoom(rendererMeta as never);
    const docSub = renderer.joinDocRoom('session-1', rendererDoc);
    await drainTasks();
    await metaSub.firstSyncedWithRemote;
    await docSub.firstSyncedWithRemote;
    rendererMeta.put(['e', 'session-1'], true);
    rendererMeta.put(['m', 'session-1', 'latestUserMsgId'], 'turn-1');
    rendererMeta.commit();
    rendererDoc.getText('history').insert(0, 'user-message');
    rendererDoc.commit();
    await drainTasks();

    // Local plane converged renderer → CLI (this is what wakes dispatch).
    expect(cliMeta.get(['e', 'session-1'])).toBe(true);
    expect(cliMeta.get(['m', 'session-1', 'latestUserMsgId'])).toBe('turn-1');
    expect(cliSessionDoc.getText('history').toString()).toBe('user-message');

    // CLI authors agent output + runtime status.
    cliSessionDoc.getText('agent').insert(0, 'acp-output');
    cliSessionDoc.commit();
    cliMeta.put(['m', 'session-1', 'status'], 'running');
    cliMeta.commit();
    await drainTasks();

    // Local plane converged CLI → renderer (the UI renders agent output).
    expect(rendererDoc.getText('agent').toString()).toBe('acp-output');
    expect(rendererMeta.get(['m', 'session-1', 'status'])).toBe('running');

    await rendererMetaAdapter.flushLocalExports?.();
    await cliMetaAdapter.flushLocalExports?.();
    await settle();

    // The cloud = merge of BOTH authors' drains → complete session.
    const cloudMeta = new Flock('cloud-peer');
    importDrainedFlockBatches(cloudMeta, [...rendererMetaDrained, ...cliMetaDrained]);
    expect(cloudMeta.get(['e', 'session-1'])).toBe(true);
    expect(cloudMeta.get(['m', 'session-1', 'latestUserMsgId'])).toBe('turn-1');
    expect(cloudMeta.get(['m', 'session-1', 'status'])).toBe('running');
    const cloudDoc = new LoroDoc();
    for (const update of [...rendererDocDrained, ...cliDocDrained]) {
      cloudDoc.import(update);
    }
    expect(cloudDoc.getText('history').toString()).toBe('user-message');
    expect(cloudDoc.getText('agent').toString()).toBe('acp-output');

    // Author scoping (both directions): either drain alone is incomplete, so
    // neither side can be demoted to a relay of the other.
    const cliOnlyMeta = new Flock('cloud-cli-only');
    importDrainedFlockBatches(cliOnlyMeta, cliMetaDrained);
    expect(cliOnlyMeta.get(['e', 'session-1'])).toBeUndefined();
    const rendererOnlyMeta = new Flock('cloud-renderer-only');
    importDrainedFlockBatches(rendererOnlyMeta, rendererMetaDrained);
    expect(rendererOnlyMeta.get(['m', 'session-1', 'status'])).toBeUndefined();
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
