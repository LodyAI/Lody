import { parentPort } from 'node:worker_threads';

import type { TurnDiffWorkerRequest, TurnDiffWorkerResponse } from './protocol';
import { SqliteTurnDiffStore, type TurnDiffGcCursor } from './sqlite-store';

export function runTurnDiffStoreWorker(): void {
  if (parentPort === null) {
    throw new Error('Turn-diff store worker must run inside a Node.js Worker.');
  }
  const port = parentPort;
  let store: SqliteTurnDiffStore | undefined;
  let gcScheduled = false;
  let gcRequested = false;
  let gcCursor: TurnDiffGcCursor | undefined;
  let gcRunId = 0;
  let gcNowMs = 0;

  const cancelScheduledGc = (): void => {
    gcRunId += 1;
    gcScheduled = false;
    gcRequested = false;
    gcCursor = undefined;
  };

  const scheduleGc = (nowMs: number): void => {
    if (store === undefined) return;
    gcNowMs = Math.max(gcNowMs, nowMs);
    if (gcScheduled) {
      gcRequested = true;
      return;
    }
    gcScheduled = true;
    gcRequested = false;
    const runId = ++gcRunId;
    const runStep = (): void => {
      if (runId !== gcRunId || store === undefined) return;
      try {
        gcCursor ??= store.beginGc(gcNowMs);
        const result = store.gcStep(gcCursor);
        if (result === null) {
          setImmediate(runStep);
          return;
        }
        // A completed pass can legitimately stop above the cap when the newest
        // turn/heads are the live-data floor. Only work requested while this pass
        // was running should start another pass; a later record will request GC again.
        const shouldRunAgain = gcRequested;
        gcScheduled = false;
        gcRequested = false;
        gcCursor = undefined;
        port.postMessage({ id: 0, backgroundGc: result } satisfies TurnDiffWorkerResponse);
        if (shouldRunAgain) scheduleGc(gcNowMs);
      } catch (error) {
        gcScheduled = false;
        gcRequested = false;
        gcCursor = undefined;
        port.postMessage({
          id: 0,
          backgroundError: formatError(error),
        } satisfies TurnDiffWorkerResponse);
      }
    };
    setImmediate(runStep);
  };

  port.on('message', (request: TurnDiffWorkerRequest) => {
    try {
      if (request.kind === 'init') {
        if (store !== undefined) throw new Error('Turn-diff store worker is already initialized.');
        store = new SqliteTurnDiffStore(request.options);
        const shouldRunGc = store.shouldRunGc(request.nowMs);
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: null,
        } satisfies TurnDiffWorkerResponse);
        if (shouldRunGc) scheduleGc(request.nowMs);
        return;
      }
      if (store === undefined) throw new Error('Turn-diff store worker is not initialized.');

      if (request.kind === 'allocate-head-proof') {
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.allocateHeadProof(),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'record') {
        const result = store.recordTurn(request.input);
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result,
        } satisfies TurnDiffWorkerResponse);
        if (result.gcScheduled) {
          scheduleGc(request.input.recordedAtMs);
        }
        return;
      }
      if (request.kind === 'list-changed-paths') {
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.listChangedPaths(request.input),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'snapshot-descriptor') {
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.getSnapshotDescriptor(request.input),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'snapshot-bytes') {
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.getSnapshotBytes(request.input),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'earliest-old') {
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.getEarliestOldSnapshot(request.input),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'turn-snapshot') {
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.getTurnSnapshot(request.input),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'latest-text') {
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.getLatestText(request.input),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'list-turn-files') {
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.listTurnFiles(request.input),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'gc') {
        cancelScheduledGc();
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.gc(request.nowMs),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'stats') {
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: store.stats(),
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      if (request.kind === 'close') {
        cancelScheduledGc();
        store.close();
        store = undefined;
        port.postMessage({
          id: request.id,
          kind: request.kind,
          result: null,
        } satisfies TurnDiffWorkerResponse);
        return;
      }
      assertNever(request);
    } catch (error) {
      port.postMessage({
        id: request.id,
        kind: request.kind,
        error: formatError(error),
      } satisfies TurnDiffWorkerResponse);
    }
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled turn-diff worker request: ${JSON.stringify(value)}`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
