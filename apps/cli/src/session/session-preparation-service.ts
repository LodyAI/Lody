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
  expiresTimer: ReturnType<typeof setTimeout>;
  resource?: T;
  resourcePromise: Promise<T>;
  cleanupPromise?: Promise<void>;
};

export type SessionPreparationClaimResult<T extends SessionPreparationResource> =
  | { status: 'claimed'; resource: T }
  | { status: 'miss'; cleanup: Promise<void> | null };

export class SessionPreparationService<T extends SessionPreparationResource> {
  private readonly records = new Map<SessionId, PreparationRecord<T>>();
  private readonly cleanupPromises = new Set<Promise<void>>();

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

    let disposition: SessionPreparationStartDisposition = 'accepted';
    let predecessorCleanup: Promise<void> | null = null;
    const requesterRecord = Array.from(this.records.values()).find(
      (record) => record.requesterUserId === args.requesterUserId
    );
    if (requesterRecord) {
      void this.expire(requesterRecord, 'expired');
      predecessorCleanup = this.waitForCleanup(requesterRecord);
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
    record.expiresTimer = setTimeout(
      () => {
        if (this.records.get(args.sessionId) === record) {
          this.logger.debug(
            `[${args.sessionId}] Session preparation ${args.preparationId} reached its hard TTL`
          );
          void this.expire(record, 'expired');
        }
      },
      Math.max(1, this.options.hardTtlMs)
    );
    record.expiresTimer.unref?.();
    record.resourcePromise = Promise.resolve().then(async () => {
      await predecessorCleanup;
      abortController.signal.throwIfAborted();
      return await args.create(abortController.signal);
    });
    this.records.set(args.sessionId, record);

    void record.resourcePromise.then(
      (resource) => {
        record.resource = resource;
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
        void resource.initialized.then(
          () => this.advance(record, 'initialized'),
          (error) => this.fail(record, error)
        );
        void resource.sessionReady.then(
          () => this.advance(record, 'session-ready'),
          (error) => this.fail(record, error)
        );
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
    if (!record) return null;
    void this.expire(record, 'expired');
    return this.waitForCleanup(record);
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
      return { status: 'miss', cleanup: null };
    }
    if (
      record.requesterUserId !== args.requesterUserId ||
      record.claimKey !== args.claimKey ||
      !record.resource
    ) {
      return { status: 'miss', cleanup: this.expire(record, 'expired') };
    }

    try {
      if (!args.isCompatible(record.resource)) {
        return { status: 'miss', cleanup: this.expire(record, 'expired') };
      }
    } catch (error) {
      this.logger.debug(
        `[${record.sessionId}] Session preparation claim fell back to cold start: ${formatErrorMessage(error)}`
      );
      return { status: 'miss', cleanup: this.expire(record, 'expired') };
    }

    record.state = 'claimed';
    this.records.delete(record.sessionId);
    clearTimeout(record.expiresTimer);
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
    await Promise.allSettled(records.map((record) => record.resourcePromise));
    await Promise.allSettled(Array.from(this.cleanupPromises));
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

  private expire(record: PreparationRecord<T>, state: 'expired' | 'failed'): Promise<void> | null {
    if (this.records.get(record.sessionId) === record) {
      this.records.delete(record.sessionId);
    }
    record.state = state;
    clearTimeout(record.expiresTimer);
    record.abortController.abort();
    if (record.resource) {
      return this.scheduleCleanup(record, record.resource);
    }
    return null;
  }

  private scheduleCleanup(record: PreparationRecord<T>, resource: T): Promise<void> {
    if (record.cleanupPromise) return record.cleanupPromise;
    const cleanup = resource
      .dispose()
      .catch((error: unknown) => {
        this.logger.debug(`Failed to dispose session preparation: ${formatErrorMessage(error)}`);
      })
      .finally(() => this.cleanupPromises.delete(cleanup));
    record.cleanupPromise = cleanup;
    this.cleanupPromises.add(cleanup);
    return cleanup;
  }

  private async waitForCleanup(record: PreparationRecord<T>): Promise<void> {
    try {
      const resource = await record.resourcePromise;
      await this.scheduleCleanup(record, resource);
    } catch {
      // Creation failures are already logged by the resource promise observer.
    }
  }
}
