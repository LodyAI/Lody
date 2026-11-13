import { Deferred, Effect, Exit, Result, Schema, Semaphore } from 'effect';
import type {
  RecoveryVaultLocalStore as RecoveryVaultLocalStorePort,
  RecoveryVaultStore as RecoveryVaultStorePort,
} from '../../services/recovery';
import { bytesEqual } from '../foundation/cbor';
import {
  canonical,
  parseCanonical,
  random,
  hex,
  digest,
  fromHex,
  attempt,
  vaultError,
  encryptVault,
  decryptVault,
  encryptPasswordWrap,
  decryptPasswordWrap,
  normalizeRecoveryPassword,
  ownCiphertext,
  sameCiphertext,
  ciphertextDigest,
  usePrf,
  useCanonicalSecret,
  isVerifiedPasskeyRegistration,
  DEFAULT_PASSWORD_KDF,
  type PasswordKdfParams,
  type VaultCiphertext,
  type VerifiedPasskeyPrf,
  type VerifiedPasskeyRegistration,
} from './crypto';

/** Shape of the {@link RecoveryVaultStorePort} backend port. */
export type RecoveryVaultStore = RecoveryVaultStorePort['Service'];
/** Shape of the {@link RecoveryVaultLocalStorePort} local storage port. */
export type RecoveryVaultLocalStore = RecoveryVaultLocalStorePort['Service'];
const TrustSchema = Schema.Struct({
  source: Schema.String,
  genesisRecord: Schema.Uint8Array,
  head: Schema.String,
  length: Schema.Number,
});
const PackageSchema = Schema.Struct({
  formatVersion: Schema.Literal(1),
  genesis: Schema.String,
  membershipId: Schema.String,
  signingPublic: Schema.Uint8Array,
  encryptionPublic: Schema.Uint8Array,
  signingPrivate: Schema.Uint8Array,
  encryptionPrivate: Schema.Uint8Array,
  generation: Schema.Number,
  trust: TrustSchema,
});
/** The private recovery package (recovery device keys and vault unlock material) the user keeps offline. Wipe it with `wipeRecoveryPackage` after use. */
export type RecoveryPrivatePackage = typeof PackageSchema.Type;
// RFC 8410 OneAsymmetricKey v1 without attributes or public key: the exact
// 48-byte PKCS#8 that WebCrypto exports for Ed25519 (OID 1.3.101.112) and
// X25519 (OID 1.3.101.110). Any other DER, version or algorithm is rejected.
const pkcs8Prefix = (oid: number) =>
  Uint8Array.of(
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    oid,
    0x04,
    0x22,
    0x04,
    0x20
  );
const isRfc8410Pkcs8 = (bytes: Uint8Array, oid: number) =>
  bytes.length === 48 && bytesEqual(bytes.subarray(0, 16), pkcs8Prefix(oid));
export function ownRecoveryPackage(input: RecoveryPrivatePackage): RecoveryPrivatePackage {
  const value = Result.getOrThrow(Schema.decodeUnknownResult(PackageSchema)(input));
  fromHex(value.genesis);
  fromHex(value.membershipId, 16);
  fromHex(value.trust.head);
  if (
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !Number.isSafeInteger(value.trust.length) ||
    value.trust.length < 1 ||
    !value.trust.source ||
    value.trust.source.length > 2048 ||
    value.trust.genesisRecord.length > 8192 ||
    value.signingPublic.length !== 32 ||
    value.encryptionPublic.length !== 32 ||
    !isRfc8410Pkcs8(value.signingPrivate, 0x70) ||
    !isRfc8410Pkcs8(value.encryptionPrivate, 0x6e)
  )
    throw vaultError('invalid-input');
  return {
    ...value,
    signingPublic: new Uint8Array(value.signingPublic),
    encryptionPublic: new Uint8Array(value.encryptionPublic),
    signingPrivate: new Uint8Array(value.signingPrivate),
    encryptionPrivate: new Uint8Array(value.encryptionPrivate),
    trust: { ...value.trust, genesisRecord: new Uint8Array(value.trust.genesisRecord) },
  };
}
/** Overwrite a private recovery package's secret bytes. */
export function wipeRecoveryPackage(value: RecoveryPrivatePackage) {
  value.signingPrivate.fill(0);
  value.encryptionPrivate.fill(0);
}
/** Reference from a vault index to one workspace entry (workspace, membership, entry id, digest, generation). */
export interface RecoveryEntryReference {
  readonly genesis: string;
  readonly membershipId: string;
  readonly entryId: string;
  readonly digest: string;
  readonly generation: number;
  readonly retired: boolean;
}
const ReferenceSchema = Schema.Struct({
  genesis: Schema.String,
  membershipId: Schema.String,
  entryId: Schema.String,
  digest: Schema.String,
  generation: Schema.Number,
  retired: Schema.Boolean,
});
/** One enrolled passkey. CAS references its wrap, so the service refuses to delete it. */
export interface RecoveryPasskeyReference {
  readonly entryId: string;
  readonly credentialId: string;
  readonly label: string;
}
const PasskeySchema = Schema.Struct({
  entryId: Schema.String,
  credentialId: Schema.String,
  label: Schema.String,
});
/** Active password wrap listed in the vault index; CAS references `entryId` against deletion. */
export interface RecoveryPasswordReference {
  readonly entryId: string;
  readonly generation: number;
}
const PasswordSchema = Schema.Struct({
  entryId: Schema.String,
  generation: Schema.Number,
});
const MAX_VAULT_PASSKEYS = 8;
/** Maximum number of monotonic password-wrap generations a single vault can allocate. */
export const MAX_VAULT_PASSWORD_GENERATIONS = 8;
const IndexSchema = Schema.Struct({
  entries: Schema.Array(ReferenceSchema),
  passkeys: Schema.optional(Schema.Array(PasskeySchema)),
  password: Schema.optional(PasswordSchema),
  passwordGeneration: Schema.optional(Schema.Number),
});
export type RecoveryVaultIndex = typeof IndexSchema.Type;
const RemovalSchema = Schema.Struct({ label: Schema.String, done: Schema.Boolean });
const decodeRemoval = (raw: Uint8Array) =>
  Result.getOrThrow(Schema.decodeUnknownResult(RemovalSchema)(parseCanonical(raw)));
const PasswordRemovalSchema = Schema.Struct({ done: Schema.Boolean });
const decodePasswordRemoval = (raw: Uint8Array) =>
  Result.getOrThrow(Schema.decodeUnknownResult(PasswordRemovalSchema)(parseCanonical(raw)));
const passkeysOf = (value: RecoveryVaultIndex): readonly RecoveryPasskeyReference[] =>
  value.passkeys ?? [];
/** Deterministic entry ID for one vault's password wrap at `generation` (`0..7`). */
export const passwordWrapEntryId = (vaultId: string, generation: number): string => {
  fromHex(vaultId);
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation >= MAX_VAULT_PASSWORD_GENERATIONS
  )
    throw vaultError('invalid-input');
  return digest(canonical(['vault-v1', vaultId, 'password-wrap', generation]));
};
/** Generate a fresh 32-byte hex vault identifier before running a creation ceremony. */
export const generateRecoveryVaultId = () => attempt(() => hex(random(32)));
type IndexFields = {
  readonly entries: readonly RecoveryEntryReference[];
  readonly passkeys: readonly RecoveryPasskeyReference[];
  readonly password?: RecoveryPasswordReference | undefined;
  readonly passwordGeneration?: number | undefined;
};
/** The index plaintext; a vault with no passkeys or password keeps its existing `{ entries }` bytes. */
const indexPlain = (value: IndexFields) =>
  canonical({
    entries: value.entries,
    ...(value.passkeys.length > 0 ? { passkeys: value.passkeys } : {}),
    ...(value.password ? { password: value.password } : {}),
    ...(value.passwordGeneration !== undefined && value.passwordGeneration > 0
      ? { passwordGeneration: value.passwordGeneration }
      : {}),
  });
const indexReferences = (value: IndexFields) => [
  ...value.entries.map((ref) => ref.entryId),
  ...value.passkeys.map((ref) => ref.entryId),
  ...(value.password ? [value.password.entryId] : []),
];
const passkeyEntryId = (vaultId: string, credentialId: string) =>
  digest(canonical(['vault-v1', vaultId, credentialId]));
function parseIndex(input: Uint8Array, vaultId: string): RecoveryVaultIndex {
  const value = Result.getOrThrow(Schema.decodeUnknownResult(IndexSchema)(parseCanonical(input)));
  if (value.entries.length > 1024) throw vaultError('invalid-input');
  const passkeys = passkeysOf(value);
  if (
    passkeys.length > MAX_VAULT_PASSKEYS ||
    new Set(passkeys.map((ref) => ref.entryId)).size !== passkeys.length ||
    passkeys.some(
      (ref) =>
        ref.entryId !== passkeyEntryId(vaultId, ref.credentialId) ||
        !ref.label ||
        ref.label.length > 128
    )
  )
    throw vaultError('invalid-input');
  if (value.password !== undefined) {
    if (
      !Number.isSafeInteger(value.password.generation) ||
      value.password.generation < 0 ||
      value.password.generation >= MAX_VAULT_PASSWORD_GENERATIONS ||
      value.password.entryId !== passwordWrapEntryId(vaultId, value.password.generation)
    )
      throw vaultError('invalid-input');
  }
  if (value.passwordGeneration !== undefined) {
    if (
      !Number.isSafeInteger(value.passwordGeneration) ||
      value.passwordGeneration < 0 ||
      value.passwordGeneration > MAX_VAULT_PASSWORD_GENERATIONS ||
      (value.password !== undefined && value.passwordGeneration <= value.password.generation)
    )
      throw vaultError('invalid-input');
  }
  const active = new Set<string>();
  for (const ref of value.entries) {
    fromHex(ref.genesis);
    fromHex(ref.membershipId, 16);
    fromHex(ref.entryId);
    fromHex(ref.digest);
    if (!Number.isSafeInteger(ref.generation) || ref.generation < 0)
      throw vaultError('invalid-input');
    const key = `${ref.genesis}/${ref.membershipId}`;
    if (!ref.retired && active.has(key)) throw vaultError('conflict');
    if (!ref.retired) active.add(key);
  }
  return value;
}
const indexId = (vaultId: string) => digest(canonical(['vault-v1', vaultId, 'index']));
const FileSchema = Schema.Tuple([
  Schema.Literal('vault-v1'),
  Schema.Literal(1),
  Schema.String,
  Schema.String,
  Schema.Uint8Array,
]);
/** Parse and validate a recovery file (vault id, locator and wrapped unlock secret). */
export function parseRecoveryFile(input: Uint8Array) {
  const value = Result.getOrThrow(Schema.decodeUnknownResult(FileSchema)(parseCanonical(input)));
  fromHex(value[2]);
  if (!value[3] || value[3].length > 2048 || value[4].length !== 32)
    throw vaultError('invalid-input');
  return { vaultId: value[2], locator: value[3], unlock: new Uint8Array(value[4]) };
}
const PinSchema = Schema.Struct({ revision: Schema.Number, digest: Schema.String });
const PendingIndexIntent = Schema.Struct({
  completed: Schema.Literal(false),
  expected: Schema.NullOr(PinSchema),
  next: Schema.Struct({ entryId: Schema.String, revision: Schema.Number, body: Schema.Uint8Array }),
});
/** Holds V only for this Scope. All plaintext entry copies are operation owned. */
const makeSession = Effect.fnUntraced(function* (input: {
  vaultId: string;
  locator: string;
  master: Uint8Array;
  store: RecoveryVaultStore;
  local: RecoveryVaultLocalStore;
}) {
  const vaultId = input.vaultId,
    locator = input.locator,
    master = new Uint8Array(input.master),
    store = input.store,
    local = input.local;
  input.master.fill(0);
  let closed = false;
  const mutex = yield* Semaphore.make(1);
  let readers = 0;
  const readsDrained = Deferred.makeUnsafe<void>();
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* mutex.withPermit(
        Effect.sync(() => {
          closed = true;
          master.fill(0);
        })
      );
      // Entry readers own independent key copies. Close stops admission, then
      // waits for their actual network/decryption settlement before returning.
      if (readers > 0) yield* Deferred.await(readsDrained);
    })
  );
  const ownedOperation = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    mutex.withPermit(Effect.uninterruptible(work));
  const guard = () => {
    if (closed) throw vaultError('closed');
  };
  const pinKey = `vault-v1/${vaultId}/index-pin`;
  const removalPrefix = `vault-v1/${vaultId}/passkey-removal/`;
  const removalKey = (entryId: string) => `${removalPrefix}${entryId}`;
  const passwordRemovalPrefix = `vault-v1/${vaultId}/password-removal/`;
  const passwordRemovalKey = (entryId: string) => `${passwordRemovalPrefix}${entryId}`;
  const persist = Effect.fnUntraced(function* (
    key: string,
    expected: Uint8Array | null,
    next: Uint8Array
  ) {
    if ((yield* local.compareAndSwap(key, expected, next)) !== 'Committed')
      return yield* vaultError('conflict');
    const read = yield* local.read(key);
    if (!read || !bytesEqual(next, read)) return yield* vaultError('storage');
    return yield* Effect.void;
  });
  const index = Effect.fnUntraced(function* () {
    yield* attempt(guard);
    const before = yield* local.read(pinKey),
      remote = yield* store.readIndex(vaultId);
    const pin =
      before === null
        ? null
        : yield* attempt(() =>
            Result.getOrThrow(Schema.decodeUnknownResult(PinSchema)(parseCanonical(before)))
          );
    if (!remote) {
      if (pin) return yield* vaultError('rollback');
      return { header: null, value: { entries: [] } as RecoveryVaultIndex };
    }
    const header = yield* attempt(() => ownCiphertext(remote));
    if (header.entryId !== indexId(vaultId)) return yield* vaultError('authentication');
    const hash = ciphertextDigest(header);
    if (
      pin &&
      (header.revision < pin.revision || (header.revision === pin.revision && hash !== pin.digest))
    )
      return yield* vaultError('rollback');
    const value = yield* Effect.acquireUseRelease(
      attempt(() => decryptVault(master, vaultId, header, 'index')),
      (plain) => attempt(() => parseIndex(plain, vaultId)),
      (plain) => Effect.sync(() => plain.fill(0))
    );
    if (!pin || pin.revision !== header.revision)
      yield* persist(pinKey, before, canonical({ revision: header.revision, digest: hash }));
    const intents = yield* local.list(`vault-v1/${vaultId}/index-intent/`);
    for (const row of intents) {
      const parsed = yield* attempt(() => parseCanonical(row.value));
      const pending = Schema.decodeUnknownResult(PendingIndexIntent)(parsed);
      if (
        Result.isSuccess(pending) &&
        header.revision > (pending.success.expected?.revision ?? -1)
      ) {
        yield* persist(
          row.key,
          row.value,
          canonical({ completed: true, entryId: row.key.slice(row.key.lastIndexOf('/') + 1) })
        );
      }
    }
    yield* attempt(guard);
    return { header, value };
  });
  const readEntry = Effect.fnUntraced(function* (ref: RecoveryEntryReference, readMaster = master) {
    yield* attempt(guard);
    const remote = yield* store.readEntry(vaultId, ref.entryId);
    if (!remote) return yield* vaultError('missing');
    const header = yield* attempt(() => ownCiphertext(remote));
    if (ciphertextDigest(header) !== ref.digest) return yield* vaultError('authentication');
    return yield* Effect.acquireUseRelease(
      attempt(() => decryptVault(readMaster, vaultId, header, 'workspace-entry')),
      (plain) =>
        attempt(() => {
          // ownRecoveryPackage returns copies; the decoded temporaries are wiped.
          const value = useCanonicalSecret(plain, (decoded) =>
            ownRecoveryPackage(decoded as RecoveryPrivatePackage)
          );
          if (
            value.genesis !== ref.genesis ||
            value.membershipId !== ref.membershipId ||
            value.generation !== ref.generation
          ) {
            wipeRecoveryPackage(value);
            throw vaultError('authentication');
          }
          return value;
        }),
      (plain) => Effect.sync(() => plain.fill(0))
    );
  });
  const upload = Effect.fnUntraced(function* (source: RecoveryPrivatePackage, entryId: string) {
    yield* attempt(guard);
    const value = yield* attempt(() => ownRecoveryPackage(source));
    return yield* Effect.acquireUseRelease(
      Effect.succeed(value),
      (owned) =>
        Effect.gen(function* () {
          const bytes = yield* attempt(() => canonical(owned));
          const entry = yield* Effect.acquireUseRelease(
            Effect.succeed(bytes),
            (plain) =>
              attempt(() =>
                encryptVault(
                  master,
                  vaultId,
                  { entryId, revision: 0, previous: null, purpose: 'workspace-entry' },
                  plain
                )
              ),
            (plain) => Effect.sync(() => plain.fill(0))
          );
          yield* store.putImmutable(vaultId, entry);
          const reread = yield* store.readEntry(vaultId, entry.entryId);
          if (!reread || !sameCiphertext(entry, reread)) return yield* vaultError('storage');
          const reference: RecoveryEntryReference = {
            genesis: owned.genesis,
            membershipId: owned.membershipId,
            generation: owned.generation,
            entryId,
            digest: ciphertextDigest(entry),
            retired: false,
          };
          yield* Effect.acquireUseRelease(
            readEntry(reference),
            (decoded) =>
              attempt(() => {
                if (
                  !bytesEqual(decoded.signingPrivate, owned.signingPrivate) ||
                  !bytesEqual(decoded.encryptionPrivate, owned.encryptionPrivate)
                )
                  throw vaultError('authentication');
              }),
            (decoded) => Effect.sync(() => wipeRecoveryPackage(decoded))
          );
          return reference;
        }),
      (owned) => Effect.sync(() => wipeRecoveryPackage(owned))
    );
  });
  const commitFields = Effect.fnUntraced(function* (
    before: Effect.Success<ReturnType<typeof index>>,
    fields: IndexFields
  ) {
    const next = yield* Effect.acquireUseRelease(
      attempt(() => indexPlain(fields)),
      (plain) =>
        attempt(() =>
          encryptVault(
            master,
            vaultId,
            {
              entryId: indexId(vaultId),
              revision: (before.header?.revision ?? -1) + 1,
              previous: before.header ? ciphertextDigest(before.header) : null,
              purpose: 'index',
            },
            plain
          )
        ),
      (plain) => Effect.sync(() => plain.fill(0))
    );
    const outcome = yield* store.compareAndSwapIndex(
      vaultId,
      before.header
        ? { revision: before.header.revision, digest: ciphertextDigest(before.header) }
        : null,
      next,
      indexReferences(fields)
    );
    if (outcome !== 'Committed') return yield* vaultError('conflict');
  });
  const reserve = Effect.fnUntraced(function* (
    candidate: RecoveryEntryReference,
    replace: boolean = false
  ) {
    const before = yield* index(),
      existing = before.value.entries.find(
        (ref) =>
          !ref.retired &&
          ref.genesis === candidate.genesis &&
          ref.membershipId === candidate.membershipId
      );
    if (existing && !replace) return { outcome: 'Existing' as const, reference: existing };
    if (replace && (!existing || candidate.generation <= existing.generation))
      return yield* vaultError('conflict');
    // Decrypt candidate again before selecting it; uploading alone proves nothing.
    yield* Effect.acquireUseRelease(
      readEntry(candidate),
      () => Effect.void,
      (owned) => Effect.sync(() => wipeRecoveryPackage(owned))
    );
    const entries = before.value.entries.map((ref) =>
      existing && ref.entryId === existing.entryId ? { ...ref, retired: true } : ref
    );
    entries.push(candidate);
    const fields: IndexFields = {
      entries,
      passkeys: passkeysOf(before.value),
      password: before.value.password,
      passwordGeneration: before.value.passwordGeneration,
    };
    const intentKey = `vault-v1/${vaultId}/index-intent/${candidate.entryId}`;
    const oldIntent = yield* local.read(intentKey);
    const expected = before.header
      ? { revision: before.header.revision, digest: ciphertextDigest(before.header) }
      : null;
    const previous = oldIntent
      ? Schema.decodeUnknownResult(PendingIndexIntent)(
          yield* attempt(() => parseCanonical(oldIntent))
        )
      : null;
    let next: VaultCiphertext;
    if (
      previous &&
      Result.isSuccess(previous) &&
      ((previous.success.expected === null && expected === null) ||
        (previous.success.expected &&
          expected &&
          previous.success.expected.revision === expected.revision &&
          previous.success.expected.digest === expected.digest))
    ) {
      next = yield* attempt(() => ownCiphertext(previous.success.next));
      yield* Effect.acquireUseRelease(
        attempt(() => decryptVault(master, vaultId, next, 'index')),
        (plain) =>
          attempt(() => {
            const restored = parseIndex(plain, vaultId);
            if (!bytesEqual(canonical(restored), indexPlain(fields)))
              throw vaultError('authentication');
          }),
        (plain) => Effect.sync(() => plain.fill(0))
      );
    } else {
      const raw = indexPlain(fields);
      next = yield* Effect.acquireUseRelease(
        Effect.succeed(raw),
        (plain) =>
          attempt(() =>
            encryptVault(
              master,
              vaultId,
              {
                entryId: indexId(vaultId),
                revision: (before.header?.revision ?? -1) + 1,
                previous: before.header ? ciphertextDigest(before.header) : null,
                purpose: 'index',
              },
              plain
            )
          ),
        (plain) => Effect.sync(() => plain.fill(0))
      );
    }
    yield* persist(
      intentKey,
      oldIntent,
      canonical({
        completed: false,
        expected: before.header
          ? { revision: before.header.revision, digest: ciphertextDigest(before.header) }
          : null,
        next,
      })
    );
    const outcome = yield* store.compareAndSwapIndex(
      vaultId,
      before.header
        ? { revision: before.header.revision, digest: ciphertextDigest(before.header) }
        : null,
      next,
      indexReferences(fields)
    );
    const after = yield* index();
    const savedIntent = yield* local.read(intentKey);
    if (!savedIntent) return yield* vaultError('storage');
    yield* persist(
      intentKey,
      savedIntent,
      canonical({ completed: true, entryId: candidate.entryId })
    );
    const winner = after.value.entries.find(
      (ref) =>
        !ref.retired &&
        ref.genesis === candidate.genesis &&
        ref.membershipId === candidate.membershipId
    );
    if (outcome === 'Committed' && winner?.entryId === candidate.entryId)
      return { outcome: 'Committed' as const, reference: winner };
    if (winner) return { outcome: 'Existing' as const, reference: winner };
    // Different workspace updates require an explicit caller retry/merge.
    return { outcome: 'Conflict' as const, reference: null };
  });
  const flushPasswordRemoval = Effect.fnUntraced(function* (entryId: string) {
    const key = passwordRemovalKey(entryId);
    const raw = yield* local.read(key);
    if (!raw) return;
    const intent = yield* attempt(() => decodePasswordRemoval(raw));
    if (intent.done) return;
    if (yield* store.readEntry(vaultId, entryId)) {
      const after = yield* index();
      if (!after.header) return yield* vaultError('storage');
      yield* store.deleteUnreferenced(vaultId, entryId, {
        revision: after.header.revision,
        digest: ciphertextDigest(after.header),
      });
      if (yield* store.readEntry(vaultId, entryId)) return yield* vaultError('storage');
    }
    yield* persist(key, raw, canonical({ done: true }));
  });
  return Object.freeze({
    vaultId,
    locator,
    readIndex: () => ownedOperation(index()),
    /** Each immutable package read owns a short-lived key copy, not the index lock. */
    readEntry: (ref: RecoveryEntryReference) => {
      const reference = { ...ref };
      return Effect.acquireUseRelease(
        mutex.withPermit(
          attempt(() => {
            guard();
            const key = master.slice();
            readers++;
            return key;
          })
        ),
        (key) => readEntry(reference, key),
        (key) =>
          Effect.sync(() => {
            key.fill(0);
            if (--readers === 0 && closed) Deferred.doneUnsafe(readsDrained, Effect.void);
          })
      ).pipe(Effect.uninterruptible);
    },
    upload: (value: RecoveryPrivatePackage, entryId = hex(random(32))) =>
      ownedOperation(upload(value, entryId)),
    reserve: (candidate: RecoveryEntryReference) => ownedOperation(reserve(candidate)),
    replace: (candidate: RecoveryEntryReference) => ownedOperation(reserve(candidate, true)),
    /** Whether an offline recovery file wrap (`entryId === vaultId`) exists on the service. */
    hasRecoveryFile: () =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          return (yield* store.readEntry(vaultId, vaultId)) !== null;
        })
      ),
    /** Create and upload a recovery file wrap for a vault originally created with a passkey or password. */
    createRecoveryFile: (request?: {
      readonly persistFile?: (file: Uint8Array) => Effect.Effect<unknown, unknown>;
    }) =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          if (!locator || locator.length > 2048) return yield* vaultError('invalid-input');
          if (yield* store.readEntry(vaultId, vaultId)) return yield* vaultError('conflict');
          const unlock = yield* attempt(() => random(32));
          return yield* Effect.acquireUseRelease(
            Effect.succeed(unlock),
            (secret) =>
              Effect.gen(function* () {
                const recoveryFile = yield* attempt(() =>
                  canonical(['vault-v1', 1, vaultId, locator, secret])
                );
                const wrapped = yield* attempt(() =>
                  encryptVault(
                    secret,
                    vaultId,
                    { entryId: vaultId, revision: 0, previous: null, purpose: 'file-wrap' },
                    master
                  )
                );
                if (request?.persistFile)
                  yield* request
                    .persistFile(new Uint8Array(recoveryFile))
                    .pipe(Effect.mapError(() => vaultError('storage')));
                yield* store.putImmutable(vaultId, wrapped);
                const read = yield* store.readEntry(vaultId, vaultId);
                if (!read || !sameCiphertext(wrapped, read)) return yield* vaultError('storage');
                yield* Effect.acquireUseRelease(
                  attempt(() => decryptVault(secret, vaultId, read, 'file-wrap')),
                  (opened) =>
                    bytesEqual(opened, master)
                      ? Effect.void
                      : Effect.fail(vaultError('authentication')),
                  (opened) => Effect.sync(() => opened.fill(0))
                );
                return { recoveryFile };
              }),
            (secret) => Effect.sync(() => secret.fill(0))
          );
        })
      ),
    /** Whether the authenticated index currently lists an active password wrap. */
    hasPassword: () =>
      ownedOperation(Effect.map(index(), (before) => before.value.password !== undefined)),
    /** Set or rotate the vault's Argon2id password wrap, retiring and deleting any prior password wrap. */
    setPassword: (request: { readonly password: string; readonly kdf?: PasswordKdfParams }) =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          const passwordBytes = yield* attempt(() => normalizeRecoveryPassword(request.password));
          return yield* Effect.acquireUseRelease(
            Effect.succeed(passwordBytes),
            (pw) =>
              Effect.gen(function* () {
                const before = yield* index();
                const startGen = Math.max(
                  (before.value.password?.generation ?? -1) + 1,
                  before.value.passwordGeneration ?? 0
                );
                let generation = -1;
                for (let g = startGen; g < MAX_VAULT_PASSWORD_GENERATIONS; g++) {
                  const candidateId = yield* attempt(() => passwordWrapEntryId(vaultId, g));
                  if (!(yield* store.readEntry(vaultId, candidateId))) {
                    generation = g;
                    break;
                  }
                }
                if (generation < 0) return yield* vaultError('conflict');
                const id = yield* attempt(() => passwordWrapEntryId(vaultId, generation));
                const entry = yield* encryptPasswordWrap(
                  pw,
                  vaultId,
                  id,
                  master,
                  request.kdf ?? DEFAULT_PASSWORD_KDF
                );
                yield* store.putImmutable(vaultId, entry);
                const stored = yield* store.readEntry(vaultId, id);
                if (!stored || !sameCiphertext(entry, stored)) return yield* vaultError('storage');
                yield* Effect.acquireUseRelease(
                  decryptPasswordWrap(pw, vaultId, stored),
                  (opened) =>
                    bytesEqual(opened, master)
                      ? Effect.void
                      : Effect.fail(vaultError('authentication')),
                  (opened) => Effect.sync(() => opened.fill(0))
                );
                const previous = before.value.password;
                if (previous) {
                  const oldKey = passwordRemovalKey(previous.entryId);
                  const oldRaw = yield* local.read(oldKey);
                  yield* persist(oldKey, oldRaw, canonical({ done: false }));
                }
                yield* commitFields(before, {
                  entries: before.value.entries,
                  passkeys: passkeysOf(before.value),
                  password: { entryId: id, generation },
                  passwordGeneration: generation + 1,
                });
                const rows = yield* local.list(passwordRemovalPrefix);
                for (const row of rows) {
                  const parsed = yield* attempt(() => decodePasswordRemoval(row.value));
                  if (!parsed.done) {
                    const targetId = row.key.slice(passwordRemovalPrefix.length);
                    yield* Effect.ignore(flushPasswordRemoval(targetId));
                  }
                }
                return id;
              }),
            (pw) => Effect.sync(() => pw.fill(0))
          );
        })
      ),
    /** Remove the vault's password wrap: journal intent, commit index without it, then delete the wrap. */
    removePassword: () =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          const before = yield* index();
          const listed = before.value.password;
          if (listed) {
            const key = passwordRemovalKey(listed.entryId);
            const raw = yield* local.read(key);
            const existing = raw ? yield* attempt(() => decodePasswordRemoval(raw)) : null;
            if (!existing || existing.done) {
              yield* persist(key, raw, canonical({ done: false }));
            }
            yield* commitFields(before, {
              entries: before.value.entries,
              passkeys: passkeysOf(before.value),
              password: undefined,
              passwordGeneration: Math.max(
                listed.generation + 1,
                before.value.passwordGeneration ?? 0
              ),
            });
          } else {
            const rows = yield* local.list(passwordRemovalPrefix);
            let hasPending = false;
            for (const row of rows) {
              const intent = yield* attempt(() => decodePasswordRemoval(row.value));
              if (!intent.done) hasPending = true;
            }
            if (!hasPending) return yield* vaultError('conflict');
          }
          const rows = yield* local.list(passwordRemovalPrefix);
          for (const row of rows) {
            const intent = yield* attempt(() => decodePasswordRemoval(row.value));
            if (!intent.done) {
              yield* flushPasswordRemoval(row.key.slice(passwordRemovalPrefix.length));
            }
          }
        })
      ),
    /** Password wrap removals this device began but did not finish deleting from the service. */
    pendingPasswordRemovals: () =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          const rows = yield* local.list(passwordRemovalPrefix);
          const pending: string[] = [];
          for (const row of rows) {
            const intent = yield* attempt(() => decodePasswordRemoval(row.value));
            if (!intent.done) pending.push(row.key.slice(passwordRemovalPrefix.length));
          }
          return pending;
        })
      ),
    listPasskeys: () =>
      ownedOperation(
        Effect.map(index(), (before) => passkeysOf(before.value).map((ref) => ({ ...ref })))
      ),
    /** Wrap V for a passkey and list it. Safe to retry after any failure: an uploaded
     * wrap is immutable, so a retry reuses it once it proves to hold this V. */
    addPasskey: (request: {
      readonly registration: VerifiedPasskeyRegistration;
      readonly assertion: VerifiedPasskeyPrf;
      readonly label: string;
    }) =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          const credentialId = request.assertion.credentialId;
          if (
            !isVerifiedPasskeyRegistration(request.registration) ||
            request.registration.credentialId !== credentialId
          )
            return yield* vaultError('prf-unavailable');
          if (!request.label || request.label.length > 128)
            return yield* vaultError('invalid-input');
          const id = passkeyEntryId(vaultId, credentialId),
            before = yield* index(),
            passkeys = passkeysOf(before.value);
          if (passkeys.some((ref) => ref.entryId === id)) return id;
          if (passkeys.length >= MAX_VAULT_PASSKEYS) return yield* vaultError('invalid-input');
          yield* Effect.acquireUseRelease(
            attempt(() => usePrf(request.assertion)),
            (key) =>
              Effect.gen(function* () {
                let stored = yield* store.readEntry(vaultId, id);
                if (!stored) {
                  const entry = yield* attempt(() =>
                    encryptVault(
                      key,
                      vaultId,
                      { entryId: id, revision: 0, previous: null, purpose: 'prf-wrap' },
                      master
                    )
                  );
                  yield* store.putImmutable(vaultId, entry);
                  stored = yield* store.readEntry(vaultId, id);
                  if (!stored || !sameCiphertext(entry, stored))
                    return yield* vaultError('storage');
                }
                const held = stored;
                yield* Effect.acquireUseRelease(
                  attempt(() => decryptVault(key, vaultId, held, 'prf-wrap')),
                  (opened) =>
                    bytesEqual(opened, master)
                      ? Effect.void
                      : Effect.fail(vaultError('authentication')),
                  (opened) => Effect.sync(() => opened.fill(0))
                );
              }),
            (key) => Effect.sync(() => key.fill(0))
          );
          yield* commitFields(before, {
            entries: before.value.entries,
            passkeys: [...passkeys, { entryId: id, credentialId, label: request.label }],
            password: before.value.password,
            passwordGeneration: before.value.passwordGeneration,
          });
          return id;
        })
      ),
    /** Remove a passkey: journal the intent, commit the index, then delete the wrap.
     * Removal stops future use only. If the delete fails, the journal keeps it
     * unfinished, and a retry on this device completes it. An unlisted entry with no
     * journaled intent is never deleted: it may be another device's candidate. */
    removePasskey: (entryId: string) =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          const key = removalKey(entryId);
          let raw = yield* local.read(key);
          let intent = raw ? yield* attempt(() => decodeRemoval(raw!)) : null;
          const before = yield* index(),
            passkeys = passkeysOf(before.value),
            listed = passkeys.find((ref) => ref.entryId === entryId);
          if (listed) {
            if (!intent || intent.done) {
              const next = canonical({ label: listed.label, done: false });
              yield* persist(key, raw, next);
              raw = next;
              intent = { label: listed.label, done: false };
            }
            yield* commitFields(before, {
              entries: before.value.entries,
              passkeys: passkeys.filter((ref) => ref.entryId !== entryId),
              password: before.value.password,
              passwordGeneration: before.value.passwordGeneration,
            });
          } else if (!intent || intent.done) return yield* vaultError('conflict');
          if (yield* store.readEntry(vaultId, entryId)) {
            const after = yield* index();
            if (!after.header) return yield* vaultError('storage');
            yield* store.deleteUnreferenced(vaultId, entryId, {
              revision: after.header.revision,
              digest: ciphertextDigest(after.header),
            });
            if (yield* store.readEntry(vaultId, entryId)) return yield* vaultError('storage');
          }
          yield* persist(key, raw, canonical({ label: intent.label, done: true }));
        })
      ),
    /** Removals this device began but did not finish: the wrap may still unlock V. */
    pendingPasskeyRemovals: () =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          const rows = yield* local.list(removalPrefix);
          const pending: { readonly entryId: string; readonly label: string }[] = [];
          for (const row of rows) {
            const intent = yield* attempt(() => decodeRemoval(row.value));
            if (!intent.done)
              pending.push({ entryId: row.key.slice(removalPrefix.length), label: intent.label });
          }
          return pending;
        })
      ),
    cleanupRetired: (entryId: string, confirmation: { readonly confirmedRecoveryLoss: boolean }) =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          if (
            Result.isFailure(
              Schema.decodeUnknownResult(
                Schema.Struct({ confirmedRecoveryLoss: Schema.Literal(true) })
              )(confirmation)
            )
          )
            return yield* vaultError('invalid-input');
          const before = yield* index();
          const target = before.value.entries.find((ref) => ref.entryId === entryId);
          if (!before.header || target?.retired !== true) return yield* vaultError('conflict');
          const retainedHeader = before.header;
          const rows = yield* local.list(`vault-v1/${vaultId}/`);
          for (const row of rows) {
            if (!row.key.includes('/workspace/')) continue;
            const source = yield* attempt(() => parseCanonical(row.value));
            const fields = yield* attempt(() =>
              Result.getOrThrow(
                Schema.decodeUnknownResult(
                  Schema.Struct({
                    entryId: Schema.optional(Schema.String),
                    done: Schema.optional(Schema.Boolean),
                  })
                )(source)
              )
            );
            if (
              fields.entryId === entryId ||
              (row.key.includes('/replacement/') && fields.done !== true)
            )
              return yield* vaultError('pending');
          }
          const fields: IndexFields = {
            entries: before.value.entries.filter((ref) => ref.entryId !== entryId),
            passkeys: passkeysOf(before.value),
            password: before.value.password,
            passwordGeneration: before.value.passwordGeneration,
          };
          const plain = indexPlain(fields);
          const next = yield* Effect.acquireUseRelease(
            Effect.succeed(plain),
            (value) =>
              attempt(() =>
                encryptVault(
                  master,
                  vaultId,
                  {
                    entryId: indexId(vaultId),
                    revision: retainedHeader.revision + 1,
                    previous: ciphertextDigest(retainedHeader),
                    purpose: 'index',
                  },
                  value
                )
              ),
            (value) => Effect.sync(() => value.fill(0))
          );
          if (
            (yield* store.compareAndSwapIndex(
              vaultId,
              { revision: before.header.revision, digest: ciphertextDigest(before.header) },
              next,
              indexReferences(fields)
            )) !== 'Committed'
          )
            return yield* vaultError('conflict');
          const after = yield* index();
          if (!after.header || after.value.entries.some((ref) => ref.entryId === entryId))
            return yield* vaultError('storage');
          yield* store.deleteUnreferenced(vaultId, entryId, {
            revision: after.header.revision,
            digest: ciphertextDigest(after.header),
          });
          if (yield* store.readEntry(vaultId, entryId)) return yield* vaultError('storage');
          return yield* Effect.void;
        })
      ),
    readCandidate: (entryId: string) =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          const remote = yield* store.readEntry(vaultId, entryId);
          if (!remote) return null;
          const header = yield* attempt(() => ownCiphertext(remote));
          return yield* Effect.acquireUseRelease(
            attempt(() => decryptVault(master, vaultId, header, 'workspace-entry')),
            (plain) =>
              attempt(() => {
                const value = useCanonicalSecret(plain, (decoded) =>
                  ownRecoveryPackage(decoded as RecoveryPrivatePackage)
                );
                return {
                  reference: {
                    genesis: value.genesis,
                    membershipId: value.membershipId,
                    generation: value.generation,
                    entryId,
                    digest: ciphertextDigest(header),
                    retired: false,
                  },
                  value,
                };
              }),
            (plain) => Effect.sync(() => plain.fill(0))
          );
        })
      ),
    local,
  });
});
/** An unlocked recovery vault session: read and update its index and workspace entries. */
export type RecoveryVault = Effect.Success<ReturnType<typeof makeSession>>;
/** Create a new recovery vault wrapped by an offline recovery file. */
export const createRecoveryVault = Effect.fnUntraced(function* (input: {
  locator: string;
  store: RecoveryVaultStore;
  local: RecoveryVaultLocalStore;
  /** Runs before anything reaches the service, so a failed save leaves no vault behind. */
  persistFile?: (file: Uint8Array) => Effect.Effect<unknown, unknown>;
}) {
  if (!input.locator || input.locator.length > 2048) return yield* vaultError('invalid-input');
  const vaultId = yield* attempt(() => hex(random(32))),
    unlock = yield* attempt(() => random(32)),
    master = yield* attempt(() => random(32));
  return yield* Effect.acquireUseRelease(
    Effect.succeed({ unlock, master }),
    (secret) =>
      Effect.gen(function* () {
        const recoveryFile = yield* attempt(() =>
          canonical(['vault-v1', 1, vaultId, input.locator, secret.unlock])
        );
        const wrapped = yield* attempt(() =>
          encryptVault(
            secret.unlock,
            vaultId,
            { entryId: vaultId, revision: 0, previous: null, purpose: 'file-wrap' },
            secret.master
          )
        );
        if (input.persistFile)
          yield* input
            .persistFile(new Uint8Array(recoveryFile))
            .pipe(Effect.mapError(() => vaultError('storage')));
        yield* input.store.putImmutable(vaultId, wrapped);
        const read = yield* input.store.readEntry(vaultId, vaultId);
        if (!read || !sameCiphertext(wrapped, read)) return yield* vaultError('storage');
        const vault = yield* makeSession({
          locator: input.locator,
          store: input.store,
          local: input.local,
          vaultId,
          master: new Uint8Array(secret.master),
        });
        return { recoveryFile, vault };
      }),
    (secret) =>
      Effect.sync(() => {
        secret.unlock.fill(0);
        secret.master.fill(0);
      })
  );
});
/** Create a new recovery vault wrapped directly by a verified passkey PRF ceremony. */
export const createRecoveryVaultWithPasskey = Effect.fnUntraced(function* (input: {
  vaultId: string;
  locator: string;
  registration: VerifiedPasskeyRegistration;
  assertion: VerifiedPasskeyPrf;
  label: string;
  store: RecoveryVaultStore;
  local: RecoveryVaultLocalStore;
}) {
  yield* attempt(() => fromHex(input.vaultId));
  if (!input.locator || input.locator.length > 2048) return yield* vaultError('invalid-input');
  const credentialId = input.assertion.credentialId;
  if (
    !isVerifiedPasskeyRegistration(input.registration) ||
    input.registration.credentialId !== credentialId
  )
    return yield* vaultError('prf-unavailable');
  if (!input.label || input.label.length > 128) return yield* vaultError('invalid-input');
  const master = yield* attempt(() => random(32));
  return yield* Effect.acquireUseRelease(
    Effect.succeed(master),
    (secret) =>
      Effect.gen(function* () {
        const vault = yield* makeSession({
          locator: input.locator,
          store: input.store,
          local: input.local,
          vaultId: input.vaultId,
          master: new Uint8Array(secret),
        });
        const entryId = yield* vault.addPasskey({
          registration: input.registration,
          assertion: input.assertion,
          label: input.label,
        });
        return { vault, entryId };
      }),
    (secret) => Effect.sync(() => secret.fill(0))
  );
});
/** Create a new recovery vault wrapped by an Argon2id password wrap. */
export const createRecoveryVaultWithPassword = Effect.fnUntraced(function* (input: {
  locator: string;
  password: string;
  kdf?: PasswordKdfParams;
  store: RecoveryVaultStore;
  local: RecoveryVaultLocalStore;
}) {
  if (!input.locator || input.locator.length > 2048) return yield* vaultError('invalid-input');
  const passwordBytes = yield* attempt(() => normalizeRecoveryPassword(input.password));
  passwordBytes.fill(0);
  const vaultId = yield* attempt(() => hex(random(32))),
    master = yield* attempt(() => random(32));
  return yield* Effect.acquireUseRelease(
    Effect.succeed(master),
    (secret) =>
      Effect.gen(function* () {
        const vault = yield* makeSession({
          locator: input.locator,
          store: input.store,
          local: input.local,
          vaultId,
          master: new Uint8Array(secret),
        });
        const entryId = yield* vault.setPassword({
          password: input.password,
          ...(input.kdf ? { kdf: input.kdf } : {}),
        });
        return { vault, entryId };
      }),
    (secret) => Effect.sync(() => secret.fill(0))
  );
});
/** Unlock an existing recovery vault from its offline recovery file. */
export const openRecoveryVault = Effect.fnUntraced(function* (input: {
  recoveryFile: Uint8Array;
  store: RecoveryVaultStore;
  local: RecoveryVaultLocalStore;
}) {
  const file = yield* attempt(() => parseRecoveryFile(input.recoveryFile));
  return yield* Effect.acquireUseRelease(
    Effect.succeed(file),
    (owned) =>
      Effect.gen(function* () {
        const entry = yield* input.store.readEntry(owned.vaultId, owned.vaultId);
        if (!entry || entry.revision !== 0) return yield* vaultError('authentication');
        const master = yield* attempt(() =>
          decryptVault(owned.unlock, owned.vaultId, entry, 'file-wrap')
        );
        if (master.length !== 32) {
          master.fill(0);
          return yield* vaultError('authentication');
        }
        return yield* makeSession({ ...input, ...owned, master });
      }),
    (owned) => Effect.sync(() => owned.unlock.fill(0))
  );
});
/** Unlock an existing recovery vault with a verified passkey PRF assertion. */
export const openRecoveryVaultWithPasskey = Effect.fnUntraced(function* (input: {
  vaultId: string;
  locator: string;
  credential: VerifiedPasskeyPrf;
  store: RecoveryVaultStore;
  local: RecoveryVaultLocalStore;
}) {
  const id = passkeyEntryId(input.vaultId, input.credential.credentialId),
    key = yield* attempt(() => usePrf(input.credential));
  return yield* Effect.acquireUseRelease(
    Effect.succeed(key),
    (prf) =>
      Effect.gen(function* () {
        const entry = yield* input.store.readEntry(input.vaultId, id);
        if (!entry || entry.revision !== 0) return yield* vaultError('prf-unavailable');
        const master = yield* attempt(() => decryptVault(prf, input.vaultId, entry, 'prf-wrap'));
        if (master.length !== 32) {
          master.fill(0);
          return yield* vaultError('authentication');
        }
        return yield* makeSession({ ...input, master });
      }),
    (prf) => Effect.sync(() => prf.fill(0))
  );
});
/** Unlock an existing recovery vault with its password, verifying the active index reference. */
export const openRecoveryVaultWithPassword = Effect.fnUntraced(function* (input: {
  vaultId: string;
  locator: string;
  password: string;
  store: RecoveryVaultStore;
  local: RecoveryVaultLocalStore;
}) {
  yield* attempt(() => fromHex(input.vaultId));
  if (!input.locator || input.locator.length > 2048) return yield* vaultError('invalid-input');
  const pinKey = `vault-v1/${input.vaultId}/index-pin`;
  const pinRaw = yield* input.local.read(pinKey);
  const pin =
    pinRaw === null
      ? null
      : yield* attempt(() =>
          Result.getOrThrow(Schema.decodeUnknownResult(PinSchema)(parseCanonical(pinRaw)))
        );
  const remoteIndex = yield* input.store.readIndex(input.vaultId);
  if (!remoteIndex) {
    if (pin) return yield* vaultError('rollback');
    return yield* vaultError('missing');
  }
  const indexHeader = yield* Effect.try({
    try: () => ownCiphertext(remoteIndex),
    catch: () => vaultError('authentication'),
  });
  if (indexHeader.entryId !== indexId(input.vaultId)) return yield* vaultError('authentication');
  const indexHash = ciphertextDigest(indexHeader);
  if (
    pin &&
    (indexHeader.revision < pin.revision ||
      (indexHeader.revision === pin.revision && indexHash !== pin.digest))
  )
    return yield* vaultError('rollback');
  const slots = yield* Effect.all(
    Array.from({ length: MAX_VAULT_PASSWORD_GENERATIONS }, (_, generation) =>
      Effect.gen(function* () {
        const id = yield* attempt(() => passwordWrapEntryId(input.vaultId, generation));
        const entry = yield* input.store.readEntry(input.vaultId, id);
        return entry ? { generation, entry } : null;
      })
    )
  );
  const candidates = slots
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => b.generation - a.generation)
    .slice(0, 2);
  if (candidates.length === 0) return yield* vaultError('missing');
  const passwordBytes = yield* Effect.try({
    try: () => normalizeRecoveryPassword(input.password),
    catch: () => vaultError('authentication'),
  });
  return yield* Effect.acquireUseRelease(
    Effect.succeed(passwordBytes),
    (pw) =>
      Effect.gen(function* () {
        for (const candidate of candidates) {
          if (candidate.entry.revision !== 0) continue;
          const decrypted = yield* Effect.exit(
            decryptPasswordWrap(pw, input.vaultId, candidate.entry)
          );
          if (Exit.isFailure(decrypted)) continue;
          const master = decrypted.value;
          if (master.length !== 32) {
            master.fill(0);
            continue;
          }
          const active = yield* Effect.acquireUseRelease(
            Effect.try({
              try: () => decryptVault(master, input.vaultId, indexHeader, 'index'),
              catch: () => vaultError('authentication'),
            }).pipe(Effect.exit),
            (plainExit) =>
              Exit.isSuccess(plainExit)
                ? Effect.sync(() => {
                    try {
                      const parsed = parseIndex(plainExit.value, input.vaultId);
                      return parsed.password?.entryId === candidate.entry.entryId;
                    } catch {
                      return false;
                    }
                  })
                : Effect.succeed(false),
            (plainExit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(plainExit)) plainExit.value.fill(0);
              })
          );
          if (!active) {
            master.fill(0);
            continue;
          }
          const session = yield* makeSession({
            vaultId: input.vaultId,
            locator: input.locator,
            master,
            store: input.store,
            local: input.local,
          });
          yield* session.readIndex();
          return session;
        }
        return yield* vaultError('authentication');
      }),
    (pw) => Effect.sync(() => pw.fill(0))
  );
});
