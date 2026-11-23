import { Data, Effect, Result } from 'effect';
import { createHash } from 'node:crypto';
import { LabDocumentError, type LabSealedWrite } from './document-sqlite';
import { ContentError, ValidationError } from '@lody/e2ee-core';
import { PayloadProtectionError, type PayloadProtectionProvider } from '@loro-dev/streams-crdt';
import { makeStreamsUpdateBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { LabCallbackRunner } from './run';
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

export class LabProviderError extends Data.TaggedError('LabProviderError')<{
  readonly code: 'harness';
}> {}

/** Lab-only Promise/SDK callback boundary. No injected runner, verifier or alternate core.
 * The surrounding Scope owns this adapter before its SDK transports/Wasm owners are released.
 * Header4 marks snapshots; the core authenticates their content-header positions. */
export function makeLabUpdateProvider(
  input: Parameters<typeof makeStreamsUpdateBinding>[0] & {
    readonly binding?: Effect.Success<ReturnType<typeof makeStreamsUpdateBinding>>;
    /** Session retains exact sealed originals until the SDK confirms its write. */
    readonly sealedWrites?: {
      load: () => Result.Result<readonly LabSealedWrite[], LabDocumentError>;
      save: (row: LabSealedWrite) => Result.Result<void, LabDocumentError>;
      clear: () => Result.Result<void, LabDocumentError>;
    };
  }
) {
  return Effect.gen(function* () {
    const binding = input.binding ?? (yield* makeStreamsUpdateBinding(input));
    let closed = false,
      harnessFailure = false;
    const pending: LabSealedWrite[] = input.sealedWrites
      ? [...(yield* Effect.fromResult(input.sealedWrites.load()))]
      : [];
    let retrying = false;
    const clearWrites = () => {
      for (const row of pending) {
        row.aad.fill(0);
        row.header.fill(0);
        row.sealed.fill(0);
      }
      pending.length = 0;
    };
    let originalFailure: ContentError | ValidationError | LabDocumentError | undefined;
    // Registered after binding: reject callbacks and interrupt/await owned fibers first.
    const owner = yield* Effect.acquireRelease(
      Effect.sync(() => new LabCallbackRunner()),
      (run) =>
        Effect.gen(function* () {
          closed = true;
          yield* Effect.promise(() => run.close());
          clearWrites();
        })
    );
    const failure = (cause: unknown, operation: 'seal' | 'open') => {
      if (cause instanceof PayloadProtectionError) return cause;
      if (
        cause instanceof ContentError ||
        cause instanceof ValidationError ||
        cause instanceof LabDocumentError
      )
        originalFailure = cause;
      if (
        !(cause instanceof ContentError) &&
        !(cause instanceof ValidationError) &&
        !(cause instanceof LabDocumentError)
      )
        harnessFailure = true;
      if (
        cause instanceof ContentError &&
        (cause.code === 'closed' || cause.code === 'native-unavailable')
      )
        harnessFailure = true;
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
      return new PayloadProtectionError(
        code === 'unsupported-streams-context'
          ? 'wrong_payload_kind'
          : code === 'missing-read-key'
            ? 'missing_read_key'
            : operation === 'seal'
              ? 'encrypt_failed'
              : 'decrypt_failed',
        'Lab protected content operation failed'
      );
    };
    const provider = {
      maxSealOverheadBytes: binding.maxSealOverheadBytes,
      async seal(request) {
        if (closed) throw new PayloadProtectionError('encrypt_failed', 'Lab provider is closed');
        try {
          const context = JSON.stringify([
            request.context.protocol,
            request.context.version,
            request.context.kind,
            request.context.continuationOffset ?? null,
          ]);
          const plaintextDigest = createHash('sha256').update(request.plaintext).digest('hex');
          // Snapshot originals already belong to the publication gateway. Only
          // update uploads need this document-owned retry journal.
          const retain = input.sealedWrites && request.context.kind === 'update_batch';
          const retained = retain
            ? pending.find(
                (row) => row.context === context && row.plaintextDigest === plaintextDigest
              )
            : undefined;
          if (retain && retrying && !retained) throw new ContentError({ code: 'pending-write' });
          if (retained) {
            const aad = request.additionalData(new Uint8Array(retained.header));
            if (retained.context !== context || !sameBytes(retained.aad, aad))
              throw new ContentError({ code: 'pending-write' });
            return {
              header: new Uint8Array(retained.header),
              sealed: new Uint8Array(retained.sealed),
            };
          }
          let aad: Uint8Array | undefined;
          const plaintext = new Uint8Array(request.plaintext);
          try {
            const value = await owner.run(
              binding.seal({
                ...request,
                plaintext,
                additionalData: (header) => {
                  const bytes = request.additionalData(header);
                  aad = new Uint8Array(bytes);
                  return bytes;
                },
              })
            );
            if (retain) {
              const row: LabSealedWrite = {
                plaintextDigest,
                context,
                aad: aad!,
                header: new Uint8Array(value.header),
                sealed: new Uint8Array(value.sealed),
              };
              Result.getOrThrow(input.sealedWrites!.save(row));
              pending.push(row);
            }
            if (closed)
              throw new PayloadProtectionError('encrypt_failed', 'Lab provider is closed');
            return value;
          } finally {
            plaintext.fill(0);
          }
        } catch (cause) {
          throw failure(cause, 'seal');
        }
      },
      async open(request) {
        if (closed) throw new PayloadProtectionError('decrypt_failed', 'Lab provider is closed');
        try {
          const plaintext = await owner.run(binding.open(request));
          if (closed) {
            plaintext.fill(0);
            throw new PayloadProtectionError('decrypt_failed', 'Lab provider is closed');
          }
          return plaintext;
        } catch (cause) {
          throw failure(cause, 'open');
        }
      },
    } satisfies PayloadProtectionProvider;
    return Object.freeze({
      ...provider,
      hasPendingWrite: () => pending.length > 0,
      beginWrite: () => {
        retrying = pending.length > 0;
      },
      confirmWrite: () =>
        Effect.gen(function* () {
          if (input.sealedWrites) yield* Effect.fromResult(input.sealedWrites.clear());
          clearWrites();
        }),
      takeFailure: () => {
        const original = originalFailure;
        originalFailure = undefined;
        return original;
      },
      // Released SDKs may collapse unknown provider exceptions into decrypt_failed.
      // Preserve an independent local harness signal across that native boundary.
      checkFailure: () =>
        Effect.suspend(() => {
          const failed = harnessFailure;
          harnessFailure = false;
          return failed ? Effect.fail(new LabProviderError({ code: 'harness' })) : Effect.void;
        }),
    });
  });
}
