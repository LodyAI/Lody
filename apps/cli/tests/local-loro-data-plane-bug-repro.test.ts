/**
 * Regression test for finding F6 of the 2026-07-04 adversarial review of the
 * local Loro data plane.
 *
 * R4 (docs/local-first-refactor/04-review-remediation.md) requires that an
 * oversized payload yield "一个明确的终态错误（而不是无限失败轮询…）" so the UI
 * can degrade per-room — the wall must not take down the whole data plane.
 * Protocol v2 destroyed the socket on a >32MB frame, killing every room of
 * every window multiplexed over the shared Electron-relay connection (and,
 * with review finding F4, nothing ever re-dialed). Protocol v3 enforces the
 * frame budget at the SENDER (oversized sync payloads become terminal
 * room-scoped errors and are never written); the receiver-side splitter cap is
 * defense-in-depth that discards the offending frame, answers with a protocol
 * error, and keeps the connection alive.
 *
 * The test drives the REAL net socket server with a deliberately non-compliant
 * oversized frame and asserts the connection survives: a follow-up join on the
 * same socket must still receive 'joined'.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  createJsonLineSplitter,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  type LocalLoroDataPlaneServerMessage,
} from '@lody/shared/local-loro-data-plane';
import { LocalLoroDataPlaneServer } from '@lody/shared/local-loro-data-plane-server';
import { getLocalLoroDataPlaneSocketPath } from '@lody/shared/node/local-ipc';
import {
  startLocalLoroDataPlaneServer,
  stopLocalLoroDataPlaneServer,
} from '../src/lib/local-loro-data-plane-server';
import type { Logger } from '../src/utils/logger';

const logger: Logger = {
  debug: vi.fn(),
  trace: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  setLevel: vi.fn(),
  setDebug: vi.fn(),
  child: vi.fn(() => logger),
  close: vi.fn(async () => {}),
} as unknown as Logger;

const WORKSPACE_ID = 'ws-f6';
const TEST_MAX_FRAME_BYTES = 64 * 1024;

// The socket path is derived from os.homedir(); redirect
// HOME to a temp dir so the test can never collide with a real running daemon.
let tempHome: string | null = null;
let originalHome: string | undefined;
let originalPlatform: string | undefined;
let originalDataDir: string | undefined;

class SocketClient {
  readonly messages: LocalLoroDataPlaneServerMessage[] = [];
  readonly closed: Promise<void>;
  private readonly waiters = new Set<() => void>();

  constructor(readonly socket: net.Socket) {
    const splitLines = createJsonLineSplitter({
      onLine: (line) => {
        this.messages.push(JSON.parse(line) as LocalLoroDataPlaneServerMessage);
        for (const waiter of [...this.waiters]) waiter();
      },
    });
    socket.on('data', (chunk) => splitLines(chunk));
    // Swallow EPIPE etc. from writes racing the server-side destroy.
    socket.on('error', () => {});
    this.closed = new Promise<void>((resolve) => {
      socket.on('close', () => {
        for (const waiter of [...this.waiters]) waiter();
        resolve();
      });
    });
  }

  onActivity(waiter: () => void): () => void {
    this.waiters.add(waiter);
    return () => this.waiters.delete(waiter);
  }

  async writeLine(line: string): Promise<void> {
    await this.writeRaw(`${line}\n`);
  }

  async writeRaw(data: string): Promise<void> {
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const flushed = this.socket.write(data, () => resolve());
      if (!flushed) this.socket.once('drain', () => resolve());
    });
  }

  /** Resolves 'joined' | 'error' (matching requestId) | 'socket-closed' | 'timeout'. */
  async outcomeForRequest(
    requestId: string,
    timeoutMs: number
  ): Promise<'joined' | 'error' | 'socket-closed' | 'timeout'> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = this.messages.find(
        (message) =>
          (message.type === 'joined' || message.type === 'error') &&
          'requestId' in message &&
          message.requestId === requestId
      );
      if (match) return match.type as 'joined' | 'error';
      if (this.socket.destroyed) return 'socket-closed';
      if (Date.now() > deadline) return 'timeout';
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        const off = this.onActivity(() => {
          clearTimeout(timer);
          off();
          resolve();
        });
      });
    }
  }
}

function joinLine(requestId: string, docId: string): string {
  return JSON.stringify({
    type: 'join',
    protocolVersion: LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
    requestId,
    workspaceId: WORKSPACE_ID,
    peerId: 'renderer:f6',
    room: { scope: 'doc', docId },
  });
}

describe('local Loro data-plane socket server — F6 regression', () => {
  beforeAll(async () => {
    originalHome = process.env.HOME;
    originalPlatform = process.env.LODY_PLATFORM;
    originalDataDir = process.env.LODY_DATA_DIR;
    // macOS exposes os.tmpdir() as a long /var/folders path. Keep the test's
    // Unix socket below sockaddr_un's 104-byte path limit, like the CI runner's
    // /tmp, while retaining the platform temp directory on Windows.
    const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    tempHome = fs.mkdtempSync(path.join(tempRoot, 'lody-dp-f6-'));
    process.env.HOME = tempHome;
    process.env.LODY_PLATFORM = 'local';
    delete process.env.LODY_DATA_DIR;
    fs.mkdirSync(path.dirname(getLocalLoroDataPlaneSocketPath()), { recursive: true });

    const docs = new Map<string, LoroDoc>();
    const engine = new LocalLoroDataPlaneServer({
      workspaceId: WORKSPACE_ID,
      resolveDoc: async (docId) => {
        const existing = docs.get(docId);
        if (existing) return existing;
        const doc = new LoroDoc();
        docs.set(docId, doc);
        return doc;
      },
      resolveFlockDoc: async () => {
        throw new Error('not used');
      },
    });
    await startLocalLoroDataPlaneServer({
      logger,
      getWorkspaceServer: (workspaceId) => (workspaceId === WORKSPACE_ID ? engine : null),
      maxFrameBytes: TEST_MAX_FRAME_BYTES,
    });
  });

  afterAll(async () => {
    await stopLocalLoroDataPlaneServer();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPlatform === undefined) delete process.env.LODY_PLATFORM;
    else process.env.LODY_PLATFORM = originalPlatform;
    if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
    else process.env.LODY_DATA_DIR = originalDataDir;
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it(
    'F6: an oversized frame must produce a room-scoped terminal error, not kill the whole connection',
    { timeout: 30_000 },
    async () => {
      const socketPath = getLocalLoroDataPlaneSocketPath();
      const socket = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });
      const client = new SocketClient(socket);

      // Healthy baseline: a normal join round-trips on this connection.
      await client.writeLine(joinLine('join-1', 'doc-1'));
      expect(await client.outcomeForRequest('join-1', 5_000)).toBe('joined');

      // A frame over the injected test limit from a NON-COMPLIANT sender. The
      // production limit remains 32MB; lowering it here exercises the same
      // splitter overflow and real socket behavior without allocating/writing
      // 33MB. The bytes never reach JSON parsing, so placeholder base64 is
      // sufficient and faithful.
      const prefix =
        `{"type":"update","protocolVersion":${LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION},` +
        `"workspaceId":"${WORKSPACE_ID}","peerId":"renderer:f6",` +
        `"room":{"scope":"doc","docId":"doc-1"},` +
        `"payload":{"kind":"doc-update","dataBase64":"`;
      await client.writeRaw(prefix);
      await client.writeRaw('A'.repeat(TEST_MAX_FRAME_BYTES));
      await client.writeRaw('"}}\n');

      await vi.waitFor(
        () => {
          expect(client.messages).toContainEqual(
            expect.objectContaining({ type: 'error', code: 'payload_too_large' })
          );
        },
        { timeout: 5_000 }
      );

      // R4-required behavior: the connection survives the oversized frame (the
      // splitter discards it and the server answers with a protocol error), so
      // an unrelated join on the same shared connection still succeeds.
      await client.writeLine(joinLine('join-2', 'doc-2'));
      const outcome = await client.outcomeForRequest('join-2', 5_000);
      expect(outcome).toBe('joined');

      socket.destroy();
    }
  );
});
