import { Effect, Result, Schema, Semaphore } from 'effect';
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
  ownCiphertext,
  sameCiphertext,
  ciphertextDigest,
  usePrf,
  type VaultCiphertext,
  type VerifiedPasskeyPrf,
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
    value.signingPrivate.length < 32 ||
    value.signingPrivate.length > 256 ||
    value.encryptionPrivate.length < 32 ||
    value.encryptionPrivate.length > 256
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
const IndexSchema = Schema.Struct({ entries: Schema.Array(ReferenceSchema) });
export type RecoveryVaultIndex = typeof IndexSchema.Type;
function parseIndex(input: Uint8Array): RecoveryVaultIndex {
  const value = Result.getOrThrow(Schema.decodeUnknownResult(IndexSchema)(parseCanonical(input)));
  if (value.entries.length > 1024) throw vaultError('invalid-input');
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
  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.sync(() => {
        closed = true;
        master.fill(0);
      })
    )
  );
  const ownedOperation = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    mutex.withPermit(Effect.uninterruptible(work));
  const guard = () => {
    if (closed) throw vaultError('closed');
  };
  const pinKey = `vault-v1/${vaultId}/index-pin`;
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
      (plain) => attempt(() => parseIndex(plain)),
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
  const readEntry = Effect.fnUntraced(function* (ref: RecoveryEntryReference) {
    yield* attempt(guard);
    const remote = yield* store.readEntry(vaultId, ref.entryId);
    if (!remote) return yield* vaultError('missing');
    const header = yield* attempt(() => ownCiphertext(remote));
    if (ciphertextDigest(header) !== ref.digest) return yield* vaultError('authentication');
    return yield* Effect.acquireUseRelease(
      attempt(() => decryptVault(master, vaultId, header, 'workspace-entry')),
      (plain) =>
        attempt(() => {
          const value = ownRecoveryPackage(
            Result.getOrThrow(Schema.decodeUnknownResult(PackageSchema)(parseCanonical(plain)))
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
            const restored = parseIndex(plain);
            if (!bytesEqual(canonical(restored), canonical({ entries })))
              throw vaultError('authentication');
          }),
        (plain) => Effect.sync(() => plain.fill(0))
      );
    } else {
      const raw = canonical({ entries });
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
      entries.map((ref) => ref.entryId)
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
  return Object.freeze({
    vaultId,
    locator,
    readIndex: () => ownedOperation(index()),
    readEntry: (ref: RecoveryEntryReference) => ownedOperation(readEntry(ref)),
    upload: (value: RecoveryPrivatePackage, entryId = hex(random(32))) =>
      ownedOperation(upload(value, entryId)),
    reserve: (candidate: RecoveryEntryReference) => ownedOperation(reserve(candidate)),
    replace: (candidate: RecoveryEntryReference) => ownedOperation(reserve(candidate, true)),
    addPasskey: (capability: VerifiedPasskeyPrf) =>
      ownedOperation(
        Effect.gen(function* () {
          yield* attempt(guard);
          const id = digest(canonical(['vault-v1', vaultId, capability.credentialId])),
            prf = yield* attempt(() => usePrf(capability));
          const entry = yield* Effect.acquireUseRelease(
            Effect.succeed(prf),
            (key) =>
              attempt(() =>
                encryptVault(
                  key,
                  vaultId,
                  { entryId: id, revision: 0, previous: null, purpose: 'prf-wrap' },
                  master
                )
              ),
            (key) => Effect.sync(() => key.fill(0))
          );
          yield* store.putImmutable(vaultId, entry);
          const read = yield* store.readEntry(vaultId, id);
          if (!read || !sameCiphertext(entry, read)) return yield* vaultError('storage');
          return id;
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
          const plain = canonical({
            entries: before.value.entries.filter((ref) => ref.entryId !== entryId),
          });
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
              before.value.entries
                .filter((ref) => ref.entryId !== entryId)
                .map((ref) => ref.entryId)
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
                const value = ownRecoveryPackage(
                  Result.getOrThrow(
                    Schema.decodeUnknownResult(PackageSchema)(parseCanonical(plain))
                  )
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
export const createRecoveryVault = Effect.fnUntraced(function* (input: {
  locator: string;
  store: RecoveryVaultStore;
  local: RecoveryVaultLocalStore;
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
        yield* input.store.putImmutable(vaultId, wrapped);
        const read = yield* input.store.readEntry(vaultId, vaultId);
        if (!read || !sameCiphertext(wrapped, read)) return yield* vaultError('storage');
        const vault = yield* makeSession({
          ...input,
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
export const openRecoveryVaultWithPasskey = Effect.fnUntraced(function* (input: {
  vaultId: string;
  locator: string;
  credential: VerifiedPasskeyPrf;
  store: RecoveryVaultStore;
  local: RecoveryVaultLocalStore;
}) {
  const id = digest(canonical(['vault-v1', input.vaultId, input.credential.credentialId])),
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
