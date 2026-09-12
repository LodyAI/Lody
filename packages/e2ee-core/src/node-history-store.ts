import type { HistoryPublication, HistoryPublicationStore } from './history-publisher';
import { SqliteTextStore } from './node-text-store';
import { decodeTeamAction } from './team-codec';
import { checkHex, decodeRecord, invariant } from './wire';

const FORMAT = 'lody-history-outbox/v1';
function validate(entry: HistoryPublication, genesis: string): string {
  const event = decodeRecord(entry.publication).event;
  const action = decodeTeamAction(event);
  invariant(event.genesis === genesis, 'history-anchor-mismatch');
  invariant(action.type === 'epoch.publish' && action.epoch > 0, 'not-history-publication');
  checkHex(entry.frameHex);
  invariant(entry.frameHex.length > 0 && entry.frameHex.length <= 8468, 'invalid-epoch-history');
  return event.operationId;
}

/** Ciphertext only. Disk metadata is never authority; publisher re-verifies every retry. */
export class SqliteHistoryPublicationStore implements HistoryPublicationStore {
  private readonly store: SqliteTextStore;
  constructor(
    path: string,
    private readonly genesis: string
  ) {
    checkHex(genesis, 32);
    this.store = new SqliteTextStore(path, 0x4c484231, 1);
  }
  async exclusive<T>(
    work: (tx: {
      load(operationId: string): Promise<HistoryPublication | null>;
      save(entry: HistoryPublication): Promise<void>;
    }) => Promise<T>
  ): Promise<T> {
    return this.store.exclusive(async (tx) => {
      const text = await tx.load();
      const entries = new Map<string, HistoryPublication>();
      if (text !== null) {
        const data: unknown = JSON.parse(text);
        invariant(
          Array.isArray(data) &&
            data.length === 3 &&
            data[0] === FORMAT &&
            data[1] === this.genesis &&
            Array.isArray(data[2]) &&
            data[2].length <= 4096,
          'invalid-history-outbox'
        );
        for (const row of data[2]) {
          invariant(
            Array.isArray(row) &&
              row.length === 2 &&
              typeof row[0] === 'string' &&
              typeof row[1] === 'string',
            'invalid-history-outbox'
          );
          const entry = { publication: row[0], frameHex: row[1] };
          const id = validate(entry, this.genesis);
          invariant(!entries.has(id), 'history-operation-reused');
          entries.set(id, entry);
        }
      }
      let active = true;
      try {
        return await work({
          load: async (id) => {
            invariant(active, 'journal-transaction-ended');
            checkHex(id, 16);
            return structuredClone(entries.get(id) ?? null);
          },
          save: async (input) => {
            invariant(active, 'journal-transaction-ended');
            const entry = { ...input };
            const id = validate(entry, this.genesis);
            const old = entries.get(id);
            invariant(
              old === undefined ||
                (old.publication === entry.publication && old.frameHex === entry.frameHex),
              'history-frame-conflict'
            );
            const next = new Map(entries).set(id, entry);
            invariant(next.size <= 4096, 'history-outbox-too-large');
            await tx.save(
              JSON.stringify([
                FORMAT,
                this.genesis,
                [...next.values()].map((e) => [e.publication, e.frameHex]),
              ])
            );
            entries.set(id, entry);
          },
        });
      } finally {
        active = false;
      }
    });
  }
}
