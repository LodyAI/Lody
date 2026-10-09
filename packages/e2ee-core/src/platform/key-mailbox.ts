import { Effect, Layer, Semaphore } from 'effect';
import {
  DistributionStore,
  EpochMailboxIndexStore,
  KeyMailboxRemote,
  type AtomicDocumentStore,
} from '../ports/key-mailbox';
import { KeyDeliveryRemote } from '../ports/key-delivery';
import { StorageError } from '../pure/errors';
import {
  emptyDistribution,
  encodeDocument,
  decodeDocument,
  validateDistribution,
  validateMailbox,
  type DistributionDocument,
} from '../pure/key-distribution';
import { emptyMailbox, type MailboxDocument } from '../pure/key-mailbox';
import type { KeyMailboxHost } from '../workflows/key-mailbox';
import type { SigningPublicKey } from '../pure/bytes';

/** In-memory reference, not durable. Own serialized copies and model failures before/after commit. */
class MemoryDocumentStore<A> implements AtomicDocumentStore<A> {
  private text: string;
  private readonly lock = Semaphore.makeUnsafe(1);
  failSave: 'before' | 'after' | null = null;
  constructor(
    initial: A,
    private readonly validate: (x: unknown) => x is A
  ) {
    this.text = JSON.stringify(initial);
  }
  readonly exclusive: AtomicDocumentStore<A>['exclusive'] = (work) =>
    this.lock.withPermits(1)(
      Effect.suspend(() =>
        work({
          load: Effect.suspend(() => Effect.fromResult(decodeDocument(this.text, this.validate))),
          save: (value) => {
            const encoded = encodeDocument(value, this.validate);
            return Effect.gen({ self: this }, function* () {
              const text = yield* Effect.fromResult(encoded);
              const failure = this.failSave;
              this.failSave = null;
              if (failure === 'before')
                return yield* Effect.fail(new StorageError({ reason: 'io' }));
              this.text = text;
              if (failure === 'after')
                return yield* Effect.fail(new StorageError({ reason: 'io' }));
              return undefined;
            });
          },
        })
      )
    );
}
export class MemoryDistributionStore extends MemoryDocumentStore<DistributionDocument> {
  constructor() {
    super(emptyDistribution(), validateDistribution);
  }
}
export class MemoryEpochMailboxIndexStore extends MemoryDocumentStore<MailboxDocument> {
  constructor() {
    super(emptyMailbox(), validateMailbox);
  }
}
export const memoryDistributionLayer = () =>
  Layer.succeed(DistributionStore, new MemoryDistributionStore());
/** In-process reference adapter. Principal is supplied by trusted composition,
 * production transports must authenticate it (never trust a body/header identity). */
export function keyMailboxRemoteLayer(host: KeyMailboxHost, principal: SigningPublicKey) {
  const service = host.remote(principal);
  return Layer.mergeAll(
    Layer.succeed(KeyMailboxRemote, service),
    Layer.succeed(KeyDeliveryRemote, service)
  );
}
export const memoryMailboxIndexLayer = () =>
  Layer.succeed(EpochMailboxIndexStore, new MemoryEpochMailboxIndexStore());
