import { ChainVerifier, type ChainSnapshot, type ControlPolicy, type TrustAnchor } from './chain';
import { checkHex, decodeRecord, invariant, MAX_WIRE_BYTES, WebCryptoControl } from './wire';

export const MAX_READ_BYTES = 16 * 1024 * 1024;
export const MAX_READ_RECORDS = 4096;
export const MAX_READ_PAGES = 4096;

export function checkOffset(value: unknown): asserts value is string {
  invariant(
    typeof value === 'string' && value.length > 0 && value.length <= 1024 && value !== 'now',
    'invalid-offset'
  );
}

// Validate untrusted port results without Array.isArray narrowing readonly arrays to any[].
function checkArray(value: unknown, code: string): void {
  invariant(Array.isArray(value), code);
}

/** No cursor exists for an interior record: persist the whole verified page or none of it. */
export interface StoredPage {
  readonly records: readonly string[];
  readonly nextOffset: string;
}
export interface ControlReadPage extends StoredPage {
  /** Backend-observed tail only; not an independent freshness proof. */
  readonly upToDate: boolean;
}
export interface ControlJournal {
  readonly genesis: string;
  readonly pages: readonly StoredPage[];
  readonly pending: string | null;
}

export interface JournalTransaction {
  load(): Promise<ControlJournal | null>;
  /** Atomic and durable before resolving, including pending + all accepted records/offsets. */
  save(journal: ControlJournal): Promise<void>;
}

export interface ControlStore {
  /** Exclusive across ALL users of this journal, including processes; crash releases the lock. */
  exclusive<T>(work: (transaction: JournalTransaction) => Promise<T>): Promise<T>;
}

export interface ControlStream {
  /** Opaque initial cursor, bound by the adapter to this Org's single control stream. */
  readonly initialOffset: string;
  /** One complete page from offset. A partial catch-up must return upToDate=false. */
  readAfter(offset: string): Promise<ControlReadPage>;
  /** Exactly one atomic compare-and-append. "unsupported" means this call was never enqueued/applied;
   * it says nothing about earlier calls. Never ordinary append or silently changed bytes/offset. */
  appendCas(offset: string, wire: string): Promise<'accepted' | 'conflict' | 'unsupported'>;
}

export interface SubmitResult<S> {
  readonly status: 'committed' | 'conflict' | 'unknown' | 'unsupported';
  /** Verified relative to the backend read; not a global-freshness or non-fork proof. */
  readonly snapshot: ChainSnapshot<S>;
}

type Session<S> = { journal: ControlJournal; verifier: ChainVerifier<S>; offset: string };

/** Experimental driver. Network and storage are injected, never implicitly installed. */
export class ControlLogClient<S> {
  private readonly anchor: TrustAnchor<S>;
  constructor(
    anchor: TrustAnchor<S>,
    private readonly policy: ControlPolicy<S>,
    private readonly store: ControlStore,
    private readonly stream: ControlStream,
    private readonly crypto = new WebCryptoControl()
  ) {
    this.anchor = structuredClone(anchor);
    checkOffset(stream.initialOffset);
  }

  private async save(
    tx: JournalTransaction,
    session: Session<S>,
    pending: string | null
  ): Promise<void> {
    const next = { ...session.journal, pending };
    await tx.save(structuredClone(next));
    session.journal = next;
  }

  private async load(tx: JournalTransaction): Promise<Session<S>> {
    const journal = structuredClone(await tx.load()) ?? {
      genesis: this.anchor.genesis,
      pages: [],
      pending: null,
    };
    invariant(journal.genesis === this.anchor.genesis, 'journal-anchor-mismatch');
    checkArray(journal.pages, 'unsupported-journal-shape');
    const verifier = new ChainVerifier(this.anchor, this.policy, this.crypto);
    let offset = this.stream.initialOffset;
    const offsets = new Set([offset]);
    for (const [index, page] of journal.pages.entries()) {
      checkOffset(page.nextOffset);
      invariant(!offsets.has(page.nextOffset), 'invalid-offset');
      checkArray(page.records, 'invalid-page');
      invariant(page.records.length > 0 || index === 0, 'empty-page');
      invariant(page.records.length <= MAX_READ_RECORDS, 'read-too-large');
      for (const wire of page.records) await verifier.append(wire);
      offsets.add(page.nextOffset);
      offset = page.nextOffset;
    }
    if (journal.pending !== null) {
      invariant(
        decodeRecord(journal.pending).event.genesis === this.anchor.genesis,
        'pending-anchor-mismatch'
      );
    }
    return { journal, verifier, offset };
  }

  private async refresh(tx: JournalTransaction, session: Session<S>): Promise<void> {
    const offsets = new Set([
      this.stream.initialOffset,
      ...session.journal.pages.map((page) => page.nextOffset),
    ]);
    let recordsRead = 0;
    let bytesRead = 0;
    for (let count = 0; count < MAX_READ_PAGES; count++) {
      const page = structuredClone(await this.stream.readAfter(session.offset));
      checkOffset(page.nextOffset);
      checkArray(page.records, 'invalid-page');
      invariant(typeof page.upToDate === 'boolean', 'invalid-page');
      recordsRead += page.records.length;
      invariant(recordsRead <= MAX_READ_RECORDS, 'read-too-large');
      if (page.records.length === 0) {
        invariant(page.upToDate, 'incomplete-read');
        if (page.nextOffset === session.offset) return;
        // A first empty read may canonicalize the reserved start cursor to the real empty tail.
        invariant(session.journal.pages.length === 0, 'incomplete-read');
      }
      invariant(!offsets.has(page.nextOffset), 'invalid-offset');
      for (const wire of page.records) {
        invariant(typeof wire === 'string' && wire.length <= MAX_WIRE_BYTES, 'invalid-wire');
        bytesRead += wire.length;
        invariant(bytesRead <= MAX_READ_BYTES, 'read-too-large');
      }
      // The verifier is private to this invocation. Any failure discards its in-memory
      // partial page; neither its cursor nor a subset of its records may be saved.
      for (const wire of page.records) await session.verifier.append(wire);
      const next: ControlJournal = {
        ...session.journal,
        pages: [...session.journal.pages, { records: page.records, nextOffset: page.nextOffset }],
      };
      await tx.save(structuredClone(next));
      session.journal = next;
      session.offset = page.nextOffset;
      offsets.add(page.nextOffset);
      if (page.upToDate) return;
    }
    invariant(false, 'read-too-large');
  }

  async read(): Promise<ChainSnapshot<S>> {
    return this.store.exclusive(async (tx) => {
      const session = await this.load(tx);
      await this.refresh(tx, session);
      return session.verifier.snapshot();
    });
  }

  /** Verify the complete observed prefix before returning historical authority.
   * Never stops catch-up at the requested head or treats it as current permission. */
  async readAtHead(head: string): Promise<{
    readonly atHead: ChainSnapshot<S> | null;
    readonly snapshot: ChainSnapshot<S>;
  }> {
    checkHex(head, 32);
    return this.store.exclusive(async (tx) => {
      const session = await this.load(tx);
      await this.refresh(tx, session);
      const snapshot = session.verifier.snapshot();
      if (snapshot.head === head) return { atHead: structuredClone(snapshot), snapshot };
      const historical = new ChainVerifier(this.anchor, this.policy, this.crypto);
      if (head === this.anchor.genesis) return { atHead: historical.snapshot(), snapshot };
      for (const page of session.journal.pages) {
        for (const wire of page.records) {
          await historical.append(wire);
          const atHead = historical.snapshot();
          if (atHead.head === head) return { atHead, snapshot };
        }
      }
      return { atHead: null, snapshot };
    });
  }

  /** Historical evidence only. Refreshes checkpoints, but never submits or clears pending.
   * A missing wire means absent from this backend-observed prefix, not globally absent. */
  async readOperation(operationId: string): Promise<{
    readonly wire: string | null;
    readonly snapshot: ChainSnapshot<S>;
  }> {
    checkHex(operationId, 16);
    return this.store.exclusive(async (tx) => {
      const session = await this.load(tx);
      await this.refresh(tx, session);
      return {
        wire: session.verifier.operationWire(operationId) ?? null,
        snapshot: session.verifier.snapshot(),
      };
    });
  }

  /** Submit exact canonical signed bytes. A conflict requires explicit re-authorization/re-signing by the caller. */
  async submit(wire: string): Promise<SubmitResult<S>> {
    decodeRecord(wire);
    return this.run(wire);
  }

  /** Retry an interrupted attempt using ONLY its durably stored bytes. */
  async resume(): Promise<SubmitResult<S>> {
    return this.run();
  }

  private async run(requested?: string): Promise<SubmitResult<S>> {
    return this.store.exclusive(async (tx) => {
      const session = await this.load(tx);
      const retrying = session.journal.pending !== null;
      const wire = requested ?? session.journal.pending;
      invariant(wire !== null && wire !== undefined, 'no-pending-attempt');
      invariant(
        session.journal.pending === null || session.journal.pending === wire,
        'pending-attempt-exists'
      );
      const { event } = decodeRecord(wire);
      invariant(event.genesis === this.anchor.genesis, 'wrong-genesis');
      await this.refresh(tx, session);

      const reconcile = async (): Promise<SubmitResult<S> | undefined> => {
        const found = session.verifier.operationWire(event.operationId);
        if (found !== undefined) {
          // Same ID is not enough: an altered payload must never inherit an old acknowledgement.
          invariant(found === wire, 'operation-reused');
          await this.save(tx, session, null);
          return { status: 'committed', snapshot: session.verifier.snapshot() };
        }
        if (event.previous !== session.verifier.snapshot().head) {
          await this.save(tx, session, null);
          return { status: 'conflict', snapshot: session.verifier.snapshot() };
        }
        return undefined;
      };

      const prior = await reconcile();
      if (prior) return prior;
      await session.verifier.check(wire);
      // No network write before durable outbox persistence. Failure retains either old or new atomic journal.
      await this.save(tx, session, wire);
      let result: 'accepted' | 'conflict' | 'unsupported' | 'unknown';
      try {
        result = await this.stream.appendCas(session.offset, wire);
      } catch {
        result = 'unknown';
      }
      // Never promote an append ACK (including producer duplicate ACKs) to verified state.
      // A read/storage error leaves the pending bytes intact for the next resume.
      await this.refresh(tx, session);
      const observed = await reconcile();
      if (observed) return observed;
      // A prior request may still commit after losing its response. A retry's capability
      // rejection cannot prove that earlier request did not/will not execute.
      if (result === 'unsupported' && !retrying) {
        await this.save(tx, session, null);
        return { status: 'unsupported', snapshot: session.verifier.snapshot() };
      }
      return { status: 'unknown', snapshot: session.verifier.snapshot() };
    });
  }
}
