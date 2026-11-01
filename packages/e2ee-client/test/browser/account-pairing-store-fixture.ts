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
