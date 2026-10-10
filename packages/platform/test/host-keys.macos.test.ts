import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hostKeyFailure,
  macOSKeyFailure,
  makeHostIdentityStore,
  type HostIdentityBackend,
  type HostKeyPurpose,
  type HostPublicKeys,
} from '../src/host-keys';

// Opt-in real OS test. Ordinary CI/unit tests never touch a keychain.
const enabled = process.env.LODY_TEST_HOST_KEYS_MACOS === '1';
const ref = { accountId: 'synthetic-account', deviceId: 'synthetic-device' };
const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(Effect.match({ onSuccess: (value) => value, onFailure: (e) => e }))
  );

function run(file: string, args: string[]) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // A timed-out child may exit zero while handling termination: still a failure.
  if (result.error || result.signal || result.status !== 0)
    throw new Error('Native fixture process failed');
  return result.stdout;
}

describe.skipIf(!enabled)('macOS isolated host identity fixture', () => {
  const uuid = randomUUID().toUpperCase();
  const directory = join(tmpdir(), `lody-host-keys-${uuid}`);
  const binary = join(directory, 'fixture');
  let attemptedSetup = false;
  let personalKeys: HostPublicKeys;
  let machineKeys: HostPublicKeys;

  const invoke = (action: string, purpose: HostKeyPurpose = 'machine') =>
    JSON.parse(run(binary, [action, uuid, directory, purpose])) as Record<string, unknown>;
  const operation = (action: string, purpose: HostKeyPurpose) =>
    Effect.gen(function* () {
      const result = yield* Effect.try({
        try: () => invoke(action, purpose),
        catch: () => ({
          ...hostKeyFailure('unavailable'),
          ...(action === 'create' ? { creationOutcome: 'unknown' as const } : {}),
        }),
      });
      if (typeof result.status !== 'number')
        return yield* Effect.fail(hostKeyFailure('unavailable'));
      if (result.status !== 0) return yield* Effect.fail(macOSKeyFailure(result.status));
      if (
        result.invalidRecord ||
        typeof result.ed25519 !== 'string' ||
        typeof result.x25519 !== 'string'
      ) {
        return yield* Effect.fail(hostKeyFailure('invalid-record'));
      }
      return { ed25519: result.ed25519, x25519: result.x25519 };
    });
  const backend: HostIdentityBackend = {
    storage: 'macos-isolated-file-keychain',
    execution: 'host-software',
    interaction: 'forbid',
    create: (purpose, r) => {
      expect(r).toEqual(ref);
      return operation('create', purpose);
    },
    read: (purpose, r) => {
      expect(r).toEqual(ref);
      return operation('read', purpose);
    },
  };
  const personal = makeHostIdentityStore('personal-device', backend);
  const machine = makeHostIdentityStore('machine', backend);

  beforeAll(() => {
    if (process.platform !== 'darwin') throw new Error('Requires real macOS');
    mkdirSync(directory, { mode: 0o700 });
    run('xcrun', [
      'swiftc',
      '-module-cache-path',
      join(directory, 'swift-cache'),
      fileURLToPath(new URL('./native/host-keys.swift', import.meta.url)),
      '-o',
      binary,
    ]);
    attemptedSetup = true;
    expect(invoke('setup')).toEqual({ status: 0 });
  }, 120_000);

  afterAll(() => {
    if (attemptedSetup) {
      // Even failed/unknown creation attempts require exact cleanup and evidence.
      // Keep the fixture path for explicit recovery if cleanup fails; never claim success.
      try {
        expect(invoke('cleanup')).toEqual({ status: 0, deletedAndMissing: true });
      } catch {
        throw new Error(`Fixture cleanup unverified: ${directory}`);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }, 70_000);

  it('creates separated identities and verifies both in new host processes', async () => {
    personalKeys = await Effect.runPromise(personal.create(ref));
    machineKeys = await Effect.runPromise(machine.create(ref));
    expect(personalKeys).not.toEqual(machineKeys);
    expect(await Effect.runPromise(personal.read(ref, personalKeys))).toEqual(personalKeys);
    expect(await Effect.runPromise(machine.read(ref, machineKeys))).toEqual(machineKeys);
    expect(await outcome(machine.create(ref))).toMatchObject({ kind: 'already-exists' });
    expect(await Effect.runPromise(machine.read(ref, machineKeys))).toEqual(machineKeys);

    // Lock this fixture only, then reopen in another process.
    const locked = await outcome(operation('locked-read', 'machine'));
    expect(locked).toMatchObject({ kind: 'unavailable', reason: 'unknown' });
    expect(await Effect.runPromise(machine.read(ref, machineKeys))).toEqual(machineKeys);

    // Corruption must survive reads and failed duplicate creation.
    expect(invoke('corrupt')).toEqual({ status: 0, invalidRecord: true });
    expect(await outcome(machine.read(ref, machineKeys))).toMatchObject({ kind: 'invalid-record' });
    expect(await outcome(machine.create(ref))).toMatchObject({ kind: 'already-exists' });
    expect(await outcome(machine.read(ref, machineKeys))).toMatchObject({ kind: 'invalid-record' });
    expect(await Effect.runPromise(personal.read(ref, personalKeys))).toEqual(personalKeys);
  }, 120_000);
});
