import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CodeCollabV2AllChangesState,
  CodeCollabV2FileTreeState,
  SessionId,
} from '@lody/shared';
import {
  CodeCollabV2Service,
  type CodeCollabV2FileIndexPublication,
} from './code-collab-v2-service';

type TestOwnerState = {
  readonly fileTree: CodeCollabV2FileTreeState;
  readonly allChanges: CodeCollabV2AllChangesState;
};

type TestServiceApi = {
  readonly stateByOwnerSessionId: Map<SessionId, TestOwnerState>;
  readonly publishOwnerState: (
    ownerSessionId: SessionId,
    state: TestOwnerState,
    options?: {
      readonly forcePublish?: boolean;
      readonly persistAllChangesDiffStats?: boolean;
    }
  ) => Promise<void>;
};

const OWNER_A = 'owner-a' as SessionId;
const OWNER_B = 'owner-b' as SessionId;

const createOwnerState = (workspacePath: string): TestOwnerState => ({
  fileTree: { [workspacePath]: true },
  allChanges: {},
});

const deferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const getTestApi = (service: CodeCollabV2Service): TestServiceApi =>
  service as unknown as TestServiceApi;

describe('CodeCollabV2Service targeted file-index repair', () => {
  const services: CodeCollabV2Service[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const service of services) {
      service.dispose();
    }
    services.length = 0;
    vi.useRealTimers();
  });

  const createService = (options: {
    readonly taskTimeoutMs?: number;
    readonly publishFileIndex: (
      publication: CodeCollabV2FileIndexPublication
    ) => Promise<{ changed: boolean }>;
    readonly publishFileIndexSignal?: (publication: {
      readonly ownerSessionId: SessionId;
      readonly updatedAtMs: number;
    }) => Promise<void>;
  }): CodeCollabV2Service => {
    const service = new CodeCollabV2Service({
      resolveWorkspace: async () => ({
        ok: false,
        code: 'session_not_found',
        message: 'unused',
      }),
      publishFileIndex: options.publishFileIndex,
      taskTimeoutMs: options.taskTimeoutMs,
      publishFileIndexSignal: options.publishFileIndexSignal,
      fileIndexRepairBaseDelayMs: 1_000,
      fileIndexRepairMaxDelayMs: 30_000,
      fileIndexRepairRandom: () => 0.5,
    });
    services.push(service);
    return service;
  };

  const seedOwner = (
    service: CodeCollabV2Service,
    ownerSessionId: SessionId,
    workspacePath: string
  ): TestOwnerState => {
    const state = createOwnerState(workspacePath);
    getTestApi(service).stateByOwnerSessionId.set(ownerSessionId, state);
    return state;
  };

  const publishOwner = async (
    service: CodeCollabV2Service,
    ownerSessionId: SessionId,
    state: TestOwnerState
  ): Promise<void> => {
    await getTestApi(service).publishOwnerState(ownerSessionId, state);
  };

  it('aborts a timed-out publication, admits a newer snapshot and preserves late failure observation', async () => {
    const started = deferred();
    let rejectOld: (error: Error) => void = () => {};
    let oldSignal: AbortSignal | undefined;
    const published: string[][] = [];
    let first = true;
    const service = createService({
      taskTimeoutMs: 100,
      publishFileIndex: async (publication) => {
        if (first) {
          first = false;
          oldSignal = publication.signal;
          started.resolve();
          await new Promise<void>((_resolve, reject) => {
            rejectOld = reject;
          });
        }
        publication.signal?.throwIfAborted();
        published.push(Object.keys(publication.fileIndex));
        return { changed: true };
      },
    });
    const state = seedOwner(service, OWNER_A, 'old.ts');
    const timedOut = expect(publishOwner(service, OWNER_A, state)).rejects.toThrow(
      'exceeded 100ms'
    );
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    expect(oldSignal?.aborted).toBe(true);
    delete state.fileTree['old.ts'];
    state.fileTree['new.ts'] = true;
    await publishOwner(service, OWNER_A, state);
    rejectOld(new Error('Late old transport failure'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(published).toEqual([['new.ts']]);
  });

  it('cancels active publication on disposal without publishing a late snapshot or scheduling repair', async () => {
    const started = deferred();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const published: string[][] = [];
    const service = createService({
      publishFileIndex: async (publication) => {
        signal = publication.signal;
        started.resolve();
        await gate.promise;
        publication.signal?.throwIfAborted();
        published.push(Object.keys(publication.fileIndex));
        return { changed: true };
      },
    });
    const state = seedOwner(service, OWNER_A, 'old.ts');
    const cancelled = expect(publishOwner(service, OWNER_A, state)).rejects.toThrow('cancelled');
    await started.promise;
    service.dispose();
    await cancelled;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(true);
    expect(published).toEqual([]);
  });
});
