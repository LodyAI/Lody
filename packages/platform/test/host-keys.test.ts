import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  hostKeyFailure,
  macOSKeyFailure,
  makeHostIdentityStore,
  type HostIdentityBackend,
  type HostKeyPurpose,
  type HostPublicKeys,
} from '../src/host-keys';

const keys = { ed25519: '11'.repeat(32), x25519: '22'.repeat(32) };
const other = { ed25519: '33'.repeat(32), x25519: '44'.repeat(32) };
const ref = { accountId: 'synthetic-account', deviceId: 'synthetic-device' };
const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(Effect.match({ onSuccess: (value) => value, onFailure: (e) => e }))
  );

function fixture() {
  const rows = new Map<string, HostPublicKeys>();
  const id = (purpose: HostKeyPurpose, account: string, device: string) =>
    JSON.stringify([purpose, account, device]);
  const backend: HostIdentityBackend = {
    storage: 'synthetic-memory',
    execution: 'host-software',
    interaction: 'forbid',
    create: (purpose, r) =>
      Effect.suspend(() => {
        const key = id(purpose, r.accountId, r.deviceId);
        if (rows.has(key)) return Effect.fail(hostKeyFailure('already-exists'));
        const value = purpose === 'machine' ? other : keys;
        rows.set(key, value);
        return Effect.succeed(value);
      }),
    read: (purpose, r) =>
      Effect.suspend(() => {
        const value = rows.get(id(purpose, r.accountId, r.deviceId));
        return value ? Effect.succeed(value) : Effect.fail(hostKeyFailure('missing'));
      }),
  };
  return { rows, backend };
}

describe('host identity lifecycle', () => {
  it('keeps account/device/purpose separate, detects duplicates, never regenerates missing keys', async () => {
    const { backend, rows } = fixture();
    const personal = makeHostIdentityStore('personal-device', backend);
    const machine = makeHostIdentityStore('machine', backend);
    expect(await outcome(personal.read(ref, keys))).toMatchObject({ kind: 'missing' });
    expect(rows.size).toBe(0);
    expect(await outcome(personal.create(ref))).toEqual(keys);
    expect(await outcome(machine.create(ref))).toEqual(other);
    expect(await outcome(personal.create(ref))).toMatchObject({ kind: 'already-exists' });
    expect(await outcome(personal.read({ ...ref, accountId: 'another' }, keys))).toMatchObject({
      kind: 'missing',
    });
    expect(await outcome(personal.read({ ...ref, deviceId: 'another' }, keys))).toMatchObject({
      kind: 'missing',
    });
    expect(await outcome(personal.read(ref, keys))).toEqual(keys);
    expect(rows.size).toBe(2);
  });

  it.each([-25293, -25308, -26275, -128, -99999])(
    'preserves ambiguous native failure %i without guessing or deleting',
    async (status) => {
      const { backend, rows } = fixture();
      const store = makeHostIdentityStore('personal-device', backend);
      await Effect.runPromise(store.create(ref));
      const blocked = makeHostIdentityStore('personal-device', {
        ...backend,
        read: () => Effect.fail(macOSKeyFailure(status)),
      });
      expect(await outcome(blocked.read(ref, keys))).toMatchObject({
        kind: 'unavailable',
        reason: 'unknown',
        nativeStatus: status,
      });
      expect(await outcome(store.read(ref, keys))).toEqual(keys);
      expect(rows.size).toBe(1);
    }
  );

  it.each([other, { ...keys, x25519: 'bad' }])(
    'rejects replacement and damaged records without cleanup',
    async (actual) => {
      const { backend, rows } = fixture();
      const store = makeHostIdentityStore('personal-device', backend);
      await Effect.runPromise(store.create(ref));
      for (const id of rows.keys()) rows.set(id, actual);
      expect(await outcome(store.read(ref, keys))).toMatchObject({
        kind: actual === other ? 'identity-mismatch' : 'invalid-record',
      });
      expect([...rows.values()]).toEqual([actual]);
    }
  );

  it('does not report creation success before readback and preserves uncertain writes', async () => {
    const { backend, rows } = fixture();
    const store = makeHostIdentityStore('machine', {
      ...backend,
      read: () => Effect.fail(macOSKeyFailure(-25293)),
    });
    expect(await outcome(store.create(ref))).toMatchObject({
      kind: 'unavailable',
      creationOutcome: 'unknown',
    });
    expect(rows.size).toBe(1);
    expect(await outcome(makeHostIdentityStore('machine', backend).read(ref, other))).toEqual(
      other
    );
  });
  it('recovers public identity after a lost create response without replacing it', async () => {
    const { backend, rows } = fixture();
    const interrupted = makeHostIdentityStore('machine', {
      ...backend,
      create: (purpose, r) =>
        backend
          .create(purpose, r)
          .pipe(Effect.flatMap(() => Effect.fail(hostKeyFailure('unavailable')))),
    });
    expect(await outcome(interrupted.create(ref))).toMatchObject({ creationOutcome: 'unknown' });
    expect(await outcome(interrupted.inspect(ref))).toEqual(other);
    expect(await outcome(interrupted.create(ref))).toMatchObject({ kind: 'already-exists' });
    expect(rows.size).toBe(1);
  });

  it('captures caller references before a delayed run and returns detached public values', async () => {
    const { backend } = fixture();
    const store = makeHostIdentityStore('machine', backend);
    const input = { ...ref };
    const create = store.create(input);
    input.accountId = 'changed-after-call';
    const result = await Effect.runPromise(create);
    expect(await outcome(store.inspect(ref))).toEqual(other);
    expect(await outcome(store.inspect(input))).toMatchObject({ kind: 'missing' });
    expect(result).not.toBe(other);
  });
  it('rejects a successful readback of a different identity after create', async () => {
    const { backend, rows } = fixture();
    const store = makeHostIdentityStore('machine', {
      ...backend,
      read: () => Effect.succeed(keys),
    });
    expect(await outcome(store.create(ref))).toMatchObject({
      kind: 'identity-mismatch',
      creationOutcome: 'unknown',
    });
    expect([...rows.values()]).toEqual([other]);
  });
});
