import { makeIndexedDbAccountPairingStore } from '../../src/account-pairing-browser';
import { accountPairingStoreChecks } from '../account-pairing-store-contract';
import { Effect } from 'effect';

/** Runs the shared store contract against real IndexedDB in this page. */
export async function runContract(): Promise<string[]> {
  const failures: string[] = [];
  let index = 0;
  for (const [name, check] of accountPairingStoreChecks(async () =>
    makeIndexedDbAccountPairingStore({ accountId: `contract-${index++}-${crypto.randomUUID()}` })
  )) {
    try {
      await check();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

/** A terminal state survives closing and reopening the account database. */
export async function persists(): Promise<string | null> {
  const accountId = `persist-${crypto.randomUUID()}`;
  const first = makeIndexedDbAccountPairingStore({ accountId });
  await Effect.runPromise(first.settle('l1', 'requester', 'declined', 1));
  first.close();
  const reopened = makeIndexedDbAccountPairingStore({ accountId });
  const state = await Effect.runPromise(reopened.terminal('l1'));
  reopened.close();
  return state;
}

/** A same-version database whose layout differs only in keys or indexes is refused
 * as corrupt, never used: a wrong `terminal` key would hide every terminal state. */
export async function refusesWrongLayout(): Promise<string[]> {
  const variants: [string, (db: IDBDatabase) => void][] = [
    [
      'terminal auto-increments',
      (db) => {
        db.createObjectStore('terminal', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('requests', { keyPath: 'seq', autoIncrement: true }).createIndex(
          'lookupId',
          'lookupId',
          { unique: true }
        );
        db.createObjectStore('joined', { keyPath: ['lookupId', 'workspaceId'] });
        db.createObjectStore('approved', { keyPath: 'lookupId' });
        db.createObjectStore('admissions', { keyPath: ['workspaceId', 'signingKey'] }).createIndex(
          'lookupId',
          'lookupId'
        );
      },
    ],
    [
      'request lookup index is not unique',
      (db) => {
        db.createObjectStore('terminal', { keyPath: 'lookupId' });
        db.createObjectStore('requests', { keyPath: 'seq', autoIncrement: true }).createIndex(
          'lookupId',
          'lookupId'
        );
        db.createObjectStore('joined', { keyPath: ['lookupId', 'workspaceId'] });
        db.createObjectStore('approved', { keyPath: 'lookupId' });
        db.createObjectStore('admissions', { keyPath: ['workspaceId', 'signingKey'] }).createIndex(
          'lookupId',
          'lookupId'
        );
      },
    ],
  ];
  const accepted: string[] = [];
  for (const [label, layout] of variants) {
    const accountId = `layout-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`lody-e2ee-account-pairing:${accountId}`, 1);
      request.onupgradeneeded = () => layout(request.result);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    const store = makeIndexedDbAccountPairingStore({ accountId });
    const exit = await Effect.runPromiseExit(store.settle('l1', 'requester', 'declined', 1));
    const read = await Effect.runPromiseExit(store.terminal('l1'));
    store.close();
    const corrupt = (value: typeof exit | typeof read) =>
      value._tag === 'Failure' && JSON.stringify(value).includes('corrupt');
    if (!corrupt(exit) || !corrupt(read)) accepted.push(label);
  }
  return accepted;
}
