import { createHmac } from 'node:crypto';
import { decode, encode } from '@ipld/dag-cbor';
import { Effect, Layer, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { RecoveryVaults } from '../src';
import {
  DEFAULT_PASSWORD_KDF,
  MAX_PASSWORD_KDF,
  MIN_PASSWORD_KDF,
  MIN_RECOVERY_PASSWORD_LENGTH,
  disposePrf,
  generateRecoveryPackage,
  generateRecoveryVaultId,
  normalizeRecoveryPassword,
  ownVaultCiphertext,
  passkeyUserHandle,
  passwordWrapEntryId,
  vaultPrfInput,
  verifiedPasskeyPrf,
  verifiedPasskeyRegistration,
  wipeRecoveryPackage,
  type VaultCiphertext,
} from '../src/protocol';
import { RecoveryVaultLocalStore, RecoveryVaultStore } from '../src/services';
import {
  createRecoveryVaultWithPasskey,
  createRecoveryVaultWithPassword,
  openRecoveryVault,
  openRecoveryVaultWithPasskey,
  openRecoveryVaultWithPassword,
} from '../src/internal/recovery/vault';

const FAST_KDF = MIN_PASSWORD_KDF;

const makeStores = () => {
  const entries = new Map<string, VaultCiphertext>();
  const local = new Map<string, Uint8Array>();
  let index: VaultCiphertext | null = null;
  let failNextDelete = false;
  const store: RecoveryVaultStore['Service'] = {
    putImmutable: (_vault, entry) => Effect.sync(() => void entries.set(entry.entryId, entry)),
    readEntry: (_vault, id) => Effect.sync(() => entries.get(id) ?? null),
    readIndex: () => Effect.sync(() => index),
    compareAndSwapIndex: (_vault, _expected, next) =>
      Effect.sync(() => {
        index = next;
        return 'Committed' as const;
      }),
    deleteUnreferenced: (_vault, id) =>
      Effect.gen(function* () {
        if (failNextDelete) {
          failNextDelete = false;
          return;
        }
        entries.delete(id);
      }),
  };
  const journal: RecoveryVaultLocalStore['Service'] = {
    read: (key) => Effect.sync(() => local.get(key) ?? null),
    compareAndSwap: (key, _expected, next) =>
      Effect.sync(() => {
        local.set(key, new Uint8Array(next));
        return 'Committed' as const;
      }),
    list: (prefix) =>
      Effect.sync(() =>
        [...local].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))
      ),
  };
  return {
    entries,
    local,
    store,
    journal,
    getIndex: () => index,
    setIndex: (value: VaultCiphertext | null) => {
      index = value;
    },
    failDeleteOnce: () => {
      failNextDelete = true;
    },
  };
};

const syntheticPrf = (credentialId: string, seedByte: number) => {
  const secret = Buffer.alloc(32, seedByte);
  const prfBytes = createHmac('sha256', secret).update(vaultPrfInput()).digest();
  return Effect.gen(function* () {
    const registration = yield* verifiedPasskeyRegistration({
      credentialId,
      extension: { enabled: true },
    });
    const assertion = yield* verifiedPasskeyPrf({
      credentialId,
      userVerified: true,
      extension: { results: { first: new Uint8Array(prfBytes).slice().buffer } },
    });
    return { registration, assertion };
  });
};

describe('recovery vault password & passkey-first workflows', () => {
  it('enforces NFC normalization and password length bounds', () => {
    expect(MIN_RECOVERY_PASSWORD_LENGTH).toBe(12);
    const composed = normalizeRecoveryPassword('caf\u00e9-recovery-key');
    const decomposed = normalizeRecoveryPassword('cafe\u0301-recovery-key');
    expect(Buffer.from(composed).equals(Buffer.from(decomposed))).toBe(true);
    composed.fill(0);
    decomposed.fill(0);

    expect(() => normalizeRecoveryPassword('short-pass!')).toThrow();
    expect(() => normalizeRecoveryPassword('x'.repeat(1025))).toThrow();
  });

  it('creates and opens a vault with DEFAULT_PASSWORD_KDF and NFC-equivalent password', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeStores();
          const { vault } = yield* createRecoveryVaultWithPassword({
            locator: 'https://api.lody.test',
            password: 'caf\u00e9-battery-staple',
            kdf: DEFAULT_PASSWORD_KDF,
            store: harness.store,
            local: harness.journal,
          });
          expect(yield* vault.hasPassword()).toBe(true);
          expect(yield* vault.hasRecoveryFile()).toBe(false);

          const reopened = yield* openRecoveryVaultWithPassword({
            vaultId: vault.vaultId,
            locator: vault.locator,
            password: 'cafe\u0301-battery-staple',
            store: harness.store,
            local: harness.journal,
          });
          expect(reopened.vaultId).toBe(vault.vaultId);
        })
      )
    );
  });

  it('shares one master key V across passkey creation, password wrap, and offline recovery file', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeStores();
          const freshDeviceJournal = makeStores().journal;
          const vaultId = yield* generateRecoveryVaultId();
          expect(passkeyUserHandle(vaultId)).toHaveLength(32);

          const credId = 'AQIDBAUGBwgJCgsMDQ4PEA';
          const firstCeremony = yield* syntheticPrf(credId, 7);
          const { vault } = yield* createRecoveryVaultWithPasskey({
            vaultId,
            locator: 'https://api.lody.test',
            registration: firstCeremony.registration,
            assertion: firstCeremony.assertion,
            label: 'MacBook Touch ID',
            store: harness.store,
            local: harness.journal,
          });
          disposePrf(firstCeremony.assertion);

          expect(yield* vault.hasRecoveryFile()).toBe(false);
          expect(yield* vault.hasPassword()).toBe(false);

          const pkg = yield* generateRecoveryPackage({
            genesis: 'aa'.repeat(32),
            membershipId: 'bb'.repeat(16),
            generation: 0,
            trust: {
              source: 'ledger-tip',
              genesisRecord: new Uint8Array(64).fill(5),
              head: 'cc'.repeat(32),
              length: 1,
            },
          });
          const uploaded = yield* vault.upload(pkg);
          const reserved = yield* vault.reserve(uploaded);
          expect(reserved.outcome).toBe('Committed');

          // Add password wrap and offline recovery file to the same vault
          yield* vault.setPassword({ password: 'correct-horse-battery', kdf: FAST_KDF });
          const { recoveryFile } = yield* vault.createRecoveryFile();
          expect(yield* vault.hasRecoveryFile()).toBe(true);
          expect(yield* vault.hasPassword()).toBe(true);

          // Unlock via password on a brand new device (empty local journal)
          const viaPassword = yield* openRecoveryVaultWithPassword({
            vaultId,
            locator: 'https://api.lody.test',
            password: 'correct-horse-battery',
            store: harness.store,
            local: freshDeviceJournal,
          });
          const fromPassword = yield* viaPassword.readEntry(uploaded);
          expect(Buffer.from(fromPassword.signingPrivate)).toEqual(Buffer.from(pkg.signingPrivate));
          wipeRecoveryPackage(fromPassword);

          // Unlock via recovery file
          const viaFile = yield* openRecoveryVault({
            recoveryFile,
            store: harness.store,
            local: makeStores().journal,
          });
          const fromFile = yield* viaFile.readEntry(uploaded);
          expect(Buffer.from(fromFile.signingPrivate)).toEqual(Buffer.from(pkg.signingPrivate));
          wipeRecoveryPackage(fromFile);

          // Unlock via passkey
          const secondCeremony = yield* syntheticPrf(credId, 7);
          const viaPasskey = yield* openRecoveryVaultWithPasskey({
            vaultId,
            locator: 'https://api.lody.test',
            credential: secondCeremony.assertion,
            store: harness.store,
            local: makeStores().journal,
          });
          disposePrf(secondCeremony.assertion);
          const fromPasskey = yield* viaPasskey.readEntry(uploaded);
          expect(Buffer.from(fromPasskey.signingPrivate)).toEqual(Buffer.from(pkg.signingPrivate));
          wipeRecoveryPackage(fromPasskey);
          wipeRecoveryPackage(pkg);
          recoveryFile.fill(0);
        })
      )
    );
  });

  it('rejects KDF parameter tampering and out-of-bounds KDF parameters', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeStores();
          const belowFloor = yield* Effect.result(
            createRecoveryVaultWithPassword({
              locator: 'https://api.lody.test',
              password: 'valid-long-password',
              kdf: { m: MIN_PASSWORD_KDF.m - 1, t: 2, p: 1 },
              store: harness.store,
              local: harness.journal,
            })
          );
          expect(Result.isFailure(belowFloor) ? belowFloor.failure : null).toMatchObject({
            code: 'invalid-input',
          });

          const aboveCeiling = yield* Effect.result(
            createRecoveryVaultWithPassword({
              locator: 'https://api.lody.test',
              password: 'valid-long-password',
              kdf: { m: MAX_PASSWORD_KDF.m + 1, t: 3, p: 1 },
              store: harness.store,
              local: harness.journal,
            })
          );
          expect(Result.isFailure(aboveCeiling) ? aboveCeiling.failure : null).toMatchObject({
            code: 'invalid-input',
          });

          const { vault, entryId } = yield* createRecoveryVaultWithPassword({
            locator: 'https://api.lody.test',
            password: 'valid-long-password',
            kdf: FAST_KDF,
            store: harness.store,
            local: harness.journal,
          });
          const original = harness.entries.get(entryId)!;
          const tuple = decode(original.body) as [
            string,
            number,
            Uint8Array,
            number,
            number,
            number,
            Uint8Array,
          ];
          // Tamper with iteration count t inside the outer CBOR envelope
          const tamperedBody = encode([
            tuple[0],
            tuple[1],
            tuple[2],
            tuple[3],
            tuple[4] + 1,
            tuple[5],
            tuple[6],
          ]);
          harness.entries.set(
            entryId,
            ownVaultCiphertext({ entryId, revision: 0, body: tamperedBody })
          );

          const tamperedOpen = yield* Effect.result(
            openRecoveryVaultWithPassword({
              vaultId: vault.vaultId,
              locator: vault.locator,
              password: 'valid-long-password',
              store: harness.store,
              local: makeStores().journal,
            })
          );
          expect(Result.isFailure(tamperedOpen) ? tamperedOpen.failure : null).toMatchObject({
            code: 'authentication',
          });
        })
      )
    );
  });

  it('rotates and removes passwords safely across delete failures and blocks index rollback', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const harness = makeStores();
          const { vault } = yield* createRecoveryVaultWithPassword({
            locator: 'https://api.lody.test',
            password: 'first-password-1234',
            kdf: FAST_KDF,
            store: harness.store,
            local: harness.journal,
          });
          const gen0Id = passwordWrapEntryId(vault.vaultId, 0);
          expect(harness.entries.has(gen0Id)).toBe(true);
          const indexWithGen0 = harness.getIndex();

          // Rotate password while deleteUnreferenced fails on gen 0
          harness.failDeleteOnce();
          const gen1Id = yield* vault.setPassword({
            password: 'second-password-5678',
            kdf: FAST_KDF,
          });
          expect(gen1Id).toBe(passwordWrapEntryId(vault.vaultId, 1));
          // Gen 0 wrap still lingers on remote store, and local journal tracks pending removal
          expect(harness.entries.has(gen0Id)).toBe(true);
          expect(yield* vault.pendingPasswordRemovals()).toEqual([gen0Id]);

          // Even though gen 0 ciphertext is still present, old password MUST fail authentication
          // because the signed/authenticated index points to gen 1!
          const oldAttempt = yield* Effect.result(
            openRecoveryVaultWithPassword({
              vaultId: vault.vaultId,
              locator: vault.locator,
              password: 'first-password-1234',
              store: harness.store,
              local: makeStores().journal,
            })
          );
          expect(Result.isFailure(oldAttempt) ? oldAttempt.failure : null).toMatchObject({
            code: 'authentication',
          });

          // New password opens cleanly
          const newOpened = yield* openRecoveryVaultWithPassword({
            vaultId: vault.vaultId,
            locator: vault.locator,
            password: 'second-password-5678',
            store: harness.store,
            local: makeStores().journal,
          });
          expect(newOpened.vaultId).toBe(vault.vaultId);

          // Remove password when delete fails once, then retry removePassword to finish cleanup
          harness.failDeleteOnce();
          const failedRemove = yield* Effect.result(vault.removePassword());
          expect(Result.isFailure(failedRemove) ? failedRemove.failure : null).toMatchObject({
            code: 'storage',
          });
          expect(yield* vault.hasPassword()).toBe(false);

          // Password cannot unlock once index omits `password`, even before delete completes
          const removedAttempt = yield* Effect.result(
            openRecoveryVaultWithPassword({
              vaultId: vault.vaultId,
              locator: vault.locator,
              password: 'second-password-5678',
              store: harness.store,
              local: makeStores().journal,
            })
          );
          expect(Result.isFailure(removedAttempt) ? removedAttempt.failure : null).toMatchObject({
            code: 'authentication',
          });

          // Retry removePassword flushes both pending deletes
          yield* vault.removePassword();
          expect(yield* vault.pendingPasswordRemovals()).toEqual([]);
          expect(harness.entries.has(gen0Id)).toBe(false);
          expect(harness.entries.has(gen1Id)).toBe(false);

          // Simulate malicious server rolling back index to revision 0 (when gen 0 was active)
          harness.setIndex(indexWithGen0);
          const rollbackAttempt = yield* Effect.result(
            openRecoveryVaultWithPassword({
              vaultId: vault.vaultId,
              locator: vault.locator,
              password: 'first-password-1234',
              store: harness.store,
              local: harness.journal,
            })
          );
          expect(Result.isFailure(rollbackAttempt) ? rollbackAttempt.failure : null).toMatchObject({
            code: 'rollback',
          });
        })
      )
    );
  });

  it('exposes createWithPassword and openWithPassword through the RecoveryVaults service layer', async () => {
    const harness = makeStores();
    const layer = RecoveryVaults.layer.pipe(
      Layer.provide(Layer.succeed(RecoveryVaultStore, harness.store)),
      Layer.provide(Layer.succeed(RecoveryVaultLocalStore, harness.journal))
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const vaults = yield* RecoveryVaults;
          const { vault } = yield* vaults.createWithPassword({
            locator: 'https://api.lody.test',
            password: 'service-layer-password',
            kdf: FAST_KDF,
          });
          const opened = yield* vaults.openWithPassword({
            vaultId: vault.vaultId,
            locator: vault.locator,
            password: 'service-layer-password',
          });
          expect(opened.vaultId).toBe(vault.vaultId);
        }).pipe(Effect.provide(layer))
      )
    );
  });
});
