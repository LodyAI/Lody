import type { SnapshotTrust } from '../ledger/snapshot';
/** Cumulative verified records a client may retain. 10k from-zero chains must fit. */
export const MAX_LEDGER_RECORDS = 16_384;
/** Extend/work chunk. Adapter HTTP pages may be larger; refresh slices instead of rejecting. */
export const MAX_LEDGER_READ_PAGE_RECORDS = 1_024;
export const MAX_LEDGER_READ_PAGES = 256;
/** @deprecated Use MAX_LEDGER_RECORDS. Kept as the cumulative read budget alias. */
export const MAX_LEDGER_READ_RECORDS = MAX_LEDGER_RECORDS;

export interface LedgerJournal {
  readonly genesis: Uint8Array;
  readonly records: readonly Uint8Array[];
  readonly pending: Uint8Array | null;
  readonly offset: string;
  readonly snapshot?: Uint8Array;
  readonly snapshotTrust?: SnapshotTrust;
  /** True after the authenticated snapshot head is observed or a suffix extends it. */
  readonly snapshotBound?: boolean;
}

export interface LedgerTransaction {
  load(): Promise<LedgerJournal | null>;
  save(journal: LedgerJournal): Promise<void>;
}

export interface LedgerStore {
  exclusive<T>(work: (transaction: LedgerTransaction) => Promise<T>): Promise<T>;
}

export interface LedgerReadPage {
  readonly records: readonly Uint8Array[];
  readonly nextOffset: string;
  readonly upToDate: boolean;
}

export interface LedgerStream {
  readonly initialOffset: string;
  readAfter(offset: string): Promise<LedgerReadPage>;
  appendCas(offset: string, record: Uint8Array): Promise<'accepted' | 'conflict' | 'unsupported'>;
}
