import { Effect, Exit } from 'effect';
import type { AccountPairingStore } from '../src/account-pairing';

const same = (actual: unknown, expected: unknown, label: string) => {
  const encode = (value: unknown) =>
    JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? [...item] : item));
  if (encode(actual) !== encode(expected))
    throw new Error(`${label}: expected ${encode(expected)}, got ${encode(actual)}`);
};
const expect = (actual: unknown) => ({
  toBe: (expected: unknown) => same(actual, expected, 'toBe'),
  toEqual: (expected: unknown) => same(actual, expected, 'toEqual'),
  toBeNull: () => same(actual, null, 'toBeNull'),
});

/** Semantics every `AccountPairingStore` implementation must keep, as named checks
 * that throw on failure. They run under vitest and inside a real browser page. */
export function accountPairingStoreChecks(
  make: () => Promise<AccountPairingStore>
): [string, () => Promise<void>][] {
  const checks: [string, () => Promise<void>][] = [];
  const it = (name: string, check: () => Promise<void>) => void checks.push([name, check]);
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
  const request = (lookupId: string, fill: number) => ({
    lookupId,
    request: new Uint8Array([fill, fill]),
    requestTag: 'aa'.repeat(32),
    direction: 'requester-shows',
    expiresAt: 1_800_000_600_000 + fill,
  });
  const admission = (requestId: string) => ({
    workspaceId: 'w1',
    signingKey: '11'.repeat(32),
    genesis: '22'.repeat(32),
    lookupId: 'l1',
    requestId,
    record: new Uint8Array([1, 2, 3]),
    invitation: null,
  });

  it('keeps the first terminal state and never revives it', async () => {
    const store = await make();
    expect(await run(store.terminal('l1'))).toBeNull();
    await run(store.settle('l1', 'requester', 'expired', 1));
    await run(store.settle('l1', 'requester', 'approved', 2));
    expect(await run(store.terminal('l1'))).toBe('expired');
  });

  it('stores exact requests once and returns the latest one', async () => {
    const store = await make();
    expect(await run(store.latestRequest())).toBeNull();
    await run(store.insertRequest(request('l1', 1)));
    await run(store.insertRequest(request('l2', 2)));
    expect(await run(store.hasRequest('l1'))).toBe(true);
    expect(await run(store.hasRequest('l3'))).toBe(false);
    expect(await run(store.latestRequest())).toEqual(request('l2', 2));
    const duplicate = await Effect.runPromiseExit(store.insertRequest(request('l1', 9)));
    expect(Exit.isFailure(duplicate)).toBe(true);
    expect(await run(store.latestRequest())).toEqual(request('l2', 2));
  });

  it('records joined workspaces and the first approved copy idempotently', async () => {
    const store = await make();
    await run(store.addJoined('l1', 'w1'));
    await run(store.addJoined('l1', 'w1'));
    await run(store.addJoined('l1', 'w2'));
    expect([...(await run(store.joined('l1')))].sort()).toEqual(['w1', 'w2']);
    expect(await run(store.approvedRequest('l1'))).toBeNull();
    await run(store.putApprovedRequest('l1', new Uint8Array([1]), 'aa'));
    await run(store.putApprovedRequest('l1', new Uint8Array([2]), 'bb'));
    expect(await run(store.approvedRequest('l1'))).toEqual({
      request: new Uint8Array([1]),
      requestTag: 'aa',
    });
  });

  it('journals one admission per workspace and key, and deletes only the exact original', async () => {
    const store = await make();
    await run(store.insertAdmission(admission('r1')));
    const duplicate = await Effect.runPromiseExit(store.insertAdmission(admission('r2')));
    expect(Exit.isFailure(duplicate)).toBe(true);
    await run(store.setAdmissionInvitation('w1', '11'.repeat(32), new Uint8Array([7])));
    await run(store.setAdmissionInvitation('w1', '11'.repeat(32), new Uint8Array([8])));
    expect(await run(store.admission('w1', '11'.repeat(32)))).toEqual({
      ...admission('r1'),
      invitation: new Uint8Array([7]),
    });
    expect(await run(store.admissionCount('l1'))).toBe(1);
    await run(store.deleteAdmission('w1', '11'.repeat(32), 'r2'));
    expect(await run(store.admissionCount('l1'))).toBe(1);
    await run(store.deleteAdmission('w1', '11'.repeat(32), 'r1'));
    expect(await run(store.admission('w1', '11'.repeat(32)))).toBeNull();
    expect(await run(store.admissionCount('l1'))).toBe(0);
  });
  return checks;
}
