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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { LoroDocumentManager, SessionDocument } from '../src/lib/loro/doc';
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

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

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

  async leave(): Promise<void> {
    await this.engine.handleMessage(this.connection, {
      type: 'leave',
      protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
      workspaceId: this.workspaceId,
      peerId: this.peerId,
      room: this.room,
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
      // The offline room settles immediately because no transport is attached.
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

  it('bounds and releases renderer-only cloud reconciles without SessionDocuments', async () => {
    applyLocalPlatformEnv();
    const logger = createSilentLogger();
    const identity = await loadOrCreateLocalIdentity(logger);
    const catalog = makeLocalWorkspaceCatalog({
      filePath: path.join(tempDir, '.lody-oss', 'workspace-catalog.json'),
      lockName: `doc-local-only-${process.pid}`,
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
    const manager = await LoroDocumentManager.create(workspace.id, identity.userId, logger, {
      streamsTokens: cloudPort.streamsTokens,
      cloudBilling: cloudPort.billing,
    });

    try {
      const engine = manager.getLocalLoroDataPlaneServer();
      if (!engine) throw new Error('Expected a local data-plane engine');
      const joinDocRoom = vi.spyOn(manager.repo, 'joinDocRoom');
      const unloadDoc = vi.spyOn(manager.repo, 'unloadDoc');
      const connection = new FakeRendererConnection();
      const docIds = Array.from({ length: 6 }, (_, index) =>
        getSessionRoomId(`renderer-only-session-${index}` as SessionId)
      );
      const peers = docIds.map(
        (docId) =>
          new FakeRendererPeer(engine, connection, workspace.id, {
            scope: 'doc',
            docId,
          })
      );

      await Promise.all(peers.map((peer) => peer.joinAndSync()));
      await vi.waitFor(() => expect(joinDocRoom).toHaveBeenCalledTimes(4));

      expect(manager.getConnectedRoomCount()).toBe(0);

      await peers[0]!.leave();
      await vi.waitFor(() => expect(joinDocRoom).toHaveBeenCalledTimes(5));

      await Promise.all(peers.map((peer) => peer.leave()));
      await vi.waitFor(() => {
        for (const docId of docIds) {
          expect(unloadDoc).toHaveBeenCalledWith(docId);
        }
      });
      expect(manager.getConnectedRoomCount()).toBe(0);
    } finally {
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
      await cloudPort.dispose();
    }
  });

  it('serializes renderer-only unload with snapshot reads and SessionDocument takeover', async () => {
    applyLocalPlatformEnv();
    const logger = createSilentLogger();
    const identity = await loadOrCreateLocalIdentity(logger);
    const catalog = makeLocalWorkspaceCatalog({
      filePath: path.join(tempDir, '.lody-oss', 'workspace-catalog.json'),
      lockName: `doc-local-takeover-${process.pid}`,
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
    const manager = await LoroDocumentManager.create(workspace.id, identity.userId, logger, {
      streamsTokens: cloudPort.streamsTokens,
      cloudBilling: cloudPort.billing,
    });
    const unloadGates = new Map<
      string,
      { started: ReturnType<typeof createDeferred>; release: ReturnType<typeof createDeferred> }
    >();

    try {
      const engine = manager.getLocalLoroDataPlaneServer();
      if (!engine) throw new Error('Expected a local data-plane engine');
      const connection = new FakeRendererConnection();
      const originalUnloadDoc = manager.repo.unloadDoc.bind(manager.repo);
      vi.spyOn(manager.repo, 'unloadDoc').mockImplementation(async (unloadDocId) => {
        const gate = unloadGates.get(unloadDocId);
        gate?.started.resolve();
        await gate?.release.promise;
        await originalUnloadDoc(unloadDocId);
      });
      const beginBlockedRendererLeave = async (sessionId: SessionId) => {
        const docId = getSessionRoomId(sessionId);
        const gate = { started: createDeferred(), release: createDeferred() };
        unloadGates.set(docId, gate);
        const peer = new FakeRendererPeer(engine, connection, workspace.id, {
          scope: 'doc',
          docId,
        });
        await peer.joinAndSync();
        await peer.leave();
        await gate.started.promise;
        return gate;
      };

      const snapshotSessionId = 'renderer-only-snapshot' as SessionId;
      const snapshotGate = await beginBlockedRendererLeave(snapshotSessionId);
      let snapshotResolved = false;
      const snapshot = manager.getSessionHistorySnapshot(snapshotSessionId).then((history) => {
        snapshotResolved = true;
        return history;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(snapshotResolved).toBe(false);
      snapshotGate.release.resolve();
      await expect(snapshot).resolves.toEqual([]);

      const sessionId = 'renderer-only-takeover' as SessionId;
      const takeoverGate = await beginBlockedRendererLeave(sessionId);
      let takeoverResolved = false;
      const takeover = manager.getOrCreateSessionDoc(sessionId).then((sessionDoc) => {
        takeoverResolved = true;
        return sessionDoc;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(takeoverResolved).toBe(false);

      takeoverGate.release.resolve();
      const sessionDoc = await takeover;
      expect(sessionDoc.isDestroyed).toBe(false);
      expect(manager.getConnectedRoomCount()).toBe(1);
    } finally {
      for (const gate of unloadGates.values()) {
        gate.release.resolve();
      }
      await manager.cleanUp({ fast: true, preserveSessionStatus: true });
      await cloudPort.dispose();
    }
  });

  it('joins the original in-flight destruction before reopening the document', async () => {
    const harness = await createHarness();
    const { manager, sessionId } = harness;
    const stale = await manager.getOrCreateSessionDoc(sessionId);
    const entered = createDeferred();
    const release = createDeferred();
    const originalUnload = manager.repo.unloadDoc.bind(manager.repo);
    const unload = vi.spyOn(manager.repo, 'unloadDoc').mockImplementationOnce(async (docId) => {
      entered.resolve();
      await release.promise;
      await originalUnload(docId);
    });
    try {
      const cleanup = manager.cleanSessionDoc(sessionId);
      await entered.promise;
      expect(stale.isDestroyed).toBe(true);
      const opened = vi.fn();
      const reopening = manager.getOrCreateSessionDoc(sessionId).then((doc) => {
        opened();
        return doc;
      });
      // Drain queued ownership work while the original unload is still blocked.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unload).toHaveBeenCalledOnce();
      expect(opened).not.toHaveBeenCalled();
      expect(manager.sessions.get(sessionId)).toBe(stale);
      release.resolve();
      await cleanup;
      const fresh = await reopening;
      expect(fresh).not.toBe(stale);
      expect(fresh.isDestroyed).toBe(false);
      expect(fresh.mirror).not.toBeNull();
      expect(manager.sessions.get(sessionId)).toBe(fresh);
      expect(unload).toHaveBeenCalledOnce();
      expect((await fresh.getHistory()).map((entry) => entry.id)).toContain(harness.cliEntryId);
    } finally {
      release.resolve();
      unload.mockRestore();
      await harness.dispose();
    }
  });
  it('keeps a failed destroyed wrapper private until coalesced teardown retry opens a fresh doc', async () => {
    const harness = await createHarness();
    const { manager, sessionId } = harness;
    const stale = await manager.getOrCreateSessionDoc(sessionId);
    const unload = vi
      .spyOn(manager.repo, 'unloadDoc')
      .mockRejectedValueOnce(new Error('first unload failed'))
      .mockRejectedValueOnce(new Error('retry unload failed'));
    try {
      await expect(manager.cleanSessionDoc(sessionId)).rejects.toThrow('first unload failed');
      expect(stale.isDestroyed).toBe(true);
      expect(manager.sessions.get(sessionId)).toBe(stale);
      await expect(manager.getOrCreateSessionDoc(sessionId)).rejects.toThrow('retry unload failed');
      expect(manager.sessions.get(sessionId)).toBe(stale);
      const retry = vi.spyOn(stale, 'destroy');
      const [fresh, same] = await Promise.all([
        manager.getOrCreateSessionDoc(sessionId),
        manager.getOrCreateSessionDoc(sessionId),
      ]);
      expect(fresh).not.toBe(stale);
      expect(same).toBe(fresh);
      expect(fresh.isDestroyed).toBe(false);
      expect(fresh.mirror).not.toBeNull();
      expect(manager.sessions.get(sessionId)).toBe(fresh);
      expect(stale.mirror).toBeNull();
      expect(retry).toHaveBeenCalledExactlyOnceWith({ preserveStatus: true });
      expect(unload).toHaveBeenCalledTimes(3);
      expect((await fresh.getHistory()).map((entry) => entry.id)).toContain(harness.cliEntryId);
    } finally {
      unload.mockRestore();
      await harness.dispose();
    }
  });

  it.each(['reopen', 'cleanup'] as const)(
    'preserves a replacement installed during %s teardown',
    async (operation) => {
      const harness = await createHarness();
      const { manager, sessionId } = harness;
      const stale = await manager.getOrCreateSessionDoc(sessionId);
      try {
        if (operation === 'reopen') {
          const unload = vi
            .spyOn(manager.repo, 'unloadDoc')
            .mockRejectedValueOnce(new Error('unload failed'));
          await expect(manager.cleanSessionDoc(sessionId)).rejects.toThrow('unload failed');
          unload.mockRestore();
        }
        const originalDestroy = stale.destroy.bind(stale);
        const replacement = new SessionDocument(
          manager.repo,
          sessionId,
          (docId) => manager.unloadDocRoom(docId),
          createSilentLogger()
        );
        vi.spyOn(stale, 'destroy').mockImplementationOnce(async (options) => {
          await originalDestroy(options);
          await replacement.init();
          manager.sessions.set(sessionId, replacement);
        });
        if (operation === 'reopen') {
          expect(await manager.getOrCreateSessionDoc(sessionId)).toBe(replacement);
        } else {
          await manager.cleanSessionDoc(sessionId);
        }
        expect(manager.sessions.get(sessionId)).toBe(replacement);
        expect(replacement.isDestroyed).toBe(false);
        expect(replacement.mirror).not.toBeNull();
      } finally {
        await harness.dispose();
      }
    }
  );

  it('propagates destruction failure after awaiting a pending initialization', async () => {
    const harness = await createHarness();
    const { manager } = harness;
    const sessionId = 'pending-cleanup-failure' as SessionId;
    const entered = createDeferred();
    const release = createDeferred();
    const originalInit = SessionDocument.prototype.init;
    const init = vi.spyOn(SessionDocument.prototype, 'init').mockImplementationOnce(async function (
      this: SessionDocument
    ) {
      await originalInit.call(this);
      entered.resolve();
      await release.promise;
    });
    const unload = vi
      .spyOn(manager.repo, 'unloadDoc')
      .mockRejectedValueOnce(new Error('pending unload failed'));
    try {
      const opening = manager.getOrCreateSessionDoc(sessionId);
      await entered.promise;
      const cleanup = manager.cleanSessionDoc(sessionId);
      const rejected = expect(cleanup).rejects.toThrow('pending unload failed');
      release.resolve();
      const stale = await opening;
      await rejected;
      expect(stale.isDestroyed).toBe(true);
      expect(manager.sessions.get(sessionId)).toBe(stale);
      const fresh = await manager.getOrCreateSessionDoc(sessionId);
      expect(fresh).not.toBe(stale);
      expect(fresh.isDestroyed).toBe(false);
    } finally {
      release.resolve();
      init.mockRestore();
      unload.mockRestore();
      await harness.dispose();
    }
  });
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
