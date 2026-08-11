/**
 * End-to-end coverage of the CLI seam that pairs a repo doc eviction with the
 * local data plane's room invalidation:
 *
 *   LoroDocumentManager.cleanSessionDoc (session GC)
 *     -> SessionDocument.destroy
 *       -> LoroDocumentManager.unloadDocRoom
 *         -> repo.unloadDoc(docId)            (evicts the LoroDoc instance)
 *         -> LocalLoroDataPlaneServer.invalidateDocRoom(docId)
 *
 * `repo.unloadDoc` hands the NEXT `openPersistedDoc` a different `LoroDoc`, but
 * a data-plane doc room resolves its instance ONCE and keeps it while a peer
 * stays subscribed. Without the invalidation the room keeps importing renderer
 * uploads into the orphaned instance: no error, no status change, and the
 * renderer's user turn never reaches the CLI.
 *
 * Everything here is REAL — a real `LoroDocumentManager` over a real `LoroRepo`
 * with SQLite storage in a temp dir, and the manager's own
 * `LocalLoroDataPlaneServer`. Only the socket is faked: the renderer peer is an
 * in-memory connection driven straight through `engine.handleMessage`, exactly
 * as `local-loro-data-plane-server.ts` drives it for a real net socket.
 *
 * Companion coverage that this test deliberately does NOT duplicate:
 *  - `packages/shared/tests/local-loro-transport-bug-repro.test.ts` (F9): the
 *    engine's invalidation semantics against a fake `resolveDoc`.
 *  - `packages/components/tests/local-data-plane-room-invalidation-reconnect.test.ts`:
 *    that the published terminal status actually makes the renderer's reconnect
 *    loop fire.
 *  - `apps/cli/tests/loro-doc-unload-invalidates-data-plane.test.ts`: that
 *    `unloadDocRoom` stays the only `repo.unloadDoc` call site.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LoroDoc, VersionVector } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalCloudPort } from '@lody/platform';
import {
  base64ToBytes,
  bytesToBase64,
  getSessionRoomId,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  sessionDocSchema,
  type LocalLoroDataPlaneRoom,
  type LocalLoroDataPlaneServer,
  type LocalLoroDataPlaneServerMessage,
  type Role,
  type SessionDoc,
  type SessionHistoryInput,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';

import {
  applyLocalPlatformEnv,
  ensureImplicitLocalWorkspace,
  loadOrCreateLocalIdentity,
} from '../src/lib/cli-platform';
import { LoroDocumentManager } from '../src/lib/loro/doc';
import { makeLocalWorkspaceCatalog } from '../src/lib/local-workspace-catalog';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const historyEntry = (id: string, role: Role, text: string): SessionHistoryInput => ({
  id,
  // Fixed timestamp: nothing here depends on the wall clock.
  timestamp: new Date(0).toISOString(),
  role,
  fileDiff: [],
  items: [{ type: 'text', text }],
});

/**
 * The server half of one local data-plane socket. `send` is the only thing the
 * engine sees, so every assertion below is made on the frames a real renderer
 * would have received.
 */
class FakeRendererConnection {
  readonly id = 'dp:loro-doc-unload-integration';
  readonly frames: LocalLoroDataPlaneServerMessage[] = [];
  private readonly waiters = new Set<() => void>();

  readonly send = (message: LocalLoroDataPlaneServerMessage): void => {
    this.frames.push(message);
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  };

  /**
   * Resolve with the first frame at or after `from` that matches. Frames
   * already received satisfy it immediately, so a caller can register the wait
   * after triggering the work without racing the writer.
   */
  waitFor(
    predicate: (message: LocalLoroDataPlaneServerMessage) => boolean,
    from = 0
  ): Promise<LocalLoroDataPlaneServerMessage> {
    const match = (): LocalLoroDataPlaneServerMessage | undefined =>
      this.frames.slice(from).find(predicate);
    const existing = match();
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<LocalLoroDataPlaneServerMessage>((resolve) => {
      const check = (): void => {
        const found = match();
        if (!found) {
          return;
        }
        this.waiters.delete(check);
        resolve(found);
      };
      this.waiters.add(check);
    });
  }
}

/**
 * A renderer window, reduced to what the protocol actually requires: its own
 * `LoroDoc`, a `Mirror` over the shared session schema (how the renderer
 * direct-authors user turns), and hand-built protocol v7 frames.
 */
class FakeRendererPeer {
  readonly peerId = 'renderer:loro-doc-unload-integration';
  readonly doc = new LoroDoc();
  private mirror: Mirror<typeof sessionDocSchema> | null = null;
  private serverVersion: string | undefined;
  private joinCount = 0;

  constructor(
    private readonly engine: LocalLoroDataPlaneServer,
    private readonly connection: FakeRendererConnection,
    private readonly workspaceId: WorkspaceId,
    private readonly room: LocalLoroDataPlaneRoom
  ) {}

  /** Join the room and apply the server's catch-up. Resolves on the `joined` reply. */
  async joinAndSync(): Promise<void> {
    this.joinCount += 1;
    const requestId = `join:${this.peerId}:${this.joinCount}`;
    const from = this.connection.frames.length;
    await this.engine.handleMessage(this.connection, {
      type: 'join',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      requestId,
      workspaceId: this.workspaceId,
      peerId: this.peerId,
      room: this.room,
      haveVersion: this.encodedVersion(),
    });
    const frame = await this.connection.waitFor(
      (message) => message.type === 'joined' && message.requestId === requestId,
      from
    );
    if (frame.type !== 'joined') {
      throw new Error(`Expected a joined frame, received ${frame.type}`);
    }
    this.serverVersion = frame.serverVersion;
    const payload = frame.payload;
    if (payload && payload.kind === 'doc-update') {
      this.doc.import(base64ToBytes(payload.dataBase64));
    }
    if (!this.mirror) {
      this.mirror = new Mirror({ doc: this.doc, schema: sessionDocSchema });
    }
  }

  /** Author a history entry locally, the way the renderer authors a user turn. */
  appendHistory(entry: SessionHistoryInput): void {
    const mirror = this.mirror;
    if (!mirror) {
      throw new Error('The peer must join before it can author history');
    }
    mirror.setState((previous) => {
      const history = (previous.history ?? []) as unknown as SessionHistoryInput[];
      const next: SessionHistoryInput[] = [...history, entry];
      return { ...previous, history: next } as unknown as SessionDoc;
    });
  }

  /**
   * Upload everything the server is missing. `handleMessage` resolves only
   * after the engine has imported the update, so awaiting it is the completion
   * signal — no draining, no polling.
   */
  async pushUpdate(): Promise<void> {
    const from = this.serverVersion
      ? VersionVector.decode(base64ToBytes(this.serverVersion))
      : new VersionVector(null);
    const delta = this.doc.export({ mode: 'update', from });
    expect(delta.length).toBeGreaterThan(0);
    await this.engine.handleMessage(this.connection, {
      type: 'update',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      workspaceId: this.workspaceId,
      peerId: this.peerId,
      room: this.room,
      haveVersion: this.encodedVersion(),
      payload: { kind: 'doc-update', dataBase64: bytesToBase64(delta) },
    });
  }

  private encodedVersion(): string {
    return bytesToBase64(this.doc.oplogVersion().encode());
  }
}

type Harness = {
  manager: LoroDocumentManager;
  connection: FakeRendererConnection;
  peer: FakeRendererPeer;
  sessionId: SessionId;
  docId: string;
  cliEntryId: string;
  dispose: () => Promise<void>;
};

describe('session GC unloads the repo doc and invalidates its local data-plane room', () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lody-doc-unload-dp-'));
    process.env.LODY_PLATFORM = 'local';
    process.env.LODY_DATA_DIR = path.join(tempDir, '.lody-oss');
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Real manager, real repo, real data-plane engine; one session doc with one
   * CLI-authored history entry and a renderer peer subscribed to its room.
   */
  const createHarness = async (): Promise<Harness> => {
    applyLocalPlatformEnv();
    const logger = createSilentLogger();
    const identity = await loadOrCreateLocalIdentity(logger);
    const catalog = makeLocalWorkspaceCatalog({
      filePath: path.join(tempDir, '.lody-oss', 'workspace-catalog.json'),
      lockName: `doc-unload-dp-${process.pid}`,
      cacheTtlMs: Number.POSITIVE_INFINITY,
    });
    const workspace = await ensureImplicitLocalWorkspace({
      catalog,
      identity,
      machineId: 'local-machine',
      machineName: 'local-host',
      logger,
    });
    const cloudPort = createLocalCloudPort({
      identity: { userId: identity.userId },
      workspaces: [workspace],
    });
    const workspaceId = workspace.id as WorkspaceId;
    const manager = await LoroDocumentManager.create(workspaceId, identity.userId, logger, {
      streamsTokens: cloudPort.streamsTokens,
      cloudBilling: cloudPort.billing,
    });
    const dispose = async (): Promise<void> => {
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
      await cloudPort.dispose();
    };

    try {
      const engine = manager.getLocalLoroDataPlaneServer();
      if (!engine) {
        throw new Error('LoroDocumentManager.create did not build a local data-plane engine');
      }

      const sessionId = await manager.createSession('local-machine', 'builtin', 'claude');
      const sessionDoc = await manager.getOrCreateSessionDoc(sessionId);
      // The offline room settles immediately (no transport is attached). This
      // does NOT cover the manager's join-triggered hydrate — that is fired by
      // the peer's join further down, after this line. The hydrate
      // (`ensureSessionDocHydratedForLocalJoin`) is a floating promise that
      // nothing awaits; it settles before the GC below only because `docSub` is
      // already set here, so `ensureDocRoomJoined` short-circuits on an
      // already-resolved `remoteSyncReady`. If that hydrate ever does real
      // work, this test becomes order-dependent and needs an explicit signal.
      await sessionDoc.waitForRemoteSync();
      const cliEntryId = 'cli-authored-turn';
      await sessionDoc.updateHistory((history) => [
        ...history,
        historyEntry(cliEntryId, 'assistant', 'agent reply written by the CLI'),
      ]);

      const docId = getSessionRoomId(sessionId);
      const room: LocalLoroDataPlaneRoom = { scope: 'doc', docId };
      const connection = new FakeRendererConnection();
      const peer = new FakeRendererPeer(engine, connection, workspaceId, room);
      await peer.joinAndSync();

      // The peer really is synced with the CLI's doc before anything is evicted.
      const joinedHistory = peer.doc.toJSON() as { history?: Array<{ id?: unknown }> };
      expect((joinedHistory.history ?? []).map((entry) => entry.id)).toEqual([cliEntryId]);

      return { manager, connection, peer, sessionId, docId, cliEntryId, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  };

  it('lets a renderer update authored after session GC reach the CLI', async () => {
    const harness = await createHarness();
    try {
      // Session GC: destroys the SessionDocument, which unloads the doc from the
      // repo and invalidates the data-plane room bound to the evicted instance.
      await harness.manager.cleanSessionDoc(harness.sessionId);

      const rendererEntryId = 'renderer-authored-turn';
      harness.peer.appendHistory(
        historyEntry(rendererEntryId, 'user', 'user turn sent after the session was collected')
      );
      await harness.peer.pushUpdate();

      const history = await harness.manager.getSessionHistorySnapshot(harness.sessionId);
      const ids = history.map((entry) => entry.id);
      // Before the fix this is missing: the upload landed in the LoroDoc the
      // repo had already evicted, so the CLI never saw the turn.
      expect(ids).toContain(rendererEntryId);
      // ...and the pre-eviction CLI history is still there, so the read really
      // is of the same document rather than a fresh empty one.
      expect(ids).toContain(harness.cliEntryId);

      const rendererEntry = history.find((entry) => entry.id === rendererEntryId);
      expect(rendererEntry?.role).toBe('user');
      const items = rendererEntry?.items ?? [];
      expect(items[0]?.text).toBe('user turn sent after the session was collected');
    } finally {
      await harness.dispose();
    }
  });

  it('tells the subscribed peer to rejoin with a terminal room status', async () => {
    const harness = await createHarness();
    try {
      const from = harness.connection.frames.length;
      await harness.manager.cleanSessionDoc(harness.sessionId);

      // Rejoin, exactly as the renderer's local reconnect loop would. Its
      // `joined` reply is queued behind the invalidation's frames on the SAME
      // per-connection writer, and the writer drains FIFO — so once it lands,
      // every frame the invalidation produced has already been written. That
      // ordering is the completion signal; nothing here waits on a clock.
      await harness.peer.joinAndSync();

      const roomStatuses = harness.connection.frames
        .slice(from)
        .flatMap((message) =>
          message.type === 'room-status' &&
          message.room.scope === 'doc' &&
          message.room.docId === harness.docId
            ? [message.status]
            : []
        );
      expect(roomStatuses.length).toBeGreaterThan(0);
      // Only 'disconnected'/'error' are terminal for the renderer's reconnect
      // predicate; 'reconnecting' reads as "already recovering" and the local
      // reconnect loop would never fire, leaving the room silently orphaned.
      expect(
        roomStatuses.filter((status) => status === 'disconnected' || status === 'error')
      ).toEqual(roomStatuses);
    } finally {
      await harness.dispose();
    }
  });
});
