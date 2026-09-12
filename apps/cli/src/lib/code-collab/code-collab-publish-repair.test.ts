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
import { CodeCollabFileIndexChangedPublishError } from './code-collab-flock-publish';

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

  it('reconciles remote state only on initial activation and repair', async () => {
    const publications: CodeCollabV2FileIndexPublication[] = [];
    const service = createService({
      publishFileIndex: async (publication) => {
        publications.push(publication);
        return { changed: true };
      },
    });
    const state = seedOwner(service, OWNER_A, 'one.ts');

    await publishOwner(service, OWNER_A, state);
    state.fileTree['two.ts'] = true;
    await publishOwner(service, OWNER_A, state);

    expect(publications.map((publication) => publication.reconcileRemote)).toEqual([true, false]);
  });

  it('retries only the owner whose publication failed', async () => {
    const publications: CodeCollabV2FileIndexPublication[] = [];
    let ownerBAttempts = 0;
    const service = createService({
      publishFileIndex: async (publication) => {
        publications.push(publication);
        if (publication.ownerSessionId === OWNER_B && ownerBAttempts++ === 0) {
          throw new Error('transport failed');
        }
        return { changed: true };
      },
    });
    const ownerAState = seedOwner(service, OWNER_A, 'a.ts');
    const ownerBState = seedOwner(service, OWNER_B, 'b.ts');

    await publishOwner(service, OWNER_A, ownerAState);
    await expect(publishOwner(service, OWNER_B, ownerBState)).rejects.toThrow('transport failed');

    await vi.advanceTimersByTimeAsync(999);
    expect(publications.map((publication) => publication.ownerSessionId)).toEqual([
      OWNER_A,
      OWNER_B,
    ]);

    await vi.advanceTimersByTimeAsync(1);
    expect(publications.map((publication) => publication.ownerSessionId)).toEqual([
      OWNER_A,
      OWNER_B,
      OWNER_B,
    ]);
    expect(publications.at(-1)?.reconcileRemote).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(publications).toHaveLength(3);
  });

  it('backs off repeated repair failures exponentially', async () => {
    const publishFileIndex = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValue({ changed: true });
    const service = createService({ publishFileIndex });
    const state = seedOwner(service, OWNER_A, 'retry.ts');

    await expect(publishOwner(service, OWNER_A, state)).rejects.toThrow('first failure');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(publishFileIndex).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(publishFileIndex).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(publishFileIndex).toHaveBeenCalledTimes(3);
  });

  it('retries the signal after a changed file index fails post-sync', async () => {
    const publishFileIndex = vi
      .fn()
      .mockRejectedValueOnce(
        new CodeCollabFileIndexChangedPublishError(new Error('post-sync failed'))
      )
      .mockResolvedValue({ changed: false });
    const publishFileIndexSignal = vi.fn(async () => {});
    const service = createService({ publishFileIndex, publishFileIndexSignal });
    const state = seedOwner(service, OWNER_A, 'partial.ts');

    await expect(publishOwner(service, OWNER_A, state)).rejects.toBeInstanceOf(
      CodeCollabFileIndexChangedPublishError
    );
    expect(publishFileIndexSignal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(publishFileIndex).toHaveBeenCalledTimes(2);
    expect(publishFileIndexSignal).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending repair after a newer publication succeeds or the service is disposed', async () => {
    const publishFileIndex = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport failed'))
      .mockResolvedValue({ changed: true });
    const service = createService({ publishFileIndex });
    const state = seedOwner(service, OWNER_A, 'latest.ts');

    await expect(publishOwner(service, OWNER_A, state)).rejects.toThrow('transport failed');
    await publishOwner(service, OWNER_A, state);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(publishFileIndex).toHaveBeenCalledTimes(2);

    publishFileIndex.mockRejectedValueOnce(new Error('transport failed again'));
    state.fileTree['newer.ts'] = true;
    await expect(publishOwner(service, OWNER_A, state)).rejects.toThrow('transport failed again');
    service.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(publishFileIndex).toHaveBeenCalledTimes(3);
  });

  it('drops a queued repair when a newer in-flight publication succeeds first', async () => {
    const newerStarted = deferred();
    const releaseNewer = deferred();
    const publishFileIndex = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport failed'))
      .mockImplementationOnce(async () => {
        newerStarted.resolve();
        await releaseNewer.promise;
        return { changed: true };
      })
      .mockResolvedValue({ changed: true });
    const service = createService({ publishFileIndex });
    const state = seedOwner(service, OWNER_A, 'queued.ts');

    await expect(publishOwner(service, OWNER_A, state)).rejects.toThrow('transport failed');
    const newerPublication = publishOwner(service, OWNER_A, state);
    await newerStarted.promise;

    await vi.advanceTimersByTimeAsync(1_000);
    releaseNewer.resolve();
    await newerPublication;
    await vi.advanceTimersByTimeAsync(0);

    expect(publishFileIndex).toHaveBeenCalledTimes(2);
  });
});
