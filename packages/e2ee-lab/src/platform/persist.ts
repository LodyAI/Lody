import {
  MemoryLedgerStore,
  type LedgerJournal,
  type LedgerStore,
  type LedgerTransaction,
} from '@lody/e2ee-core/ledger';
import { fromHex, toHex } from './bytes';

export interface DemoKv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const processStores = new Map<string, Map<string, string>>();

function mapKv(store: Map<string, string>): DemoKv {
  return {
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

export function accountKv(account: string, explicit?: DemoKv): DemoKv {
  if (explicit) return explicit;
  const storage = (globalThis as { localStorage?: DemoKv }).localStorage;
  if (storage && typeof storage.getItem === 'function') {
    const prefix = `e2ee-demo:${account}:`;
    return {
      getItem(key) {
        return storage.getItem(prefix + key);
      },
      setItem(key, value) {
        storage.setItem(prefix + key, value);
      },
    };
  }
  let inner = processStores.get(account);
  if (!inner) {
    inner = new Map();
    processStores.set(account, inner);
  }
  return mapKv(inner);
}

export function encodeJournal(journal: LedgerJournal): string {
  return JSON.stringify({
    genesis: toHex(journal.genesis),
    records: journal.records.map((record) => toHex(record)),
    pending: journal.pending ? toHex(journal.pending) : null,
    offset: journal.offset,
  });
}

export function decodeJournal(raw: string): LedgerJournal {
  const fields = JSON.parse(raw) as {
    genesis: string;
    records: string[];
    pending: string | null;
    offset: string;
  };
  return {
    genesis: fromHex(fields.genesis),
    records: fields.records.map((row) => fromHex(row)),
    pending: fields.pending ? fromHex(fields.pending) : null,
    offset: fields.offset,
  };
}

export class PersistingLedgerStore implements LedgerStore {
  readonly inner = new MemoryLedgerStore();

  constructor(private readonly kv: DemoKv) {
    const raw = kv.getItem('journal');
    if (raw) this.inner.journal = decodeJournal(raw);
  }

  private persist(journal: LedgerJournal): void {
    this.kv.setItem('journal', encodeJournal(journal));
  }

  async exclusive<T>(work: (transaction: LedgerTransaction) => Promise<T>): Promise<T> {
    return this.inner.exclusive(async (tx) =>
      work({
        load: () => tx.load(),
        save: async (journal) => {
          this.persist(journal);
          await tx.save(journal);
        },
      })
    );
  }
}
