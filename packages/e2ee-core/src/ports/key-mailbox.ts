import { Context, Effect } from 'effect';
import type { ClientError, StorageError, ValidationError } from '../pure/errors';
import type { LedgerView } from '../pure/records';
import type { MailboxDocument, MailboxSlot, MailboxStatus, MailboxPage } from '../pure/key-mailbox';
import type { DistributionDocument } from '../pure/key-distribution';

export interface AtomicDocumentTransaction<A> {
  readonly load: Effect.Effect<A, StorageError | ValidationError>;
  /** Atomically commits the entire value, including terminal task AND unconsumed result.
   * A failure may occur after commit; callers reload. Never roll back previously saved bytes. */
  readonly save: (value: A) => Effect.Effect<void, StorageError | ValidationError>;
}
export interface AtomicDocumentStore<A> {
  readonly exclusive: <B, E, R>(
    work: (tx: AtomicDocumentTransaction<A>) => Effect.Effect<B, E, R>
  ) => Effect.Effect<B, E | StorageError | ValidationError, R>;
}
export class DistributionStore extends Context.Service<
  DistributionStore,
  AtomicDocumentStore<DistributionDocument>
>()('@lody/e2ee-core/DistributionStore') {}
export class EpochMailboxIndexStore extends Context.Service<
  EpochMailboxIndexStore,
  AtomicDocumentStore<MailboxDocument>
>()('@lody/e2ee-core/EpochMailboxIndexStore') {}
/** Trusted host projection supplier. Must refresh verified ledger authority at admission.
 * Adapter declares its synchronization/freshness boundary; this is no cross-stream transaction. */
export class MailboxAuthority extends Context.Service<
  MailboxAuthority,
  {
    readonly current: Effect.Effect<LedgerView, ClientError>;
  }
>()('@lody/e2ee-core/MailboxAuthority') {}
export interface MailboxTarget extends MailboxSlot {
  readonly status: MailboxStatus;
  readonly revision: number;
}
export interface MailboxEnvelope {
  readonly sender: string;
  readonly frame: Uint8Array;
}
/** Authenticated session bound to one device and Org by the host. Lists are hints.
 * Durable report/repair acceptance is idempotent. No plaintext key crosses this port. */
export class KeyMailboxRemote extends Context.Service<
  KeyMailboxRemote,
  {
    readonly status: (slot: MailboxSlot) => Effect.Effect<MailboxTarget, ClientError>;
    readonly list: (
      kind: 'needsEnvelope' | 'awaitingInstallationReport',
      cursor: string | null,
      limit: number
    ) => Effect.Effect<MailboxPage<MailboxTarget>, ClientError>;
    readonly fetch: (
      epoch: number,
      cursor: string | null,
      limit: number
    ) => Effect.Effect<MailboxPage<MailboxEnvelope>, ClientError>;
    readonly report: (
      bytes: Uint8Array,
      publication?: Uint8Array
    ) => Effect.Effect<void, ClientError>;
    /** Request ID binds one repair episode; rejectedDigest excludes an unusable envelope.
     * Lost-key repair retains usable ciphertext. An old report never proves current possession. */
    readonly repair: (
      slot: MailboxSlot,
      requestId: string,
      rejectedDigest?: string
    ) => Effect.Effect<void, ClientError>;
  }
>()('@lody/e2ee-core/KeyMailboxRemote') {}
