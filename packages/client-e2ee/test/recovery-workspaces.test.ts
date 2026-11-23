import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

type Fixture = typeof import('./recovery-workspaces-batch-fixture');
type Grant = (lock: { name: string; mode: 'exclusive' } | null) => unknown;

/** Exclusive Web Locks in memory, so the custody writer runs the same on every Node
 * version (Node 22 has no `navigator.locks`) without depending on scheduler timing. */
function memoryLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const held = new Set<string>();
  return {
    request: (name: string, options: { ifAvailable?: boolean } | Grant, maybe?: Grant) => {
      const grant = (typeof options === 'function' ? options : maybe)!;
      const ifAvailable = typeof options === 'object' && options.ifAvailable === true;
      if (ifAvailable && held.has(name)) return Promise.resolve(grant(null));
      const run = async () => {
        held.add(name);
        try {
          return await grant({ name, mode: 'exclusive' });
        } finally {
          held.delete(name);
        }
      };
      const result = (tails.get(name) ?? Promise.resolve()).then(run, run);
      tails.set(
        name,
        result.catch(() => undefined)
      );
      return result;
    },
    query: async () => ({ held: [...held].map((name) => ({ name })), pending: [] }),
  };
}

let open: Fixture | undefined;
const load = async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', {
    userAgent: globalThis.navigator?.userAgent ?? 'node',
    language: 'en-US',
    languages: ['en-US'],
    hardwareConcurrency: 1,
    locks: memoryLocks(),
  });
  open = await import('./recovery-workspaces-batch-fixture');
  await open.boot();
  return open;
};
afterEach(async () => {
  await open?.close();
  open = undefined;
  vi.unstubAllGlobals();
});

it('keeps a partial key restore unready and offered until a later restore installs the current key', async () => {
  const f = await load();
  await f.commitStagedEpoch({ publish: false });
  const first = await f.portRestore();
  expect(first.restored).toEqual({
    outcome: 'restored',
    results: ['A', 'B', 'C'].map((id) => ({
      workspaceId: id,
      name: id,
      outcome: 'Committed',
      partialEpochKey: true,
    })),
  });
  expect(first.observed).toHaveLength(3);
  expect(first.observed).toEqual(
    expect.arrayContaining(first.restored.outcome === 'restored' ? [...first.restored.results] : [])
  );
  expect(await f.pinPhase('A')).toBe('pending');
  expect((await f.portPlan()).uncovered.map((row) => row.id)).toEqual(['A', 'B', 'C']);
  expect(await f.openStatus('A')).toMatchObject({ hasCurrentKey: false });

  f.publishStagedEpoch();
  const second = await f.portRestore();
  expect(second.restored).toEqual({
    outcome: 'restored',
    results: ['A', 'B', 'C'].map((id) => ({ workspaceId: id, name: id, outcome: 'Committed' })),
  });
  expect(await f.pinPhase('A')).toBe('ready');
  expect((await f.portPlan()).uncovered).toEqual([]);
  expect(await f.openStatus('A')).toMatchObject({ hasCurrentKey: true });
}, 60_000);

it('restores a revoked device as a replacement identity instead of reusing its revoked key', async () => {
  const f = await load();
  await f.portRestore();
  const before = await f.openStatus('A');
  expect(before).toMatchObject({ hasCurrentKey: true });
  const revoked = await f.revokePersonalDevices('A');
  expect(revoked).toEqual([(before as { signingPublicKey: string }).signingPublicKey]);
  expect(await f.openStatus('A')).toEqual({ refused: 'e2ee_device_revoked' });
  expect(await f.pinPhase('A')).toBe('cancelled');
  expect((await f.portPlan()).uncovered.map((row) => row.id)).toEqual(['A']);

  const again = await f.portRestore();
  expect(again.restored).toEqual({
    outcome: 'restored',
    results: [{ workspaceId: 'A', name: 'A', outcome: 'Committed' }],
  });
  const after = await f.openStatus('A');
  expect(after).toMatchObject({ hasCurrentKey: true });
  expect((after as { signingPublicKey: string }).signingPublicKey).not.toBe(revoked[0]);
  expect(await f.pinPhase('A')).toBe('ready');
  const devices = f
    .state()
    .records.find((row) => row.id === 'A')!
    .devices.map((row) => row.id);
  expect(devices).toContain((after as { signingPublicKey: string }).signingPublicKey);
  expect(devices).not.toContain(revoked[0]);
}, 60_000);

const signingKey = (status: Awaited<ReturnType<Fixture['openStatus']>>) =>
  (status as { signingPublicKey: string }).signingPublicKey;

it('finishes a partial restore of a revoked device on the same replacement identity', async () => {
  const f = await load();
  await f.portRestore();
  const [revoked] = await f.revokePersonalDevices('A');
  expect(await f.openStatus('A')).toEqual({ refused: 'e2ee_device_revoked' });
  await f.commitStagedEpoch({ publish: false });
  const partial = await f.portRestore();
  expect(partial.restored).toMatchObject({
    results: [{ workspaceId: 'A', outcome: 'Committed', partialEpochKey: true }],
  });
  expect(await f.pinPhase('A')).toBe('pending');
  const replacement = signingKey(await f.openStatus('A'));
  expect(replacement).not.toBe(revoked);

  f.publishStagedEpoch();
  const done = await f.portRestore();
  expect(done.restored).toMatchObject({
    results: [{ workspaceId: 'A', outcome: 'Committed' }],
  });
  expect(await f.pinPhase('A')).toBe('ready');
  expect(await f.openStatus('A')).toEqual({ signingPublicKey: replacement, hasCurrentKey: true });
}, 60_000);

it('resumes an interrupted replacement restore instead of reopening the revoked identity', async () => {
  const f = await load();
  await f.portRestore();
  const [revoked] = await f.revokePersonalDevices('A');
  expect(await f.openStatus('A')).toEqual({ refused: 'e2ee_device_revoked' });
  f.loseNextAppendReply();
  const interrupted = await f.portRestore();
  expect(interrupted.restored).toMatchObject({
    results: [{ workspaceId: 'A', outcome: 'Failed' }],
  });
  expect(await f.pinPhase('A')).toBe('pending');

  const resumed = await f.portRestore();
  expect(resumed.restored).toMatchObject({
    results: [{ workspaceId: 'A', outcome: 'Committed' }],
  });
  const after = await f.openStatus('A');
  expect(after).toMatchObject({ hasCurrentKey: true });
  expect(signingKey(after)).not.toBe(revoked);
  expect(await f.pinPhase('A')).toBe('ready');
}, 60_000);

it('replaces a partially restored identity that is revoked before its restore finishes', async () => {
  const f = await load();
  await f.commitStagedEpoch({ publish: false });
  await f.portRestore();
  expect(await f.pinPhase('A')).toBe('pending');
  const [revoked] = await f.revokePersonalDevices('A');
  f.publishStagedEpoch();
  const again = await f.portRestore();
  expect(again.restored).toMatchObject({
    results: expect.arrayContaining([{ workspaceId: 'A', name: 'A', outcome: 'Committed' }]),
  });
  const after = await f.openStatus('A');
  expect(after).toMatchObject({ hasCurrentKey: true });
  expect(signingKey(after)).not.toBe(revoked);
  expect(await f.pinPhase('A')).toBe('ready');
}, 60_000);
