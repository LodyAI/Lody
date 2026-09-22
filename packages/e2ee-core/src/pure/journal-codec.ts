import { Either } from 'effect';
import { ValidationError, type LedgerErrorCode } from './errors';
import { copyBytes } from './cbor';
import { keyId } from './identifiers';
import { MAX_LEDGER_RECORDS, type LedgerJournal } from './journal';

const FORMAT = 'lody-e2ee-journal/v0';
const SNAPSHOT_FORMAT = 'lody-e2ee-journal/v1';
const MAX_BYTES = 32 * 1024 * 1024;
const invalid = (code: LedgerErrorCode): Either.Either<never, ValidationError> =>
  Either.left(new ValidationError({ code }));

function fromHex(hex: unknown): Either.Either<Uint8Array, ValidationError> {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(hex)) return invalid('canonical');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return Either.right(bytes);
}

/** Existing persisted JSON envelope; signed records remain exact DAG-CBOR bytes.
 * Successful decoding is structure validation, never ledger authorization. */
export function encodeLedgerJournal(
  journal: LedgerJournal
): Either.Either<string, ValidationError> {
  return Either.gen(function* () {
    if (journal.records.length > MAX_LEDGER_RECORDS) return yield* invalid('oversize');
    if (
      typeof journal.offset !== 'string' ||
      journal.offset.length === 0 ||
      journal.offset.length > 1024
    )
      return yield* invalid('canonical');
    const { snapshot, snapshotTrust: trust } = journal;
    const hasSnapshot = snapshot !== undefined || trust !== undefined;
    if (hasSnapshot && (snapshot === undefined || trust === undefined))
      return yield* invalid('canonical');
    if (!hasSnapshot && journal.records.length === 0) return yield* invalid('oversize');
    const prefix = [
      hasSnapshot ? SNAPSHOT_FORMAT : FORMAT,
      keyId(journal.genesis),
      journal.records.map(keyId),
      journal.pending === null ? null : keyId(journal.pending),
      journal.offset,
    ];
    const row =
      snapshot !== undefined && trust !== undefined
        ? [
            ...prefix,
            keyId(snapshot),
            [keyId(trust.endorser), keyId(trust.head), keyId(trust.headSignature)],
            ...(journal.snapshotBound === true ? [true] : []),
          ]
        : prefix;
    const text = JSON.stringify(row);
    if (new TextEncoder().encode(text).length > MAX_BYTES) return yield* invalid('oversize');
    return text;
  });
}

export function decodeLedgerJournal(text: string): Either.Either<LedgerJournal, ValidationError> {
  return Either.gen(function* () {
    if (typeof text !== 'string' || text.length > MAX_BYTES) return yield* invalid('oversize');
    const parsed: unknown = yield* Either.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new ValidationError({ code: 'canonical' }),
    });
    if (!Array.isArray(parsed)) return yield* invalid('canonical');
    const row: readonly unknown[] = parsed;
    const format = row[0];
    if (format !== FORMAT && format !== SNAPSHOT_FORMAT) return yield* invalid('unknown-version');
    if (format === FORMAT ? row.length !== 5 : row.length !== 7 && row.length !== 8)
      return yield* invalid('canonical');
    const [, genesisHex, rows, pendingHex, offset] = row;
    if (!Array.isArray(rows) || typeof offset !== 'string') return yield* invalid('canonical');
    const records: Uint8Array[] = [];
    for (const record of rows) records.push(yield* fromHex(record));
    const genesis = yield* fromHex(genesisHex);
    const pending = pendingHex === null ? null : yield* fromHex(pendingHex);
    let journal: LedgerJournal = { genesis, records, pending, offset };
    if (format === SNAPSHOT_FORMAT) {
      const [, , , , , snapshotHex, trustRow, boundFlag] = row;
      if (!Array.isArray(trustRow) || trustRow.length !== 3) return yield* invalid('canonical');
      if (row.length === 8 && boundFlag !== true) return yield* invalid('canonical');
      journal = {
        ...journal,
        snapshot: yield* fromHex(snapshotHex),
        snapshotTrust: {
          genesis: copyBytes(genesis),
          endorser: yield* fromHex(trustRow[0]),
          head: yield* fromHex(trustRow[1]),
          headSignature: yield* fromHex(trustRow[2]),
        },
        snapshotBound: row.length === 8 ? true : undefined,
      };
    }
    if ((yield* encodeLedgerJournal(journal)) !== text) return yield* invalid('canonical');
    return journal;
  });
}
