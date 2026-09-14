import {
  canonicalizeSessionLifecycleOperation,
  encodeSessionLifecycleOperation,
  parseSessionLifecycleOperation,
  SessionLifecycleAdmissionRejectedError,
  SessionLifecycleOperationConflictError,
  type SessionLifecycleAdmission,
  type SessionLifecycleAdmissionStore,
  type SessionLifecycleOperationDraft,
} from '@lody/shared';

const DB_VERSION = 1;
const ADMISSIONS_STORE = 'admissions';
const STATE_STORE = 'state';
const HIGH_WATER_KEY = 'highWater';

type PersistedAdmission = {
  operationId: string;
  operationJson: string;
  published: boolean;
};

type PersistedState = { key: string; value: string };

type AdmissionFaults = {
  beforeWrite?: () => void;
  afterCommit?: () => void;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });

function decodeAdmission(value: PersistedAdmission): SessionLifecycleAdmission {
  return {
    operation: parseSessionLifecycleOperation(JSON.parse(value.operationJson)),
    published: value.published,
  };
}

function draftMatchesAdmission(
  draft: SessionLifecycleOperationDraft,
  admission: SessionLifecycleAdmission
): boolean {
  return (
    encodeSessionLifecycleOperation(admission.operation) ===
    encodeSessionLifecycleOperation(
      canonicalizeSessionLifecycleOperation({
        version: 1,
        ...draft,
        order: admission.operation.order,
      })
    )
  );
}

export function getSessionLifecycleIndexedDbName(workspaceId: string): string {
  return `lody-session-lifecycle-v1:${workspaceId}`;
}

export async function createIndexedDbSessionLifecycleAdmissionStore(options: {
  workspaceId: string;
  indexedDB?: IDBFactory;
  faults?: AdmissionFaults;
}): Promise<SessionLifecycleAdmissionStore> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is unavailable for Session lifecycle persistence');
  const openRequest = factory.open(getSessionLifecycleIndexedDbName(options.workspaceId), DB_VERSION);
  openRequest.onupgradeneeded = () => {
    const database = openRequest.result;
    if (!database.objectStoreNames.contains(ADMISSIONS_STORE)) {
      database.createObjectStore(ADMISSIONS_STORE, { keyPath: 'operationId' });
    }
    if (!database.objectStoreNames.contains(STATE_STORE)) {
      database.createObjectStore(STATE_STORE, { keyPath: 'key' });
    }
  };
  const database = await requestResult(openRequest);

  const readAdmission = async (operationId: string): Promise<SessionLifecycleAdmission | undefined> => {
    const transaction = database.transaction(ADMISSIONS_STORE, 'readonly');
    const value = (await requestResult(
      transaction.objectStore(ADMISSIONS_STORE).get(operationId)
    )) as PersistedAdmission | undefined;
    await transactionComplete(transaction);
    return value ? decodeAdmission(value) : undefined;
  };

  return {
    async list() {
      const transaction = database.transaction(ADMISSIONS_STORE, 'readonly');
      const values = (await requestResult(
        transaction.objectStore(ADMISSIONS_STORE).getAll()
      )) as PersistedAdmission[];
      await transactionComplete(transaction);
      return values.map(decodeAdmission);
    },
    get: readAdmission,
    async admit(draft, actorId, observedCounter) {
      try {
        options.faults?.beforeWrite?.();
      } catch (cause) {
        throw new SessionLifecycleAdmissionRejectedError(
          cause instanceof Error ? cause.message : 'IndexedDB lifecycle admission rejected',
          { cause }
        );
      }
      const transaction = database.transaction([ADMISSIONS_STORE, STATE_STORE], 'readwrite');
      const admissions = transaction.objectStore(ADMISSIONS_STORE);
      const state = transaction.objectStore(STATE_STORE);
      const existingValue = (await requestResult(admissions.get(draft.operationId))) as
        | PersistedAdmission
        | undefined;
      if (existingValue) {
        const existing = decodeAdmission(existingValue);
        if (!draftMatchesAdmission(draft, existing)) {
          transaction.abort();
          throw new SessionLifecycleOperationConflictError(draft.operationId);
        }
        await transactionComplete(transaction);
        return existing;
      }
      const highWaterValue = (await requestResult(state.get(HIGH_WATER_KEY))) as
        | PersistedState
        | undefined;
      const counter =
        (BigInt(highWaterValue?.value ?? '0') > BigInt(observedCounter)
          ? BigInt(highWaterValue?.value ?? '0')
          : BigInt(observedCounter)) + 1n;
      const operation = canonicalizeSessionLifecycleOperation({
        version: 1,
        ...draft,
        order: { counter: counter.toString(10), actorId },
      });
      admissions.put({
        operationId: operation.operationId,
        operationJson: encodeSessionLifecycleOperation(operation),
        published: false,
      } satisfies PersistedAdmission);
      state.put({ key: HIGH_WATER_KEY, value: counter.toString(10) } satisfies PersistedState);
      await transactionComplete(transaction);
      options.faults?.afterCommit?.();
      return { operation, published: false };
    },
    async observeCounter(counter) {
      const transaction = database.transaction(STATE_STORE, 'readwrite');
      const state = transaction.objectStore(STATE_STORE);
      const current = (await requestResult(state.get(HIGH_WATER_KEY))) as PersistedState | undefined;
      if (BigInt(counter) > BigInt(current?.value ?? '0')) {
        state.put({ key: HIGH_WATER_KEY, value: counter } satisfies PersistedState);
      }
      await transactionComplete(transaction);
    },
    async seed(operation) {
      const transaction = database.transaction(ADMISSIONS_STORE, 'readwrite');
      const store = transaction.objectStore(ADMISSIONS_STORE);
      const existingValue = (await requestResult(store.get(operation.operationId))) as
        | PersistedAdmission
        | undefined;
      if (existingValue) {
        const existing = decodeAdmission(existingValue);
        if (encodeSessionLifecycleOperation(existing.operation) !== encodeSessionLifecycleOperation(operation)) {
          transaction.abort();
          throw new SessionLifecycleOperationConflictError(operation.operationId);
        }
        await transactionComplete(transaction);
        return existing;
      }
      store.put({
        operationId: operation.operationId,
        operationJson: encodeSessionLifecycleOperation(operation),
        published: false,
      } satisfies PersistedAdmission);
      await transactionComplete(transaction);
      return { operation, published: false };
    },
    async markPublished(operationId) {
      const transaction = database.transaction(ADMISSIONS_STORE, 'readwrite');
      const store = transaction.objectStore(ADMISSIONS_STORE);
      const value = (await requestResult(store.get(operationId))) as PersistedAdmission | undefined;
      if (value && !value.published) store.put({ ...value, published: true });
      await transactionComplete(transaction);
    },
    async close() {
      database.close();
    },
  };
}
