/** Opaque host stream key and exact ciphertext, never encryption keys. */
export interface PublishedSnapshot {
  readonly offset: string;
  readonly body: Uint8Array;
}

export interface SnapshotPublicationTransaction {
  current(): PublishedSnapshot | undefined;
  admitted(offset: string): Uint8Array | undefined;
  /** Insert the immutable identity and advance current in the same commit. */
  save(snapshot: PublishedSnapshot): void;
}

/**
 * Trusted host storage. Callback is synchronous: no await between final
 * authorization and write. Commit must be durable before returning. Throwing
 * rolls back all writes. Concurrent processes must serialize, or return busy.
 * Reads return copies; transaction handles expire when the callback returns.
 */
export interface SnapshotPublicationStore {
  transaction<T>(streamKey: string, work: (tx: SnapshotPublicationTransaction) => T): T;
}

/** Explicitly non-durable reference backend. Use persistent storage in a host. */
export class MemorySnapshotPublicationStore implements SnapshotPublicationStore {
  private readonly streams = new Map<
    string,
    { current: string; bodies: Map<string, Uint8Array> }
  >();
  private active = false;

  transaction<T>(streamKey: string, work: (tx: SnapshotPublicationTransaction) => T): T {
    if (this.active) throw new Error('snapshot-store-busy');
    this.active = true;
    let live = true;
    const row = this.streams.get(streamKey);
    const bodies = new Map(row?.bodies);
    let current = row?.current;
    const check = () => {
      if (!live) throw new Error('snapshot-transaction-ended');
    };
    try {
      const result = work({
        current: () => {
          check();
          return current === undefined
            ? undefined
            : { offset: current, body: bodies.get(current)!.slice() };
        },
        admitted: (offset) => {
          check();
          return bodies.get(offset)?.slice();
        },
        save: (snapshot) => {
          check();
          if (bodies.has(snapshot.offset)) throw new Error('snapshot-identity-conflict');
          bodies.set(snapshot.offset, snapshot.body.slice());
          current = snapshot.offset;
        },
      });
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new Error('snapshot-async-transaction');
      if (current !== undefined) this.streams.set(streamKey, { current, bodies });
      return result;
    } finally {
      live = false;
      this.active = false;
    }
  }
}
