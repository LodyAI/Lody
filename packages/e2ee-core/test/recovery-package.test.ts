import { createHmac } from 'node:crypto';
import { Effect, Result } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// Probe: record every CBOR decode input/output and encode output so the test can
// observe the temporaries that hold decrypted package secrets.
const probe = vi.hoisted(() => ({
  inputs: [] as Uint8Array[],
  decoded: [] as unknown[],
  encoded: [] as Uint8Array[],
}));
vi.mock('@ipld/dag-cbor', async (original) => {
  const actual = await original<typeof import('@ipld/dag-cbor')>();
  return {
    ...actual,
    decode: (bytes: Uint8Array) => {
      probe.inputs.push(bytes);
      const value = actual.decode(bytes);
      probe.decoded.push(value);
      return value;
    },
    encode: (value: unknown) => {
      const bytes = actual.encode(value);
      probe.encoded.push(bytes);
      return bytes;
    },
  };
});

import {
  canonical,
  ciphertextDigest,
  decryptVault,
  encryptVault,
  type VaultCiphertext,
} from '../src/internal/recovery/crypto';
import { deriveRecoveryAccessCredential } from '../src/internal/recovery/credential';
import { generateRecoveryPackage } from '../src/internal/recovery/identity';
import vaultVector from './recovery-vault-vector.json';
import {
  useCanonicalSecret,
  vaultPrfInput,
  verifiedPasskeyPrf,
} from '../src/internal/recovery/crypto';
import {
  createRecoveryVault,
  openRecoveryVault,
  openRecoveryVaultWithPasskey,
  ownRecoveryPackage,
  parseRecoveryFile,
  wipeRecoveryPackage,
  type RecoveryPrivatePackage,
  type RecoveryVaultLocalStore,
  type RecoveryVaultStore,
} from '../src/internal/recovery/vault';

const memoryStores = () => {
  const entries = new Map<string, VaultCiphertext>();
  const local = new Map<string, Uint8Array>();
  let index: VaultCiphertext | null = null;
  const store: RecoveryVaultStore = {
    putImmutable: (_vault, entry) => Effect.sync(() => void entries.set(entry.entryId, entry)),
    readEntry: (_vault, id) => Effect.sync(() => entries.get(id) ?? null),
    readIndex: () => Effect.sync(() => index),
    compareAndSwapIndex: (_vault, _expected, next) =>
      Effect.sync(() => {
        index = next;
        return 'Committed' as const;
      }),
    deleteUnreferenced: (_vault, id) => Effect.sync(() => void entries.delete(id)),
  };
  const journal: RecoveryVaultLocalStore = {
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
  return { store, local: journal };
};

const contains = (haystack: Uint8Array, needle: Uint8Array) =>
  Buffer.from(haystack).includes(Buffer.from(needle));
const seedOf = (pkcs8: Uint8Array) => pkcs8.slice(16, 48);
const privateLeaves = (value: unknown): Uint8Array[] =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (['signingPrivate', 'encryptionPrivate'] as const).flatMap((field) => {
        const leaf = (value as Record<string, unknown>)[field];
        return leaf instanceof Uint8Array ? [leaf] : [];
      })
    : [];
const resetProbe = () => {
  probe.inputs.length = 0;
  probe.decoded.length = 0;
  probe.encoded.length = 0;
};
/** Every probed temporary is wiped: decoded private fields are all zero and no
 * decode input or re-encoding still holds either private seed. */
const expectWiped = (seeds: readonly Uint8Array[]) => {
  const leaves = probe.decoded.flatMap(privateLeaves);
  expect(leaves.length).toBeGreaterThan(0);
  for (const leaf of leaves) expect(leaf.every((byte) => byte === 0)).toBe(true);
  for (const bytes of [...probe.inputs, ...probe.encoded])
    for (const seed of seeds) expect(contains(bytes, seed)).toBe(false);
};

describe('recovery package plaintext ownership', () => {
  it('wipes decoded secrets when readEntry or readCandidate rejects an invalid package, and returns owned copies on success', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stores = memoryStores();
          const { vault, recoveryFile } = yield* createRecoveryVault({
            locator: 'https://synthetic.invalid/vault',
            ...stores,
          });
          const file = parseRecoveryFile(recoveryFile);
          const wrapped = (yield* stores.store.readEntry(vault.vaultId, vault.vaultId))!;
          const master = decryptVault(file.unlock, vault.vaultId, wrapped, 'file-wrap');
          const bundle = yield* generateRecoveryPackage({
            genesis: '11'.repeat(32),
            membershipId: '22'.repeat(16),
            generation: 0,
            trust: {
              source: 'synthetic',
              genesisRecord: new Uint8Array(64).fill(3),
              head: '33'.repeat(32),
              length: 1,
            },
          });
          const seeds = [seedOf(bundle.signingPrivate), seedOf(bundle.encryptionPrivate)];
          const withPublic = new Uint8Array([
            0x30,
            0x51,
            0x02,
            0x01,
            0x01,
            ...bundle.signingPrivate.slice(5, 48),
            0x81,
            0x21,
            0x00,
            ...bundle.signingPublic,
          ]);
          const { formatVersion: _omitted, ...unversioned } = bundle;
          const invalid: Record<string, unknown> = {
            'missing version': unversioned,
            'other version': { ...bundle, formatVersion: 2 },
            'v2 with public key': { ...bundle, signingPrivate: withPublic },
            'wrong OID': {
              ...bundle,
              signingPrivate: bundle.encryptionPrivate,
              encryptionPrivate: bundle.signingPrivate,
            },
            'short encoding': { ...bundle, signingPrivate: bundle.signingPrivate.slice(0, 47) },
            'long encoding': {
              ...bundle,
              encryptionPrivate: new Uint8Array([...bundle.encryptionPrivate, 0]),
            },
          };
          const seal = (value: unknown, entryId: string) => {
            const plain = canonical(value);
            const entry = encryptVault(
              master,
              vault.vaultId,
              { entryId, revision: 0, previous: null, purpose: 'workspace-entry' },
              plain
            );
            plain.fill(0);
            return entry;
          };
          let n = 0;
          for (const [name, value] of Object.entries(invalid)) {
            const entryId = (++n).toString(16).padStart(64, '0');
            const entry = seal(value, entryId);
            yield* stores.store.putImmutable(vault.vaultId, entry);
            const ref = {
              genesis: bundle.genesis,
              membershipId: bundle.membershipId,
              generation: 0,
              entryId,
              digest: ciphertextDigest(entry),
              retired: false,
            };
            resetProbe();
            const read = yield* Effect.result(vault.readEntry(ref));
            expect(Result.isFailure(read), name).toBe(true);
            if (Result.isFailure(read))
              expect(read.failure, name).toMatchObject({ code: 'invalid-input' });
            expectWiped(seeds);
            resetProbe();
            const candidate = yield* Effect.result(vault.readCandidate(entryId));
            expect(Result.isFailure(candidate), name).toBe(true);
            expectWiped(seeds);
          }

          const ref = yield* vault.upload(bundle);
          resetProbe();
          const read: RecoveryPrivatePackage = yield* vault.readEntry(ref);
          expect(read.formatVersion).toBe(1);
          expect(read.signingPrivate).toEqual(bundle.signingPrivate);
          expect(read.encryptionPrivate).toEqual(bundle.encryptionPrivate);
          expectWiped(seeds);
          resetProbe();
          const candidate = (yield* vault.readCandidate(ref.entryId))!;
          expect(candidate.reference).toEqual(ref);
          expect(candidate.value.signingPrivate).toEqual(bundle.signingPrivate);
          expectWiped(seeds);
          wipeRecoveryPackage(read);
          wipeRecoveryPackage(candidate.value);
          wipeRecoveryPackage(bundle);
          master.fill(0);
        })
      )
    );
  });
});

// Owner-approved derivation (specs/e2ee/recovery-vault.md). Expected values were
// computed independently with node:crypto hkdfSync and createPublicKey.
const vector = {
  seed: '11'.repeat(32),
  genesis: '22'.repeat(32),
  signingPublic: 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737',
  credential: '877eeebbad52db5846de3cb827c84740496b6ecb8144e633c55c91d0634aec4f',
  credentialHash: '5fd92a223e8ab19ba207dc14962438830c5ee113eb221658af906376c01b28a8',
};
const hexBytes = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));
const vectorPackage = (): RecoveryPrivatePackage => ({
  formatVersion: 1,
  genesis: vector.genesis,
  membershipId: '33'.repeat(16),
  signingPublic: hexBytes(vector.signingPublic),
  encryptionPublic: new Uint8Array(32).fill(4),
  signingPrivate: hexBytes('302e020100300506032b657004220420' + vector.seed),
  encryptionPrivate: hexBytes('302e020100300506032b656e04220420' + '55'.repeat(32)),
  generation: 0,
  trust: {
    source: 'synthetic',
    genesisRecord: new Uint8Array(8).fill(6),
    head: '77'.repeat(32),
    length: 1,
  },
});

describe('recovery access credential', () => {
  it('derives the pinned credential and hash from R seed, genesis and public key', () => {
    const input = vectorPackage();
    const derived = deriveRecoveryAccessCredential(input);
    expect(Buffer.from(derived.credential).toString('hex')).toBe(vector.credential);
    expect(Buffer.from(derived.credentialHash).toString('hex')).toBe(vector.credentialHash);
    // The caller's package is borrowed, never wiped or changed.
    expect(input.signingPrivate).toEqual(vectorPackage().signingPrivate);
    const otherGenesis = deriveRecoveryAccessCredential({ ...input, genesis: '23'.repeat(32) });
    expect(otherGenesis.credentialHash).not.toEqual(derived.credentialHash);
  });

  it('refuses a public key that the seed does not derive and a non-RFC 8410 key', () => {
    const input = vectorPackage();
    expect(() =>
      deriveRecoveryAccessCredential({ ...input, signingPublic: new Uint8Array(32).fill(9) })
    ).toThrow(expect.objectContaining({ code: 'authentication' }));
    expect(() =>
      deriveRecoveryAccessCredential({
        ...input,
        signingPrivate: input.signingPrivate.slice(0, 47),
      })
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
  });
});

describe('recovery access credential lifetime', () => {
  // Probe: record every Uint8Array constructed while deriving, so library and
  // local temporaries (OKM, PRK, HMAC pads, hash blocks) can be inspected.
  const recordAllocations = <A>(work: () => A) => {
    const allocated: Uint8Array[] = [];
    const Original = globalThis.Uint8Array;
    globalThis.Uint8Array = new Proxy(Original, {
      construct(target, args, newTarget) {
        const value = Reflect.construct(target, args, newTarget) as Uint8Array;
        allocated.push(value);
        return value;
      },
    });
    try {
      return { result: work(), allocated };
    } catch (error) {
      return { error, allocated };
    } finally {
      globalThis.Uint8Array = Original;
    }
  };
  const holds = (buffer: Uint8Array, secret: Uint8Array) =>
    Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).includes(Buffer.from(secret));
  // Independent node:crypto values for the pinned vector.
  const prk = createHmac('sha256', hexBytes(vector.genesis)).update(hexBytes(vector.seed)).digest();
  const credential = hexBytes(vector.credential);

  it('leaves no credential or PRK in any temporary after success, and the returned copy is usable', () => {
    const input = vectorPackage();
    const { result, allocated } = recordAllocations(() => deriveRecoveryAccessCredential(input));
    expect(Buffer.from(result!.credential).toString('hex')).toBe(vector.credential);
    expect(Buffer.from(result!.credentialHash).toString('hex')).toBe(vector.credentialHash);
    expect(allocated.length).toBeGreaterThan(0);
    for (const buffer of allocated) {
      expect(holds(buffer, prk)).toBe(false);
      if (buffer.buffer !== result!.credential.buffer)
        expect(holds(buffer, credential)).toBe(false);
    }
    result!.credential.fill(0);
    wipeRecoveryPackage(input);
    for (const buffer of allocated) expect(holds(buffer, credential)).toBe(false);
  });

  it('leaves no credential or PRK after a refused derivation', () => {
    const input = { ...vectorPackage(), signingPublic: new Uint8Array(32).fill(9) };
    const { error, allocated } = recordAllocations(() => deriveRecoveryAccessCredential(input));
    expect(error).toMatchObject({ code: 'authentication' });
    for (const buffer of allocated) {
      expect(holds(buffer, prk)).toBe(false);
      expect(holds(buffer, credential)).toBe(false);
    }
  });
});

describe('independently encoded recovery vault', () => {
  const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
  const hexOf = (value: Uint8Array) => Buffer.from(value).toString('hex');
  const entry = (value: { entryId: string; revision: number; body: string }): VaultCiphertext => ({
    entryId: value.entryId,
    revision: value.revision,
    body: bytes(value.body),
  });
  const v = vaultVector;
  const expectedPackage = {
    ...v.package,
    signingPublic: bytes(v.package.signingPublic),
    encryptionPublic: bytes(v.package.encryptionPublic),
    signingPrivate: bytes(v.package.signingPrivate),
    encryptionPrivate: bytes(v.package.encryptionPrivate),
    trust: { ...v.package.trust, genesisRecord: bytes(v.package.trust.genesisRecord) },
  };
  const populated = (index: VaultCiphertext) =>
    Effect.gen(function* () {
      const stores = memoryStores();
      for (const wrap of [v.fileWrap, v.prfWrap, v.workspaceEntry])
        yield* stores.store.putImmutable(v.vaultId, entry(wrap));
      yield* stores.store.compareAndSwapIndex(v.vaultId, null, index, []);
      return stores;
    });
  const failureCode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.flip,
      Effect.map((error) => (error as { code?: string }).code)
    );

  it('keeps the recovery file, every wrap and the package bytes', () => {
    // Created outside this codebase; a failure means existing vaults stop opening.
    const file = bytes(v.recoveryFile);
    expect(parseRecoveryFile(file)).toEqual({
      vaultId: v.vaultId,
      locator: v.locator,
      unlock: bytes(v.unlock),
    });
    expect(hexOf(canonical(['vault-v1', 1, v.vaultId, v.locator, bytes(v.unlock)]))).toBe(
      v.recoveryFile
    );
    expect(vaultPrfInput()).toEqual(bytes(v.prfInput));
    for (const [wrap, secret, purpose] of [
      [v.fileWrap, v.unlock, 'file-wrap'],
      [v.prfWrap, v.prfOutput, 'prf-wrap'],
    ] as const) {
      expect(ciphertextDigest(entry(wrap))).toBe(wrap.digest);
      expect(decryptVault(bytes(secret), v.vaultId, entry(wrap), purpose)).toEqual(bytes(v.master));
    }
    const plain = decryptVault(
      bytes(v.master),
      v.vaultId,
      entry(v.workspaceEntry),
      'workspace-entry'
    );
    expect(plain).toEqual(bytes(v.workspaceEntry.plaintext));
    const owned = useCanonicalSecret(plain, (value) =>
      ownRecoveryPackage(value as RecoveryPrivatePackage)
    );
    expect(owned).toEqual(expectedPackage);
    expect(hexOf(canonical(owned))).toBe(v.workspaceEntry.plaintext);
    for (const index of [v.indexFirst, v.index]) {
      expect(ciphertextDigest(entry(index))).toBe(index.digest);
      expect(decryptVault(bytes(v.master), v.vaultId, entry(index), 'index')).toEqual(
        bytes(index.plaintext)
      );
    }
  });

  it('opens with the recovery file and with the passkey, and reads the index and package', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const byFile = yield* openRecoveryVault({
            ...(yield* populated(entry(v.index))),
            recoveryFile: bytes(v.recoveryFile),
          });
          const index = yield* byFile.readIndex();
          expect(index.value).toEqual(v.expectedIndex);
          expect(yield* byFile.readEntry(v.expectedIndex.entries[0]!)).toEqual(expectedPackage);
          const prf = yield* verifiedPasskeyPrf({
            credentialId: v.credentialId,
            userVerified: true,
            extension: { results: { first: bytes(v.prfOutput).slice().buffer } },
          });
          const byPasskey = yield* openRecoveryVaultWithPasskey({
            ...(yield* populated(entry(v.index))),
            vaultId: v.vaultId,
            locator: v.locator,
            credential: prf,
          });
          expect((yield* byPasskey.readIndex()).value).toEqual(v.expectedIndex);
        })
      )
    ));

  it.each(v.negative.recoveryFiles)('refuses a recovery file with $name', (vector) => {
    expect(() => parseRecoveryFile(bytes(vector.hex))).toThrow();
  });

  it.each(v.negative.ciphertexts)('refuses a ciphertext with $name', (vector) => {
    expect(() =>
      decryptVault(
        bytes(vector.secret),
        vector.vaultId,
        entry(vector.entry),
        vector.purpose as 'file-wrap' | 'prf-wrap'
      )
    ).toThrow(expect.objectContaining({ code: 'authentication' }));
  });

  it.each(v.negative.packages)('refuses a package with $name', (vector) => {
    expect(() =>
      useCanonicalSecret(bytes(vector.hex), (value) =>
        ownRecoveryPackage(value as RecoveryPrivatePackage)
      )
    ).toThrow();
  });

  it.each(v.negative.indexes)('refuses an index with $name', (vector) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const vault = yield* openRecoveryVault({
            ...(yield* populated(entry(vector.entry))),
            recoveryFile: bytes(v.recoveryFile),
          });
          expect(yield* failureCode(vault.readIndex())).toBe(vector.code);
        })
      )
    )
  );
});
