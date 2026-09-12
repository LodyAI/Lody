import { withHistoryPort } from './history-port-fixture';
/**
 * Regression tests for review finding F1 (2026-07-04, S5/D10 撤权不上传).
 *
 * `backfillSessionFileOnce` (apps/cli/src/lib/message-handler.ts) used to check
 * backfill authorization only once, at entry. If access was revoked while
 * `uploadValidatedSessionFile` was in flight, the resumed task still wrote the
 * `.r2meta` marker, flipped the persisted history block `local -> r2`, and moved
 * the blob to `_backfilled` — i.e. a revoked workspace's offline bytes landed in
 * R2 as if sanctioned.
 *
 * The fix models backfill authorization as a generation + AbortController owned
 * by MessageHandler: `disableRemoteBackfill` (what
 * `MachineRuntime.handleRemoteAccessRevoked` calls) aborts the in-flight upload
 * and supersedes the task's generation, so no commit step (marker, flip,
 * finalize) can run post-revoke; a later re-enable opens a new generation and
 * the pending blob backfills cleanly on the next scan.
 *
 * These tests drive the REAL code path: real MessageHandler, real blob store on
 * a temp homedir, real scan/enqueue/backfill orchestration. Only the private
 * network upload (`uploadValidatedSessionFile`) is stubbed, hung behind a
 * deferred so the revoke can be interleaved exactly inside the upload await.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistoryInput, SessionId, WorkspaceId } from '@lody/shared';
import { createTestCloudPort } from './test-cloud-port';

import { MessageHandler } from '../src/lib/message-handler';
import {
  readSessionFileBlobBackfillMarker,
  copyIntoSessionFileBlobStore,
  sessionFileBlobExists,
} from '../src/lib/session-file-blob-store';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  setDebug: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('F1 regression: revoke during in-flight backfill upload (S5/D10)', () => {
  const workspaceId = 'workspace-1' as WorkspaceId;
  const sessionId = 'session-revoke-repro' as SessionId;
  const fileId = 'file-local-1';

  let fakeHome: string;
  let sourceDir: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-backfill-revoke-home-'));
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-backfill-revoke-src-'));
    // The handler calls the blob store without a homeDir override, so redirect
    // os.homedir() for the whole test (blob store resolves it per call).
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  /** Real handler + one pending-local blob whose history block is persisted. */
  const createHarness = async () => {
    const fileBytes = new TextEncoder().encode('offline secret notes\n');
    const sourcePath = path.join(sourceDir, 'notes.txt');
    fs.writeFileSync(sourcePath, fileBytes);
    await copyIntoSessionFileBlobStore({ workspaceId, sessionId, fileId, sourcePath });

    const fileBlock = {
      type: 'file',
      fileId,
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: fileBytes.byteLength,
      sha256: sha256Hex(fileBytes),
      textPreview: true,
      transport: 'local',
      machineId: 'machine-1',
      uploadedAt: 123,
    };
    let history = [
      {
        id: 'turn-1',
        role: 'user',
        items: [fileBlock],
        timestamp: new Date().toISOString(),
      },
    ] as unknown as SessionHistoryInput[];

    const sessionDoc = withHistoryPort({
      getHistory: async () => history,
      updateHistory: async (updater: (current: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        history = updater(history);
      },
    });

    const sessionManager = {
      getSession: vi.fn(() => undefined),
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      cleanUp: vi.fn(async () => {}),
    } as unknown as SessionManager;
    const workspaceDocument = {
      repo: {
        getDocMeta: vi.fn(async () => ({ meta: {} })),
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      sendMachineHeartbeat: vi.fn(async () => {}),
    } as unknown as LoroDocumentManager;

    const handler = new MessageHandler(sessionManager, workspaceDocument, createSilentLogger(), {
      token: 'token',
      workspaceId,
      userId: 'user-1',
      machineId: 'machine-1',
      machineName: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    });

    // Stub ONLY the network upload; everything around it (marker, flip,
    // finalize, generation guard) is the real message-handler code under test.
    const uploadStarted = deferred<void>();
    const uploadGate = deferred<void>();
    let uploadCalls = 0;
    let firstUploadSignal: AbortSignal | undefined;
    (
      handler as unknown as {
        uploadValidatedSessionFile: (args: { signal?: AbortSignal }) => Promise<{
          fileId: string;
        }>;
      }
    ).uploadValidatedSessionFile = async (args) => {
      uploadCalls += 1;
      if (uploadCalls === 1) {
        firstUploadSignal = args.signal;
        uploadStarted.resolve();
        await uploadGate.promise;
        return { fileId: 'file-relay-1' };
      }
      return { fileId: `file-relay-${uploadCalls}` };
    };
    const inFlight = (handler as unknown as { sessionFileBackfillInFlight: Set<string> })
      .sessionFileBackfillInFlight;

    return withHistoryPort({
      handler,
      uploadStarted,
      uploadGate,
      inFlight,
      getHistory: () => history,
      getUploadCalls: () => uploadCalls,
      getFirstUploadSignal: () => firstUploadSignal,
    });
  };

  const firstItem = (history: SessionHistoryInput[]) =>
    ((history[0]?.items ?? []) as Array<{ type?: string; transport?: string; fileId?: string }>)[0];

  it('F1: a revoke landing while the R2 upload is in flight must not flip history, write the marker, or finalize the blob', async () => {
    const harness = await createHarness();
    const { handler } = harness;

    try {
      // Bridge attaches -> scan finds the pending blob -> backfill starts and
      // blocks inside the upload.
      await handler.enableRemoteBackfillAndScan();
      await harness.uploadStarted.promise;

      // Revoke lands while the upload is in flight. This is the exact seam
      // MachineRuntime.handleRemoteAccessRevoked drives (machine-runtime.ts).
      handler.disableRemoteBackfill();
      // The revoke must cancel the in-flight relay upload.
      expect(harness.getFirstUploadSignal()?.aborted).toBe(true);

      // Worst case: the upload resolves anyway (abort raced completion).
      harness.uploadGate.resolve();
      await vi.waitFor(() => expect(harness.inFlight.size).toBe(0), { timeout: 10_000 });

      const blobArgs = { workspaceId, sessionId, fileId };
      // 1. The persisted block must still be pending-local, not adopted as r2.
      expect(firstItem(harness.sessionData.history.readAll())).toMatchObject({
        type: 'file',
        transport: 'local',
        fileId,
      });
      // 2. No `.r2meta` marker may record the (unsanctioned) relay upload.
      expect(await readSessionFileBlobBackfillMarker(blobArgs)).toBeNull();
      // 3. The blob must remain pending (not moved to `_backfilled`).
      expect(await sessionFileBlobExists(blobArgs)).toBe(true);
    } finally {
      await handler.cleanup();
    }
  });

  it('F1 recovery: after a revoke mid-upload, a re-enable backfills the blob cleanly on the next scan', async () => {
    const harness = await createHarness();
    const { handler } = harness;

    try {
      await handler.enableRemoteBackfillAndScan();
      await harness.uploadStarted.promise;

      handler.disableRemoteBackfill();
      harness.uploadGate.resolve();
      await vi.waitFor(() => expect(harness.inFlight.size).toBe(0), { timeout: 10_000 });

      // Access restored: the remote bridge re-attaches and re-enables backfill.
      // The pending blob must backfill under the new authorization generation.
      await handler.enableRemoteBackfillAndScan();
      await vi.waitFor(
        () =>
          expect(firstItem(harness.sessionData.history.readAll())).toMatchObject({
            transport: 'r2',
          }),
        { timeout: 10_000 }
      );

      expect(harness.getUploadCalls()).toBeGreaterThanOrEqual(2);
      // The adopted key comes from the sanctioned (post-re-enable) upload.
      expect(firstItem(harness.sessionData.history.readAll())).toMatchObject({
        type: 'file',
        transport: 'r2',
        fileId: `file-relay-${harness.getUploadCalls()}`,
      });
      const blobArgs = { workspaceId, sessionId, fileId };
      await vi.waitFor(async () => {
        // Finalized: blob moved out of pending, marker cleaned up.
        expect(await sessionFileBlobExists(blobArgs)).toBe(false);
        expect(await readSessionFileBlobBackfillMarker(blobArgs)).toBeNull();
      });
    } finally {
      await handler.cleanup();
    }
  });
});
