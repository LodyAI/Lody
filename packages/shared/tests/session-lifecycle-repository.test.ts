import { describe, expect, it } from 'vitest';
import { LoroRepo, type JsonObject } from 'loro-repo';
import type { SessionId } from '../src/ids';
import {
  SessionLifecycleAdmissionUncertainError,
  SessionLifecycleAdmissionRejectedError,
  createLoroMetaSessionLifecyclePublisher,
  installSessionLifecycleRepoProjection,
  SessionLifecycleRepository,
  type SessionLifecycleAdmission,
  type SessionLifecycleAdmissionStore,
  type SessionLifecycleOperationDraft,
  type SessionLifecycleOperationPublisher,
} from '../src/session-lifecycle-repository';
import type { SessionLifecycleOperation } from '../src/session-lifecycle';

const id = (value: string): SessionId => value as SessionId;

class MemoryStore implements SessionLifecycleAdmissionStore {
  readonly admissions = new Map<string, SessionLifecycleAdmission>();
  highWater = 0n;
  throwBefore = false;
  throwAfter = false;
  throwRead = false;
  throwMarkPublished = false;
  onSeed: (() => void) | null = null;

  async list(): Promise<SessionLifecycleAdmission[]> {
    return [...this.admissions.values()];
  }

  async get(operationId: string): Promise<SessionLifecycleAdmission | undefined> {
    if (this.throwRead) throw new Error('read unavailable');
    return this.admissions.get(operationId);
  }

  async admit(
    draft: SessionLifecycleOperationDraft,
    actorId: string,
    observedCounter: string
  ): Promise<SessionLifecycleAdmission> {
    if (this.throwBefore) throw new SessionLifecycleAdmissionRejectedError('before write');
    const existing = this.admissions.get(draft.operationId);
    if (existing) {
      const targets = [...draft.targetIds].sort();
      if (
        existing.operation.subjectId !== draft.subjectId ||
        existing.operation.state !== draft.state ||
        JSON.stringify(existing.operation.targetIds) !== JSON.stringify(targets)
      ) {
        throw new Error(`conflicting operation ${draft.operationId}`);
      }
      return existing;
    }
    this.highWater =
      [this.highWater, BigInt(observedCounter)].reduce((a, b) => (a > b ? a : b)) + 1n;
    const admission: SessionLifecycleAdmission = {
      operation: {
        version: 1,
        ...draft,
        targetIds: [...draft.targetIds].sort(),
        order: { counter: this.highWater.toString(10), actorId },
      },
      published: false,
    };
    this.admissions.set(draft.operationId, admission);
    if (this.throwAfter) throw new Error('after write');
    return admission;
  }

  async observeCounter(counter: string): Promise<void> {
    const next = BigInt(counter);
    if (next > this.highWater) this.highWater = next;
  }

  async seed(operation: SessionLifecycleOperation): Promise<SessionLifecycleAdmission> {
    this.onSeed?.();
    const existing = this.admissions.get(operation.operationId);
    if (existing) return existing;
    const admission = { operation, published: false };
    this.admissions.set(operation.operationId, admission);
    return admission;
  }

  async markPublished(operationId: string): Promise<void> {
    if (this.throwMarkPublished) throw new Error('mark failed');
    const admission = this.admissions.get(operationId);
    if (admission) this.admissions.set(operationId, { ...admission, published: true });
  }
}

class MemoryPublisher implements SessionLifecycleOperationPublisher {
  readonly operations = new Map<string, SessionLifecycleOperation>();
  readonly listeners = new Set<(operation: unknown) => void>();
  failPublish = false;

  async list(): Promise<SessionLifecycleOperation[]> {
    return [...this.operations.values()];
  }

  async publish(operation: SessionLifecycleOperation): Promise<void> {
    if (this.failPublish) throw new Error('publish failed');
    this.operations.set(operation.operationId, operation);
    for (const listener of this.listeners) listener(operation);
  }

  subscribe(listener: (operation: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(operation: unknown): void {
    for (const listener of this.listeners) listener(operation);
  }
}

const draft = (operationId: string, state: 'archived' | 'active' = 'archived') => ({
  operationId,
  subjectId: id('root'),
  targetIds: [id('root'), id('child')],
  state,
});

describe('SessionLifecycleRepository', () => {
  it('admits durably before publishing and exposes one complete revision', async () => {
    const store = new MemoryStore();
    const publisher = new MemoryPublisher();
    const repository = new SessionLifecycleRepository({ actorId: 'actor-a', store, publisher });
    await repository.initialize();
    const events: string[][] = [];
    repository.subscribe(({ revision }) => events.push([...revision.bySessionId.keys()]));

    const receipt = await repository.commit(draft('archive'));

    expect(receipt.durability).toBe('accepted');
    expect(receipt.publication).toBe('published');
    expect(events).toEqual([['child', 'root']]);
    expect((await store.get('archive'))?.published).toBe(true);
  });

  it('publishes nothing when target validation fails before admission', async () => {
    const store = new MemoryStore();
    const publisher = new MemoryPublisher();
    const repository = new SessionLifecycleRepository({ actorId: 'actor-a', store, publisher });
    await repository.initialize();

    await expect(
      repository.commit({ ...draft('invalid'), targetIds: [id('root'), id('root')] })
    ).rejects.toThrow('targetIds must not contain duplicates');
    expect(store.admissions.size).toBe(0);
    expect(publisher.operations.size).toBe(0);
  });

  it('returns a durable pending receipt and replays the same operation after restart', async () => {
    const store = new MemoryStore();
    const publisher = new MemoryPublisher();
    publisher.failPublish = true;
    const first = new SessionLifecycleRepository({ actorId: 'actor-a', store, publisher });
    await first.initialize();
    const receipt = await first.commit(draft('archive'));
    expect(receipt.publication).toBe('pending');
    await first.dispose();

    publisher.failPublish = false;
    const recovered = new SessionLifecycleRepository({ actorId: 'actor-a', store, publisher });
    await recovered.initialize();
    expect(publisher.operations.get('archive')).toEqual(receipt.operation);
    expect((await store.get('archive'))?.published).toBe(true);
  });

  it('replays idempotently when publication succeeded before completion marking failed', async () => {
    const store = new MemoryStore();
    const publisher = new MemoryPublisher();
    store.throwMarkPublished = true;
    const first = new SessionLifecycleRepository({ actorId: 'actor-a', store, publisher });
    await first.initialize();
    const receipt = await first.commit(draft('archive'));
    expect(receipt.publication).toBe('pending');
    expect(publisher.operations.get('archive')).toEqual(receipt.operation);
    await first.dispose();

    store.throwMarkPublished = false;
    const recovered = new SessionLifecycleRepository({ actorId: 'actor-a', store, publisher });
    await recovered.initialize();
    expect(publisher.operations.size).toBe(1);
    expect((await store.get('archive'))?.published).toBe(true);
  });

  it('recovers an admission whose durable write succeeded before the call rejected', async () => {
    const store = new MemoryStore();
    store.throwAfter = true;
    const repository = new SessionLifecycleRepository({
      actorId: 'actor-a',
      store,
      publisher: new MemoryPublisher(),
    });
    await repository.initialize();
    const receipt = await repository.commit(draft('archive'));
    expect(receipt.operation.order.counter).toBe('1');
  });

  it('reports a definite rejection when the store confirms no admission', async () => {
    const store = new MemoryStore();
    store.throwBefore = true;
    const repository = new SessionLifecycleRepository({
      actorId: 'actor-a',
      store,
      publisher: new MemoryPublisher(),
    });
    await repository.initialize();
    await expect(repository.commit(draft('archive'))).rejects.toBeInstanceOf(
      SessionLifecycleAdmissionRejectedError
    );
  });

  it('reports an uncertain stable id when admission and recovery reads both fail', async () => {
    const store = new MemoryStore();
    store.throwBefore = true;
    store.throwRead = true;
    const repository = new SessionLifecycleRepository({
      actorId: 'actor-a',
      store,
      publisher: new MemoryPublisher(),
    });
    await repository.initialize();
    await expect(
      repository.commit(draft('archive'))
    ).rejects.toMatchObject<SessionLifecycleAdmissionUncertainError>({
      operationId: 'archive',
    });
  });

  it('keeps counters above observed and admitted operations across concurrent calls', async () => {
    const store = new MemoryStore();
    const publisher = new MemoryPublisher();
    publisher.operations.set('remote', {
      version: 1,
      operationId: 'remote',
      subjectId: id('root'),
      targetIds: [id('root')],
      state: 'archived',
      order: { counter: '40', actorId: 'remote' },
    });
    const repository = new SessionLifecycleRepository({ actorId: 'actor-a', store, publisher });
    await repository.initialize();
    const [first, second] = await Promise.all([
      repository.commit(draft('first')),
      repository.commit(draft('second', 'active')),
    ]);
    expect(first.operation.order.counter).toBe('41');
    expect(second.operation.order.counter).toBe('42');
  });

  it('does not lose remote operations delivered while migration baselines are being seeded', async () => {
    const store = new MemoryStore();
    const publisher = new MemoryPublisher();
    const remote: SessionLifecycleOperation = {
      version: 1,
      operationId: 'remote-during-seed',
      subjectId: id('root'),
      targetIds: [id('root')],
      state: 'archived',
      order: { counter: '9', actorId: 'remote' },
    };
    store.onSeed = () => publisher.emit(remote);
    const repository = new SessionLifecycleRepository({ actorId: 'actor-a', store, publisher });

    await repository.initialize({
      baselines: [
        {
          version: 1,
          operationId: 'baseline:v1:child',
          subjectId: id('child'),
          targetIds: [id('child')],
          state: 'archived',
          order: { counter: '0', actorId: 'baseline:v1' },
        },
      ],
    });

    expect(repository.getOperation(remote.operationId)).toEqual(remote);
    expect(repository.getRevision().bySessionId.get(id('root'))?.operationId).toBe(
      remote.operationId
    );
    expect((await repository.commit(draft('after-init'))).operation.order.counter).toBe('10');
  });

  it('reuses an admitted operation identity without advancing its order', async () => {
    const store = new MemoryStore();
    const repository = new SessionLifecycleRepository({
      actorId: 'actor-a',
      store,
      publisher: new MemoryPublisher(),
    });
    await repository.initialize();

    const first = await repository.commit(draft('stable'));
    const retried = await repository.commit(draft('stable'));

    expect(retried.operation).toEqual(first.operation);
    expect(store.highWater).toBe(1n);
    await expect(repository.commit(draft('stable', 'active'))).rejects.toThrow(
      'Conflicting payloads use lifecycle operation id stable'
    );
  });

  it('fails closed after an unsupported replicated schema version', async () => {
    const publisher = new MemoryPublisher();
    const repository = new SessionLifecycleRepository({
      actorId: 'actor-a',
      store: new MemoryStore(),
      publisher,
    });
    await repository.initialize();

    publisher.emit({ version: 2, operationId: 'future' });

    await expect(repository.flushPending()).rejects.toThrow(
      'rejected a replicated operation: Unsupported lifecycle operation version 2'
    );
  });

  it('installs a replicated multi-target operation before notifying projected readers', async () => {
    const source = await LoroRepo.create<JsonObject>({ metaDebounceCommitMs: 0 });
    const replica = await LoroRepo.create<JsonObject>({ metaDebounceCommitMs: 0 });
    const root = id('root');
    const child = id('child');
    const roomId = (sessionId: SessionId) => `session-${sessionId}`;
    const fromRoomId = (docId: string) =>
      docId.startsWith('session-') ? (docId.slice('session-'.length) as SessionId) : null;
    for (const sessionId of [root, child]) {
      await replica.upsertDocMeta(roomId(sessionId), {
        id: sessionId,
        isArchived: false,
        status: { type: 'idle' },
        unrelated: `kept-${sessionId}`,
      });
    }
    const repository = new SessionLifecycleRepository({
      actorId: 'replica',
      store: new MemoryStore(),
      publisher: createLoroMetaSessionLifecyclePublisher(replica),
    });
    await repository.initialize();
    installSessionLifecycleRepoProjection({
      repo: replica,
      repository,
      getSessionId: fromRoomId,
      getSessionDocId: roomId,
      rejectLegacyWrites: true,
    });

    const firstProjectedRead = new Promise<readonly [JsonObject, JsonObject]>((resolve, reject) => {
      const handle = replica.watch(
        () => {
          void (async () => {
            const snapshots = await replica.getDocMetaMany([roomId(root), roomId(child)]);
            handle.unsubscribe();
            resolve([
              snapshots.get(roomId(root))?.meta ?? {},
              snapshots.get(roomId(child))?.meta ?? {},
            ]);
          })().catch(reject);
        },
        { kinds: ['doc-metadata'], metadataFields: ['isArchived'] }
      );
    });
    await createLoroMetaSessionLifecyclePublisher(source).publish({
      version: 1,
      operationId: 'replicated-archive',
      subjectId: root,
      targetIds: [root, child],
      state: 'archived',
      order: { counter: '1', actorId: 'source' },
    });
    replica.getMeta().importJson(source.getMeta().exportJson());
    await (replica as unknown as { syncRunner: { metaHydrationQueue: Promise<void> } }).syncRunner
      .metaHydrationQueue;

    const [rootMeta, childMeta] = await firstProjectedRead;
    expect(rootMeta).toMatchObject({
      isArchived: true,
      status: { type: 'idle' },
      unrelated: 'kept-root',
    });
    expect(childMeta).toMatchObject({
      isArchived: true,
      status: { type: 'idle' },
      unrelated: 'kept-child',
    });
    await expect(replica.upsertDocMeta(roomId(root), { isArchived: false })).rejects.toThrow(
      'Direct isArchived writes are disabled'
    );

    await repository.dispose();
    await Promise.all([source.destroy(), replica.destroy()]);
  });
});
