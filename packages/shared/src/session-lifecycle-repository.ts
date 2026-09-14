import type { SessionId } from './ids';
import type { JsonObject, LoroRepo } from 'loro-repo';
import {
  canonicalizeSessionLifecycleOperation,
  compareSessionLifecycleOrder,
  encodeSessionLifecycleOperation,
  parseSessionLifecycleOperation,
  resolveSessionLifecycleRevision,
  sessionLifecycleOperationsEqual,
  SessionLifecycleOperationConflictError,
  SessionLifecycleProtocolError,
  type SessionLifecycleOperation,
  type SessionLifecycleRevision,
  type SessionLifecycleState,
} from './session-lifecycle';

export const SESSION_LIFECYCLE_OPERATION_DOC_ID = '_lody/session-lifecycle-operations/v1';
export const SESSION_LIFECYCLE_OPERATION_FIELD_PREFIX = 'operation:';
const SESSION_LIFECYCLE_REPOSITORY_SYMBOL = Symbol.for('lody.sessionLifecycleRepository.v1');

export type SessionLifecycleOperationDraft = {
  operationId: string;
  subjectId: SessionId;
  targetIds: readonly SessionId[];
  state: SessionLifecycleState;
};

export type SessionLifecycleAdmission = {
  operation: SessionLifecycleOperation;
  published: boolean;
};

export interface SessionLifecycleAdmissionStore {
  list(): Promise<readonly SessionLifecycleAdmission[]>;
  get(operationId: string): Promise<SessionLifecycleAdmission | undefined>;
  /**
   * Atomically return an existing identical admission or allocate and persist a
   * counter above both the store high-water mark and observedCounter.
   */
  admit(
    draft: SessionLifecycleOperationDraft,
    actorId: string,
    observedCounter: string
  ): Promise<SessionLifecycleAdmission>;
  /** Insert an exact counter-zero migration baseline without allocating order. */
  seed(operation: SessionLifecycleOperation): Promise<SessionLifecycleAdmission>;
  observeCounter(counter: string): Promise<void>;
  markPublished(operationId: string): Promise<void>;
  close?(): Promise<void>;
}

export interface SessionLifecycleOperationPublisher {
  list(): Promise<readonly unknown[]>;
  publish(operation: SessionLifecycleOperation): Promise<void>;
  subscribe(listener: (operation: unknown) => void): () => void;
}

export type SessionLifecycleCommitReceipt = {
  operation: SessionLifecycleOperation;
  durability: 'accepted';
  publication: 'published' | 'pending';
  revision: SessionLifecycleRevision;
};

export type SessionLifecycleRevisionEvent = {
  revision: SessionLifecycleRevision;
  previous: SessionLifecycleRevision;
  source: 'local' | 'remote' | 'recovery';
};

export class SessionLifecycleAdmissionUncertainError extends Error {
  constructor(
    readonly operationId: string,
    options: { cause?: unknown } = {}
  ) {
    super(`Lifecycle admission outcome is uncertain for ${operationId}`, options);
    this.name = 'SessionLifecycleAdmissionUncertainError';
  }
}

export class SessionLifecycleAdmissionRejectedError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'SessionLifecycleAdmissionRejectedError';
  }
}

function operationMatchesDraft(
  operation: SessionLifecycleOperation,
  draft: SessionLifecycleOperationDraft
): boolean {
  return sessionLifecycleOperationsEqual(
    operation,
    canonicalizeSessionLifecycleOperation({
      version: 1,
      ...draft,
      order: operation.order,
    })
  );
}

function highestCounter(operations: Iterable<SessionLifecycleOperation>): string {
  let highest = 0n;
  for (const operation of operations) {
    const counter = BigInt(operation.order.counter);
    if (counter > highest) highest = counter;
  }
  return highest.toString(10);
}

export class SessionLifecycleRepository {
  private readonly operations = new Map<string, SessionLifecycleOperation>();
  private readonly listeners = new Set<(event: SessionLifecycleRevisionEvent) => void>();
  private revision: SessionLifecycleRevision = resolveSessionLifecycleRevision([]);
  private commandQueue: Promise<void> = Promise.resolve();
  private unsubscribePublisher: (() => void) | null = null;
  private initialized = false;
  private disposed = false;
  private protocolFailure: unknown = null;

  constructor(
    private readonly options: {
      actorId: string;
      store: SessionLifecycleAdmissionStore;
      publisher: SessionLifecycleOperationPublisher;
    }
  ) {
    if (!options.actorId) throw new SessionLifecycleProtocolError('actorId must be non-empty');
  }

  async initialize(
    options: { baselines?: readonly SessionLifecycleOperation[] } = {}
  ): Promise<void> {
    if (this.initialized) return;
    if (this.disposed) throw new Error('Session lifecycle repository is disposed');

    const queuedRemote: unknown[] = [];
    this.unsubscribePublisher = this.options.publisher.subscribe((operation) => {
      if (!this.initialized) {
        queuedRemote.push(operation);
        return;
      }
      void this.enqueue(async () => {
        try {
          await this.acceptObserved(operation, 'remote');
        } catch (error) {
          this.protocolFailure = error;
          throw error;
        }
      }).catch(() => undefined);
    });

    try {
      const [published, admissions] = await Promise.all([
        this.options.publisher.list(),
        this.options.store.list(),
      ]);
      for (const value of published) this.addOperation(parseSessionLifecycleOperation(value));
      for (const admission of admissions) this.addOperation(admission.operation);
      const seeded: SessionLifecycleAdmission[] = [];
      for (const baseline of options.baselines ?? []) {
        if (baseline.order.counter !== '0' || baseline.order.actorId !== 'baseline:v1') {
          throw new SessionLifecycleProtocolError(
            'Migration baselines must use baseline:v1 at counter zero'
          );
        }
        const admission = await this.options.store.seed(baseline);
        this.addOperation(admission.operation);
        seeded.push(admission);
      }
      // A publisher can deliver operations while baseline seeding or high-water
      // persistence is awaiting I/O. Drain until no delivery arrived during the
      // preceding await, then make the repository ready without another yield.
      for (;;) {
        for (const value of queuedRemote.splice(0)) {
          this.addOperation(parseSessionLifecycleOperation(value));
        }
        await this.options.store.observeCounter(highestCounter(this.operations.values()));
        if (queuedRemote.length === 0) break;
      }
      this.replaceRevision('recovery');
      this.initialized = true;
      // Admission is the success boundary. A publisher outage leaves these rows
      // pending for reconnect/restart replay and must not make startup unusable.
      await this.publishPending([...admissions, ...seeded]).catch(() => undefined);
    } catch (error) {
      this.unsubscribePublisher?.();
      this.unsubscribePublisher = null;
      throw error;
    }
  }

  getRevision(): SessionLifecycleRevision {
    return this.revision;
  }

  getOperation(operationId: string): SessionLifecycleOperation | undefined {
    return this.operations.get(operationId);
  }

  subscribe(listener: (event: SessionLifecycleRevisionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  commit(draft: SessionLifecycleOperationDraft): Promise<SessionLifecycleCommitReceipt> {
    return this.enqueue(async () => {
      this.assertReady();
      const parsedDraft = canonicalizeSessionLifecycleOperation({
        version: 1,
        ...draft,
        order: { counter: '0', actorId: this.options.actorId },
      });
      const normalizedDraft: SessionLifecycleOperationDraft = {
        operationId: parsedDraft.operationId,
        subjectId: parsedDraft.subjectId,
        targetIds: parsedDraft.targetIds,
        state: parsedDraft.state,
      };

      let admission: SessionLifecycleAdmission;
      try {
        admission = await this.options.store.admit(
          normalizedDraft,
          this.options.actorId,
          highestCounter(this.operations.values())
        );
      } catch (cause) {
        let recovered: SessionLifecycleAdmission | undefined;
        try {
          recovered = await this.options.store.get(normalizedDraft.operationId);
        } catch {
          throw new SessionLifecycleAdmissionUncertainError(normalizedDraft.operationId, { cause });
        }
        if (!recovered && cause instanceof SessionLifecycleAdmissionRejectedError) throw cause;
        if (!recovered) {
          throw new SessionLifecycleAdmissionUncertainError(normalizedDraft.operationId, { cause });
        }
        admission = recovered;
      }
      if (!operationMatchesDraft(admission.operation, normalizedDraft)) {
        throw new SessionLifecycleOperationConflictError(normalizedDraft.operationId);
      }

      this.addOperation(admission.operation);
      this.replaceRevision('local');
      let publication: SessionLifecycleCommitReceipt['publication'] = admission.published
        ? 'published'
        : 'pending';
      if (!admission.published) {
        try {
          await this.options.publisher.publish(admission.operation);
          await this.options.store.markPublished(admission.operation.operationId);
          publication = 'published';
        } catch {
          publication = 'pending';
        }
      }
      return {
        operation: admission.operation,
        durability: 'accepted',
        publication,
        revision: this.revision,
      };
    });
  }

  async flushPending(): Promise<void> {
    await this.enqueue(async () => {
      this.assertReady();
      await this.publishPending(await this.options.store.list());
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribePublisher?.();
    this.unsubscribePublisher = null;
    await this.commandQueue.catch(() => undefined);
    await this.options.store.close?.();
    this.listeners.clear();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.commandQueue.then(work, work);
    this.commandQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error('Session lifecycle repository is not initialized');
    if (this.disposed) throw new Error('Session lifecycle repository is disposed');
    if (this.protocolFailure) {
      throw new SessionLifecycleProtocolError(
        `Session lifecycle repository rejected a replicated operation: ${
          this.protocolFailure instanceof Error
            ? this.protocolFailure.message
            : String(this.protocolFailure)
        }`
      );
    }
  }

  private addOperation(value: SessionLifecycleOperation): void {
    const operation = canonicalizeSessionLifecycleOperation(value);
    const existing = this.operations.get(operation.operationId);
    if (existing && !sessionLifecycleOperationsEqual(existing, operation)) {
      throw new SessionLifecycleOperationConflictError(operation.operationId);
    }
    this.operations.set(operation.operationId, operation);
  }

  private async acceptObserved(value: unknown, source: 'remote' | 'recovery'): Promise<void> {
    const operation = parseSessionLifecycleOperation(value);
    await this.options.store.observeCounter(operation.order.counter);
    this.addOperation(operation);
    this.replaceRevision(source);
  }

  private replaceRevision(source: SessionLifecycleRevisionEvent['source']): void {
    const previous = this.revision;
    const revision = resolveSessionLifecycleRevision(this.operations.values());
    if (revision.revisionId === previous.revisionId) return;
    this.revision = revision;
    for (const listener of this.listeners) {
      try {
        listener({ revision, previous, source });
      } catch {
        // Projection consumers cannot invalidate an already durable admission.
      }
    }
  }

  private async publishPending(admissions: readonly SessionLifecycleAdmission[]): Promise<void> {
    const pending = admissions
      .filter((admission) => !admission.published)
      .sort((left, right) => compareSessionLifecycleOrder(left.operation, right.operation));
    for (const admission of pending) {
      await this.options.publisher.publish(admission.operation);
      await this.options.store.markPublished(admission.operation.operationId);
    }
  }
}

export function createSessionLifecycleBaselineOperation(
  sessionId: SessionId
): SessionLifecycleOperation {
  return {
    version: 1,
    operationId: `baseline:v1:${sessionId}`,
    subjectId: sessionId,
    targetIds: [sessionId],
    state: 'archived',
    order: { counter: '0', actorId: 'baseline:v1' },
  };
}

export function projectSessionLifecycleMetadata(
  repository: SessionLifecycleRepository,
  sessionId: SessionId,
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const winner = repository.getRevision().bySessionId.get(sessionId);
  return { ...metadata, isArchived: winner?.state === 'archived' };
}

type RepoMetaRecord = { readonly meta: JsonObject; readonly deleted: boolean };
type ProjectableRepoFilter = {
  docIds?: readonly string[];
  kinds?: readonly string[];
  metadataFields?: readonly string[];
  by?: readonly string[];
};
type ProjectableRepo = Pick<
  LoroRepo<JsonObject>,
  'getDocMeta' | 'getDocMetaMany' | 'listDoc' | 'upsertDocMeta' | 'watch'
> & {
  [SESSION_LIFECYCLE_REPOSITORY_SYMBOL]?: SessionLifecycleRepository;
};

export function getAttachedSessionLifecycleRepository(
  repo: object
): SessionLifecycleRepository | null {
  return (
    (repo as { [SESSION_LIFECYCLE_REPOSITORY_SYMBOL]?: SessionLifecycleRepository })[
      SESSION_LIFECYCLE_REPOSITORY_SYMBOL
    ] ?? null
  );
}

function filterAcceptsLifecycleEvent(
  filter: ProjectableRepoFilter | undefined,
  docId: string,
  by: string
): boolean {
  if (filter?.kinds && !filter.kinds.includes('doc-metadata')) return false;
  if (filter?.docIds && !filter.docIds.includes(docId)) return false;
  if (filter?.metadataFields && !filter.metadataFields.includes('isArchived')) return false;
  if (filter?.by && !filter.by.includes(by)) return false;
  return true;
}

/**
 * Install the lifecycle overlay at the repository read/watch seam. The operation
 * revision is replaced before any synthesized per-session event is delivered,
 * so a listener that rereads any target observes the complete new revision.
 */
export function installSessionLifecycleRepoProjection(options: {
  repo: ProjectableRepo;
  repository: SessionLifecycleRepository;
  getSessionId(docId: string): SessionId | null;
  getSessionDocId(sessionId: SessionId): string;
  rejectLegacyWrites?: boolean;
}): void {
  const { repo, repository, getSessionId, getSessionDocId } = options;
  if (repo[SESSION_LIFECYCLE_REPOSITORY_SYMBOL]) {
    throw new Error('Session lifecycle projection is already installed');
  }
  const rawGetDocMeta = repo.getDocMeta.bind(repo);
  const rawGetDocMetaMany = repo.getDocMetaMany?.bind(repo);
  const rawListDoc = repo.listDoc.bind(repo);
  const rawUpsertDocMeta = repo.upsertDocMeta.bind(repo);
  const rawWatch = repo.watch.bind(repo);
  repo[SESSION_LIFECYCLE_REPOSITORY_SYMBOL] = repository;

  const projectRecord = <T extends RepoMetaRecord>(
    docId: string,
    record: T | undefined
  ): T | undefined => {
    const sessionId = getSessionId(docId);
    if (!record || !sessionId || record.deleted === true) return record;
    return {
      ...record,
      meta: projectSessionLifecycleMetadata(repository, sessionId, record.meta) as JsonObject,
    };
  };

  repo.getDocMeta = async (docId) => projectRecord(docId, await rawGetDocMeta(docId));
  if (rawGetDocMetaMany) {
    repo.getDocMetaMany = async (docIds) => {
      const records = await rawGetDocMetaMany(docIds);
      const projected = new Map<string, RepoMetaRecord>();
      for (const [docId, record] of records) {
        const next = projectRecord(docId, record);
        if (next) projected.set(docId, next);
      }
      return projected;
    };
  }
  repo.listDoc = async (query) =>
    (await rawListDoc(query)).map((record) => projectRecord(record.docId, record) ?? record);

  repo.upsertDocMeta = async (docId, patch) => {
    const sessionId = getSessionId(docId);
    if (options.rejectLegacyWrites && sessionId && Object.hasOwn(patch, 'isArchived')) {
      const isInitialization =
        patch.isArchived === false && !repository.getRevision().bySessionId.has(sessionId);
      if (!isInitialization) {
        throw new SessionLifecycleProtocolError(
          `Direct isArchived writes are disabled after lifecycle activation for ${sessionId}`
        );
      }
    }
    return rawUpsertDocMeta(docId, patch);
  };

  repo.watch = (listener, filter) => {
    const rawHandle = rawWatch((event) => {
      if (
        event.kind !== 'doc-metadata' ||
        !event.patch ||
        !Object.hasOwn(event.patch, 'isArchived')
      ) {
        listener(event);
        return;
      }
      const { isArchived: _ignored, ...remainingPatch } = event.patch;
      void _ignored;
      if (Object.keys(remainingPatch).length > 0) listener({ ...event, patch: remainingPatch });
    }, filter);
    const unsubscribeRevision = repository.subscribe(({ revision, previous, source }) => {
      const targetIds = new Set([...previous.bySessionId.keys(), ...revision.bySessionId.keys()]);
      const by = source === 'local' ? 'local' : 'live';
      for (const sessionId of targetIds) {
        const previousArchived = previous.bySessionId.get(sessionId)?.state === 'archived';
        const nextArchived = revision.bySessionId.get(sessionId)?.state === 'archived';
        if (previousArchived === nextArchived) continue;
        const docId = getSessionDocId(sessionId);
        if (!filterAcceptsLifecycleEvent(filter, docId, by)) continue;
        listener({ kind: 'doc-metadata', docId, patch: { isArchived: nextArchived }, by });
      }
    });
    return {
      unsubscribe() {
        rawHandle.unsubscribe();
        unsubscribeRevision();
      },
    };
  };
}

type RepoWatchEvent = {
  kind: string;
  docId?: string;
  patch?: Record<string, unknown>;
};

type LifecycleMetaRepo = {
  getDocMeta(docId: string): Promise<{ meta?: unknown } | undefined>;
  upsertDocMeta(docId: string, patch: Record<string, unknown>): Promise<unknown>;
  persistMetaNow(): Promise<void>;
  watch(
    listener: (event: RepoWatchEvent) => void,
    filter?: Record<string, unknown>
  ): {
    unsubscribe(): void;
  };
};

function decodePublishedOperation(value: unknown): SessionLifecycleOperation {
  if (typeof value !== 'string') {
    throw new SessionLifecycleProtocolError('Published lifecycle operation must be JSON text');
  }
  try {
    return parseSessionLifecycleOperation(JSON.parse(value));
  } catch (error) {
    if (error instanceof SessionLifecycleProtocolError) throw error;
    throw new SessionLifecycleProtocolError('Published lifecycle operation contains invalid JSON');
  }
}

export function createLoroMetaSessionLifecyclePublisher(
  repo: LifecycleMetaRepo
): SessionLifecycleOperationPublisher {
  return {
    async list() {
      const record = await repo.getDocMeta(SESSION_LIFECYCLE_OPERATION_DOC_ID);
      if (!record?.meta || typeof record.meta !== 'object' || Array.isArray(record.meta)) return [];
      return Object.entries(record.meta as Record<string, unknown>)
        .filter(([field]) => field.startsWith(SESSION_LIFECYCLE_OPERATION_FIELD_PREFIX))
        .map(([, value]) => decodePublishedOperation(value));
    },
    async publish(operation) {
      const field = `${SESSION_LIFECYCLE_OPERATION_FIELD_PREFIX}${operation.operationId}`;
      const existing = await repo.getDocMeta(SESSION_LIFECYCLE_OPERATION_DOC_ID);
      const existingValue =
        existing?.meta && typeof existing.meta === 'object' && !Array.isArray(existing.meta)
          ? (existing.meta as Record<string, unknown>)[field]
          : undefined;
      if (existingValue !== undefined) {
        const published = decodePublishedOperation(existingValue);
        if (!sessionLifecycleOperationsEqual(published, operation)) {
          throw new SessionLifecycleOperationConflictError(operation.operationId);
        }
        return;
      }
      await repo.upsertDocMeta(SESSION_LIFECYCLE_OPERATION_DOC_ID, {
        [field]: encodeSessionLifecycleOperation(operation),
      });
      await repo.persistMetaNow();
    },
    subscribe(listener) {
      const handle = repo.watch((event) => {
        if (event.kind !== 'doc-metadata' || event.docId !== SESSION_LIFECYCLE_OPERATION_DOC_ID) {
          return;
        }
        for (const [field, value] of Object.entries(event.patch ?? {})) {
          if (!field.startsWith(SESSION_LIFECYCLE_OPERATION_FIELD_PREFIX) || value === null)
            continue;
          if (typeof value !== 'string') {
            listener(value);
            continue;
          }
          try {
            listener(JSON.parse(value));
          } catch {
            listener(value);
          }
        }
      });
      return () => handle.unsubscribe();
    },
  };
}
