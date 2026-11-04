import { Data, Effect } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { type LedgerCheckpoint } from '@lody/e2ee-core';
import { decodeRecord } from '@lody/e2ee-core/protocol';
import {
  makeStreamsLedgerLog,
  type LedgerSubmissionStream,
} from '@lody/e2ee-core/adapters/loro-streams';
import { authorizeLabStream } from './gateway';
import { frameLedgerRecord } from '@lody/e2ee-core/protocol';
import { makeLabOperations } from './operation-scope';

export class LabControlGatewayError extends Data.TaggedError('LabControlGatewayError')<{
  readonly code: 'unauthorized' | 'invalid-record' | 'join-expired' | 'transport' | 'closed';
}> {}
/** Host consumer only. Authentication and independently selected durable checkpoints
 * belong to the host, not request JSON/offsets. Core audits the entire signed history,
 * verifies the candidate and pins SDK CAS to the verified transport tail. Caller
 * headers have no upstream forwarding path. No duplicate submission journal or signer. */
export function makeLabControlGateway(input: {
  readonly genesis: Bytes.GenesisHash;
  readonly stream: LedgerSubmissionStream;
  readonly checkpoint: () => Effect.Effect<LedgerCheckpoint, unknown>;
  /** Persist the host's newly observed signed suffix before replying. A failed
   * confirmation leaves the caller's original P09 operation recoverable. */
  readonly afterAppend?: () => Effect.Effect<void, unknown>;
  readonly now: () => number;
  readonly budget: Parameters<typeof makeStreamsLedgerLog>[0]['budget'];
}) {
  return Effect.gen(function* () {
    const anchor = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
    const checkpoint = input.checkpoint,
      afterAppend = input.afterAppend,
      now = input.now,
      budget = { ...input.budget };
    const operations = yield* makeLabOperations();
    const guard = () =>
      operations.signal.aborted
        ? Effect.fail(new LabControlGatewayError({ code: 'closed' }))
        : Effect.void;
    const read = input.stream.read.bind(input.stream),
      append = input.stream.appendCas.bind(input.stream);
    return Object.freeze({
      append: (request: {
        readonly authenticatedCredential: Parameters<
          typeof authorizeLabStream
        >[0]['authenticatedCredential'];
        readonly requestGenesis: Bytes.GenesisHash;
        readonly record: Uint8Array;
      }) =>
        operations.run(
          Effect.gen(function* () {
            const captured = yield* Effect.try({
              try: () => ({
                device: request.authenticatedCredential.device.toBytes(),
                bound:
                  request.authenticatedCredential.genesis === null
                    ? null
                    : request.authenticatedCredential.genesis.toBytes(),
                requestGenesis: request.requestGenesis.toBytes(),
                framed: frameLedgerRecord(request.record),
              }),
              catch: () => new LabControlGatewayError({ code: 'invalid-record' }),
            });
            const device = yield* Effect.fromResult(Bytes.signingPublicKey(captured.device));
            const bound =
              captured.bound === null
                ? null
                : yield* Effect.fromResult(Bytes.genesisHash(captured.bound));
            const requestGenesis = yield* Effect.fromResult(
              Bytes.genesisHash(captured.requestGenesis)
            );
            const framed = yield* Effect.fromResult(captured.framed);
            const record = framed.subarray(4);
            let outcome: Awaited<ReturnType<LedgerSubmissionStream['appendCas']>> | undefined;
            const remote = yield* makeStreamsLedgerLog({
              genesis: anchor,
              checkpoint,
              budget,
              stream: {
                read: (readRequest) =>
                  read({
                    ...readRequest,
                    signal: AbortSignal.any([readRequest.signal, operations.signal]),
                  }),
                appendCas: async (value) => {
                  if (operations.signal.aborted)
                    throw new LabControlGatewayError({ code: 'closed' });
                  outcome = await append(value);
                  return outcome;
                },
              },
            });
            const history = yield* remote.read(anchor);
            yield* Effect.fromResult(
              authorizeLabStream({
                view: history.view,
                authenticatedCredential: { device, genesis: bound },
                requestGenesis,
                stream: 'control',
                method: 'POST',
                sub: 'append-cas',
                controlRecord: record,
              })
            );
            const decoded = yield* Effect.fromResult(decodeRecord(record));
            if (decoded.body.type !== 'ordinary' || !decoded.body.signer.equals(device))
              return yield* new LabControlGatewayError({ code: 'unauthorized' });
            const operation = decoded.body.operation;
            if (operation.type === 'admitMember' && operation.request.expiresAt !== null) {
              const time = now();
              if (!Number.isSafeInteger(time) || time < 0 || time >= operation.request.expiresAt)
                return yield* new LabControlGatewayError({ code: 'join-expired' });
            }
            const attempted = yield* Effect.result(
              remote.appendCas(anchor, history.checkpoint, record)
            );
            if (afterAppend) yield* afterAppend();
            yield* Effect.fromResult(attempted);
            yield* guard();
            const result = outcome;
            if (!result?.ok || result.result.kind !== 'ok')
              return yield* new LabControlGatewayError({ code: 'transport' });
            return { nextOffset: result.result.value.nextOffset };
          })
        ),
    });
  });
}
