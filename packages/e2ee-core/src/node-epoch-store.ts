import type { ControlJournal, ControlStore, JournalTransaction } from './client';
import { commitEpochKey, VerifiedEpochKeys } from './epoch-keys';
import { inspectContent } from './content';
import { decodeJournal, encodeJournal } from './node-store';
import { SqliteTextStore } from './node-text-store';
import { decodeTeamAction } from './team-codec';
import { checkHex, decodeRecord, fromHex, invariant, toHex } from './wire';

export interface LocalEpochContext {
  readonly genesis: string;
  readonly epoch: number;
  readonly commitment: string;
}
/** Trusted local OS protection, not an identity/plaintext codec. No fallback allowed. */
export interface LocalEpochProtection {
  seal(context: LocalEpochContext, secret: Uint8Array): Uint8Array;
  open(context: LocalEpochContext, wrapped: Uint8Array): Uint8Array;
}
type Candidate = { wire: string; wrapped: string; history: string | null };
type Bundle = { journal: ControlJournal; candidates: Candidate[] };
const FORMAT = 'lody-epoch-journal/v2';
const MAX_CANDIDATES = 4096;

function context(wire: string): LocalEpochContext {
  const { event } = decodeRecord(wire);
  const action = decodeTeamAction(event);
  invariant(action.type === 'epoch.publish', 'not-epoch-publication');
  return { genesis: event.genesis, epoch: action.epoch, commitment: action.commitment };
}
function encode(bundle: Bundle): string {
  invariant(bundle.candidates.length <= MAX_CANDIDATES, 'too-many-epoch-candidates');
  const commitments = new Set<string>();
  const operations = new Set<string>();
  const candidates = bundle.candidates.map(({ wire, wrapped, history }) => {
    const operationId = decodeRecord(wire).event.operationId;
    invariant(!operations.has(operationId), 'epoch-operation-reused');
    operations.add(operationId);
    const candidate = context(wire);
    invariant(candidate.genesis === bundle.journal.genesis, 'journal-anchor-mismatch');
    invariant(!commitments.has(candidate.commitment), 'epoch-candidate-reused');
    commitments.add(candidate.commitment);
    invariant(
      typeof wrapped === 'string' && /^(?:[0-9a-f]{2}){1,4096}$/.test(wrapped),
      'invalid-wrapped-epoch-key'
    );
    checkHistory(candidate, history);
    return [wire, wrapped, history];
  });
  if (
    bundle.journal.pending !== null &&
    decodeRecord(bundle.journal.pending).event.kind === 'team-epoch-publish'
  ) {
    invariant(
      bundle.candidates.some((c) => c.wire === bundle.journal.pending),
      'missing-epoch-candidate'
    );
  }
  return JSON.stringify([FORMAT, encodeJournal(bundle.journal), candidates]);
}
function checkHistory(expected: LocalEpochContext, history: string | null): void {
  if (expected.epoch === 0) {
    invariant(history === null, 'unexpected-epoch-history');
    return;
  }
  invariant(typeof history === 'string' && history.length <= 8468, 'missing-epoch-history');
  checkHex(history);
  const header = inspectContent(fromHex(history));
  invariant(
    header.genesis === expected.genesis &&
      header.epoch === expected.epoch &&
      header.resource === 'previous-epoch-key' &&
      header.purpose === 'epoch-history',
    'epoch-history-scope-mismatch'
  );
  // Routing checks only; the publisher verifies keys before sealing and the
  // history uploader verifies signature/plaintext again before remote release.
}
function decode(text: string): Bundle {
  const value: unknown = JSON.parse(text);
  invariant(
    Array.isArray(value) &&
      value.length === 3 &&
      value[0] === FORMAT &&
      typeof value[1] === 'string' &&
      Array.isArray(value[2]),
    'invalid-epoch-journal'
  );
  const candidates: Candidate[] = value[2].map((row: unknown) => {
    invariant(
      Array.isArray(row) &&
        row.length === 3 &&
        typeof row[0] === 'string' &&
        typeof row[1] === 'string' &&
        (row[2] === null || typeof row[2] === 'string'),
      'invalid-epoch-journal'
    );
    const history: unknown = row[2];
    invariant(history === null || typeof history === 'string', 'invalid-epoch-journal');
    return { wire: row[0], wrapped: row[1], history };
  });
  const bundle = { journal: decodeJournal(value[1]), candidates };
  invariant(encode(bundle) === text, 'noncanonical-epoch-journal');
  return bundle;
}

/** Separate opt-in database. Never opens/migrates an ordinary v2 control journal.
 * Encryption is supplied by the trusted main/native composition; no raw secret is stored. */
export class SqliteEpochControlStore implements ControlStore {
  private readonly database: SqliteTextStore;
  constructor(
    path: string,
    private readonly protection: LocalEpochProtection
  ) {
    this.database = new SqliteTextStore(path, 0x4c454b31, 2);
  }

  /** Prepare encrypted bytes in memory, not on disk. Use this returned store for
   * ControlLogClient.submit(wire); its pending checkpoint atomically saves BOTH parts. */
  async withCandidate(
    wire: string,
    secret: Uint8Array,
    history: Uint8Array | null = null
  ): Promise<ControlStore> {
    const expected = context(wire);
    invariant(
      history === null || (history instanceof Uint8Array && history.length <= 4234),
      'invalid-epoch-history'
    );
    const historyHex = history === null ? null : toHex(history);
    checkHistory(expected, historyHex);
    invariant(secret instanceof Uint8Array && secret.length === 32, 'invalid-epoch-key');
    const copy = new Uint8Array(secret);
    let opened: Uint8Array | undefined;
    try {
      invariant(
        (await commitEpochKey(expected.genesis, copy)) === expected.commitment,
        'epoch-key-mismatch'
      );
      const wrapped = this.protection.seal({ ...expected }, copy);
      invariant(
        wrapped instanceof Uint8Array && wrapped.length > 0 && wrapped.length <= 4096,
        'invalid-wrapped-epoch-key'
      );
      const candidate = { wire, wrapped: toHex(wrapped), history: historyHex };
      // Verify the actual OS round-trip before a publication can enter the outbox.
      opened = this.protection.open({ ...expected }, fromHex(candidate.wrapped));
      invariant(
        (await commitEpochKey(expected.genesis, opened)) === expected.commitment,
        'epoch-key-mismatch'
      );
      return { exclusive: (work) => this.run(work, candidate) };
    } finally {
      copy.fill(0);
      opened?.fill(0);
    }
  }

  exclusive<T>(work: (transaction: JournalTransaction) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  /** Unverified saved attempt, including unsupported/conflicting publications.
   * The submission driver must verify it before claiming success or sending it. */
  async findCandidate(operationId: string): Promise<string | null> {
    checkHex(operationId, 16);
    return this.database.exclusive(async (tx) => {
      const text = await tx.load();
      if (text === null) return null;
      return (
        decode(text).candidates.find((c) => decodeRecord(c.wire).event.operationId === operationId)
          ?.wire ?? null
      );
    });
  }

  /** Unverified ciphertext retained with the candidate; not proof of publication. */
  async readHistory(wire: string): Promise<Uint8Array | null> {
    return this.database.exclusive(async (tx) => {
      const text = await tx.load();
      invariant(text !== null, 'missing-epoch-candidate');
      const saved = decode(text).candidates.find((c) => c.wire === wire);
      invariant(saved !== undefined, 'missing-epoch-candidate');
      return saved.history === null ? null : fromHex(saved.history);
    });
  }

  private run<T>(
    work: (transaction: JournalTransaction) => Promise<T>,
    candidate?: Candidate
  ): Promise<T> {
    return this.database.exclusive(async (tx) => {
      const text = await tx.load();
      let bundle = text === null ? null : decode(text);
      let active = true;
      try {
        return await work({
          load: async () => {
            invariant(active, 'journal-transaction-ended');
            return bundle === null ? null : structuredClone(bundle.journal);
          },
          save: async (journal) => {
            invariant(active, 'journal-transaction-ended');
            const next = structuredClone(journal);
            invariant(
              bundle === null || bundle.journal.genesis === next.genesis,
              'journal-anchor-mismatch'
            );
            const candidates = [...(bundle?.candidates ?? [])];
            const existing = candidate && candidates.find((c) => c.wire === candidate.wire);
            invariant(
              !existing || existing.history === candidate?.history,
              'history-frame-conflict'
            );
            if (
              candidate &&
              (next.pending === candidate.wire ||
                next.pages.some((page) => page.records.includes(candidate.wire))) &&
              !candidates.some((c) => c.wire === candidate.wire)
            ) {
              candidates.push(candidate);
            }
            const updated = { journal: next, candidates };
            if (
              next.pending !== null &&
              decodeRecord(next.pending).event.kind === 'team-epoch-publish'
            ) {
              const saved = candidates.find((c) => c.wire === next.pending);
              invariant(saved !== undefined, 'missing-epoch-candidate');
              const expected = context(saved.wire);
              const key = this.protection.open({ ...expected }, fromHex(saved.wrapped));
              try {
                invariant(
                  (await commitEpochKey(expected.genesis, key)) === expected.commitment,
                  'epoch-key-mismatch'
                );
              } finally {
                key.fill(0);
              }
              invariant(active, 'journal-transaction-ended');
            }
            // One SQLite statement: interruption cannot persist the pending record
            // without its encrypted key, nor erase the key when pending is cleared.
            await tx.save(encode(updated));
            bundle = updated;
          },
        });
      } finally {
        active = false;
      }
    });
  }

  /** Install only through the caller's current verified epoch policy. Saved
   * candidates are not authority; a losing publication must fail that policy. */
  async restore(wire: string, keys: VerifiedEpochKeys): Promise<void> {
    const expected = context(wire);
    await this.database.exclusive(async (tx) => {
      const text = await tx.load();
      invariant(text !== null, 'missing-epoch-candidate');
      const candidate = decode(text).candidates.find((c) => c.wire === wire);
      invariant(candidate !== undefined, 'missing-epoch-candidate');
      const secret = this.protection.open({ ...expected }, fromHex(candidate.wrapped));
      try {
        invariant(
          (await commitEpochKey(expected.genesis, secret)) === expected.commitment,
          'epoch-key-mismatch'
        );
        await keys.install(expected.epoch, secret);
      } finally {
        secret.fill(0);
      }
    });
  }
}
