import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

type Fixture = typeof import('./recovery-workspaces-batch-fixture');
let open: Fixture | undefined;
const load = async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
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
