import { Result, Schema } from 'effect';
import { keyId } from '../internal/foundation/identifiers';
import { fromHex } from '../internal/keys/reports';
import { ownCiphertext, type VaultCiphertext } from '../internal/recovery/crypto';

const Hex = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2})+$/));
const IndexVersion = Schema.Struct({ revision: Schema.Int, digest: Schema.String });

/**
 * Wire form of one encrypted vault entry or index (`ciphertext` in hex).
 * Opaque to the backend: authentication gates access, but the backend never
 * decrypts, chooses ledger trust or proves a recovery device is active.
 *
 * @category Recovery vault wire contract
 */
export const RecoveryVaultCiphertextDto = Schema.Struct({
  entryId: Schema.String,
  revision: Schema.Int,
  ciphertext: Hex,
});
export type RecoveryVaultCiphertextDto = typeof RecoveryVaultCiphertextDto.Type;

/** Store an immutable entry. @category Recovery vault wire contract */
export const RecoveryVaultPutRequest = Schema.Struct({
  vaultId: Schema.String,
  entry: RecoveryVaultCiphertextDto,
});
export type RecoveryVaultPutRequest = typeof RecoveryVaultPutRequest.Type;

/** Read one entry. @category Recovery vault wire contract */
export const RecoveryVaultReadRequest = Schema.Struct({
  vaultId: Schema.String,
  entryId: Schema.String,
});
export type RecoveryVaultReadRequest = typeof RecoveryVaultReadRequest.Type;

/** Read the current index. @category Recovery vault wire contract */
export const RecoveryVaultIndexReadRequest = Schema.Struct({ vaultId: Schema.String });
export type RecoveryVaultIndexReadRequest = typeof RecoveryVaultIndexReadRequest.Type;

/**
 * Replace the index if it still has `expected` revision and digest (or none).
 * `referencedEntryIds` must exist, checked in the same transaction.
 *
 * @category Recovery vault wire contract
 */
export const RecoveryVaultIndexCasRequest = Schema.Struct({
  vaultId: Schema.String,
  expected: Schema.NullOr(IndexVersion),
  next: RecoveryVaultCiphertextDto,
  referencedEntryIds: Schema.Array(Schema.String),
});
export type RecoveryVaultIndexCasRequest = typeof RecoveryVaultIndexCasRequest.Type;

/** Outcome of an index compare-and-swap. @category Recovery vault wire contract */
export const RecoveryVaultIndexCasReply = Schema.Struct({
  outcome: Schema.Literals(['Committed', 'Conflict']),
});
export type RecoveryVaultIndexCasReply = typeof RecoveryVaultIndexCasReply.Type;

/**
 * Delete an entry the index at `expectedIndex` no longer references.
 *
 * @category Recovery vault wire contract
 */
export const RecoveryVaultDeleteRequest = Schema.Struct({
  vaultId: Schema.String,
  entryId: Schema.String,
  expectedIndex: IndexVersion,
});
export type RecoveryVaultDeleteRequest = typeof RecoveryVaultDeleteRequest.Type;

/** Encode a vault ciphertext for the wire. @category Recovery vault wire contract */
export const encodeRecoveryVaultCiphertext = (
  value: VaultCiphertext
): RecoveryVaultCiphertextDto => ({
  entryId: value.entryId,
  revision: value.revision,
  ciphertext: keyId(value.body),
});

/** Decode and validate a vault ciphertext from the wire. @category Recovery vault wire contract */
export const decodeRecoveryVaultCiphertext = (
  value: unknown
): Result.Result<VaultCiphertext, Schema.SchemaError | Error> =>
  Result.flatMap(Schema.decodeUnknownResult(RecoveryVaultCiphertextDto)(value), (dto) =>
    Result.try({
      try: () =>
        ownCiphertext({
          entryId: dto.entryId,
          revision: dto.revision,
          body: fromHex(dto.ciphertext),
        }),
      catch: (error) => (error instanceof Error ? error : new Error('invalid vault ciphertext')),
    })
  );
