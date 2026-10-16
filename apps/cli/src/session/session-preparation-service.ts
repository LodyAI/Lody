import { makePreparationControlLegacy } from './preparation-control';
import type { SessionId } from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';

export type SessionPreparationState =
  | 'preparing'
  | 'initialized'
  | 'session-ready'
  | 'claimed'
  | 'expired'
  | 'failed';

export interface SessionPreparationResource {
  initialized: Promise<void>;
  sessionReady: Promise<void>;
  /** Starts side effects only after the resource is synchronously claimable. */
  start?(): void;
  dispose(): Promise<void>;
}

/**
 * Creation may reject normally only after releasing all partially acquired resources.
 * `retry` repeats that release over whatever the failed attempt still holds.
 */
export class SessionPreparationCleanupError extends Error {
  readonly retry: (() => Promise<void>) | undefined;
  constructor(cause: unknown, retry?: () => Promise<void>) {
    super(`Session preparation cleanup failed: ${formatErrorMessage(cause)}`, { cause });
    this.name = 'SessionPreparationCleanupError';
    this.retry = retry;
  }
}

/**
 * One retirement. Its failure keeps fencing same-session replacement, but the
 * next caller retries it instead of receiving the stale rejection: a tree that
 * outlived one termination is usually gone, or killable, a turn later.
 */
class Retirement {
  private attempt: Promise<void> | null = null;
  private failed = false;
  constructor(private readonly release: () => Promise<void>) {}

  run(): Promise<void> {
    if (this.attempt && !this.failed) return this.attempt;
    this.failed = false;
    const attempt = Promise.resolve().then(this.release);
    this.attempt = attempt;
    // Registered before any caller's handler, so a caller that observes the
    // rejection and asks again always starts a new attempt.
    attempt.catch(() => {
      if (this.attempt === attempt) this.failed = true;
    });
    return attempt;
  }
}

export type SessionPreparationStartDisposition = 'accepted' | 'duplicate' | 'replaced' | 'busy';

type LoggerLike = {
  debug(message: string): void;
};

type PreparationRecord<T extends SessionPreparationResource> = {
  preparationId: string;
  sessionId: SessionId;
  requesterUserId: string;
  requestKey: string;
  claimKey: string;
  state: SessionPreparationState;
  abortController: AbortController;
  control: ReturnType<typeof makePreparationControlLegacy>;
  resource?: T;
  resourcePromise: Promise<T>;
  cleanupPromise?: Promise<void>;
  retirement?: Retirement;
  /** Creation's own rollback failure, already reported once and retried after. */
  rollbackFailure?: SessionPreparationCleanupError;
};

/** Why a claim fell back to a cold start; `absent` means nothing was prepared. */
export type SessionPreparationMissReason =
  | 'absent'
  | 'requester'
  | 'claim-key'
  | 'not-ready'
  | 'incompatible'
  | 'compatibility-error';

export type SessionPreparationClaimResult<T extends SessionPreparationResource> =
  | { status: 'claimed'; resource: T }
  | { status: 'miss'; reason: SessionPreparationMissReason; cleanup: Promise<void> | null };

export class SessionPreparationService<T extends SessionPreparationResource> {
  private readonly records = new Map<SessionId, PreparationRecord<T>>();
  private readonly retiring = new Map<SessionId, Retirement>();

  constructor(
    private readonly logger: LoggerLike,
    private readonly options: {
      hardTtlMs: number;
      maxConcurrent: number;
    }
  ) {}

  start(args: {
    preparationId: string;
    sessionId: SessionId;
    requesterUserId: string;
    requestKey: string;
    claimKey?: string;
    create: (signal: AbortSignal) => Promise<T>;
  }): SessionPreparationStartDisposition {
    const current = this.records.get(args.sessionId);
    if (
      current?.preparationId === args.preparationId &&
      current.requesterUserId === args.requesterUserId &&
      current.requestKey === args.requestKey
    ) {
      return 'duplicate';
    }

    if (current && current.requesterUserId !== args.requesterUserId) return 'busy';

    let disposition: SessionPreparationStartDisposition = 'accepted';
    let predecessorCleanup = this.retirementOf(args.sessionId);
    const requesterRecord = Array.from(this.records.values()).find(
      (record) => record.requesterUserId === args.requesterUserId
    );
    if (requesterRecord) {
      predecessorCleanup = Promise.all([
        predecessorCleanup,
        this.expire(requesterRecord, 'expired'),
      ]).then(() => undefined);
      disposition = 'replaced';
    } else if (this.records.size >= Math.max(1, this.options.maxConcurrent)) {
      return 'busy';
    }

    const abortController = new AbortController();
    const record = {} as PreparationRecord<T>;
    record.preparationId = args.preparationId;
    record.sessionId = args.sessionId;
    record.requesterUserId = args.requesterUserId;
    record.requestKey = args.requestKey;
    record.claimKey = args.claimKey ?? args.requestKey;
    record.state = 'preparing';
    record.abortController = abortController;
    record.control = makePreparationControlLegacy(this.options.hardTtlMs, () => {
      if (this.records.get(args.sessionId) === record) {
        this.logger.debug(
          `[${args.sessionId}] Session preparation ${args.preparationId} reached its hard TTL`
        );
        void this.expire(record, 'expired');
      }
    });
    record.resourcePromise = Promise.resolve().then(async () => {
      await predecessorCleanup;
      abortController.signal.throwIfAborted();
      return await args.create(abortController.signal);
    });
    this.records.set(args.sessionId, record);

    void record.resourcePromise.then(
      (resource) => {
        record.resource = resource;
        void resource.initialized.then(
          () => this.advance(record, 'initialized'),
          (error) => this.fail(record, error)
        );
        void resource.sessionReady.then(
          () => this.advance(record, 'session-ready'),
          (error) => this.fail(record, error)
        );
        if (record.state === 'expired' || record.state === 'failed') {
          void this.scheduleCleanup(record, resource);
          return;
        }
        try {
          resource.start?.();
        } catch (error) {
          this.fail(record, error);
          return;
        }
      },
      (error) => this.fail(record, error)
    );

    return disposition;
  }

  cancel(args: {
    preparationId: string;
    sessionId: SessionId;
    requesterUserId: string;
  }): 'cancelled' | 'not-found' | 'not-owned' {
    const record = this.records.get(args.sessionId);
    if (!record) {
      return 'not-found';
    }
    if (record.requesterUserId !== args.requesterUserId) {
      return 'not-owned';
    }
    if (record.preparationId !== args.preparationId) {
      return 'not-found';
    }
    void this.expire(record, 'expired');
    return 'cancelled';
  }

  discard(sessionId: SessionId): Promise<void> | null {
    const record = this.records.get(sessionId);
    if (!record) return this.retirementOf(sessionId);
    return this.expire(record, 'expired');
  }

  peek(args: { sessionId: SessionId; requesterUserId: string; claimKey: string }): T | null {
    const record = this.records.get(args.sessionId);
    if (
      !record ||
      record.requesterUserId !== args.requesterUserId ||
      record.claimKey !== args.claimKey
    ) {
      return null;
    }
    return record.resource ?? null;
  }

  claim(args: {
    sessionId: SessionId;
    requesterUserId: string;
    claimKey: string;
    isCompatible: (resource: T) => boolean;
  }): SessionPreparationClaimResult<T> {
    const record = this.records.get(args.sessionId);
    if (!record) {
      return { status: 'miss', reason: 'absent', cleanup: this.retirementOf(args.sessionId) };
    }
    const miss = (reason: SessionPreparationMissReason): SessionPreparationClaimResult<T> => ({
      status: 'miss',
      reason,
      cleanup: this.expire(record, 'expired'),
    });
    if (record.requesterUserId !== args.requesterUserId) return miss('requester');
    if (record.claimKey !== args.claimKey) return miss('claim-key');
    if (!record.resource) return miss('not-ready');

    try {
      if (!args.isCompatible(record.resource)) return miss('incompatible');
    } catch (error) {
      this.logger.debug(
        `[${record.sessionId}] Session preparation claim fell back to cold start: ${formatErrorMessage(error)}`
      );
      return miss('compatibility-error');
    }

    record.state = 'claimed';
    this.records.delete(record.sessionId);
    void record.control.close();
    return { status: 'claimed', resource: record.resource };
  }

  getState(sessionId: SessionId): SessionPreparationState | null {
    return this.records.get(sessionId)?.state ?? null;
  }

  async disposeAll(): Promise<void> {
    const records = Array.from(this.records.values());
    for (const record of records) {
      void this.expire(record, 'expired');
    }
    await Promise.allSettled(Array.from(this.retiring.values(), (retirement) => retirement.run()));
  }

  private advance(record: PreparationRecord<T>, state: 'initialized' | 'session-ready'): void {
    if (this.records.get(record.sessionId) !== record || record.state === 'claimed') {
      return;
    }
    if (state === 'initialized' && record.state === 'session-ready') {
      return;
    }
    record.state = state;
  }

  private fail(record: PreparationRecord<T>, error: unknown): void {
    if (record.state === 'claimed' || this.records.get(record.sessionId) !== record) {
      return;
    }
    this.logger.debug(
      `[${record.sessionId}] Session preparation ${record.preparationId} failed: ${formatErrorMessage(error)}`
    );
    void this.expire(record, 'failed');
  }

  /** The session's pending retirement, retrying it first if its last attempt failed. */
  private retirementOf(sessionId: SessionId): Promise<void> | null {
    return this.retiring.get(sessionId)?.run() ?? null;
  }

  private expire(record: PreparationRecord<T>, state: 'expired' | 'failed'): Promise<void> {
    if (record.retirement) return record.retirement.run();
    if (this.records.get(record.sessionId) === record) {
      this.records.delete(record.sessionId);
    }
    record.state = state;
    const controlClosed = record.control.close();

    // Keep retirement discoverable after the lease is removed, including while
    // create() is still returning its resource. Publish before abort listeners run.
    const predecessor = this.retiring.get(record.sessionId);
    const retirement: Retirement = new Retirement(async () => {
      try {
        await Promise.all([predecessor?.run(), controlClosed, this.waitForCleanup(record)]);
      } catch (error) {
        // A failed release remains discoverable and blocks same-session replacement.
        // Observers may ignore cancel's receipt, so log without consuming its failure.
        this.logger.debug(`Session preparation retirement failed: ${formatErrorMessage(error)}`);
        throw error;
      }
      if (this.retiring.get(record.sessionId) === retirement) {
        this.retiring.delete(record.sessionId);
      }
    });
    record.retirement = retirement;
    this.retiring.set(record.sessionId, retirement);
    const cleanup = retirement.run();
    record.abortController.abort();
    return cleanup;
  }

  private scheduleCleanup(record: PreparationRecord<T>, resource: T): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    const cleanup = Promise.resolve().then(() => resource.dispose());
    void cleanup.catch((error: unknown) => {
      // The resource still owns what it failed to release; the next retirement
      // attempt disposes it again.
      if (record.cleanupPromise === cleanup) record.cleanupPromise = undefined;
      this.logger.debug(`Failed to dispose session preparation: ${formatErrorMessage(error)}`);
    });
    record.cleanupPromise = cleanup;
    return cleanup;
  }

  private async waitForCleanup(record: PreparationRecord<T>): Promise<void> {
    let resource: T;
    try {
      resource = await record.resourcePromise;
    } catch (error) {
      if (!(error instanceof SessionPreparationCleanupError)) return;
      // Creation already attempted its rollback: report that failure once,
      // then retry the rollback on every later attempt.
      if (record.rollbackFailure !== error || !error.retry) {
        record.rollbackFailure = error;
        throw error;
      }
      await error.retry();
      return;
    }
    await this.scheduleCleanup(record, resource);
  }
}
