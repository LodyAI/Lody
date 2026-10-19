import { Data, Effect, Result, Schema } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { verifySignature } from '@lody/e2ee-core/protocol';
import { recordSigningBytes } from '@lody/e2ee-core/protocol';
import { authenticateEpochEnvelopeSignature } from '@lody/e2ee-core/protocol';
import { type LedgerView } from '@lody/e2ee-core';
import { decodeRecord } from '@lody/e2ee-core/protocol';
import { type EpochStagedGroup } from '@lody/e2ee-core';
import { type EpochStagedGroupKey } from '@lody/e2ee-core/services';
import { ownEpochStagedGroup, ownEpochStagedGroupKey } from '@lody/e2ee-core/protocol';
import { type EpochStagingPort } from '@lody/e2ee-core/internal';
import type { EpochStagedGroupDto } from '@lody/cloud-api/e2ee-epoch-staging';
import type { LabCredential } from './credentials';
import type { LabEpochStagingStore } from './epoch-staging';
import { makeLabSdkOwner } from './sdk-owner';
import { readBoundedBody } from './bounded-body';

export class LabEpochStagingHttpError extends Data.TaggedError('LabEpochStagingHttpError')<{
  readonly code: 'invalid-request' | 'unauthorized' | 'transport' | 'invalid-response' | 'closed';
}> {}
const fail = (code: LabEpochStagingHttpError['code']) => new LabEpochStagingHttpError({ code });
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Key = Schema.Struct({ genesis: Hash, epoch: Schema.Int, commitment: Hash, recordHash: Hash });
const Group = Schema.Struct({
  ...Key.fields,
  recordHex: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2}){1,8192}$/)),
  envelopes: Schema.Array(
    Schema.Struct({
      recipient: Hash,
      frameHex: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2}){1,512}$/)),
    })
  ).check(Schema.isMaxLength(4096)),
});
export interface LabEpochStagingHost {
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  readonly port: LabEpochStagingStore;
}
const Request = Schema.Union([
  Schema.Struct({ op: Schema.Literal('stage'), group: Group }),
  Schema.Struct({ op: Schema.Literal('read'), key: Key }),
  Schema.Struct({
    op: Schema.Literal('delete'),
    key: Key,
    occupied: Schema.Struct({ epoch: Schema.Int, commitment: Hash }),
  }),
]);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
export const encodeLabEpochGroup = (group: EpochStagedGroup): EpochStagedGroupDto => ({
  genesis: group.genesis,
  epoch: group.epoch,
  commitment: group.commitment,
  recordHash: group.recordHash,
  recordHex: hex(group.record),
  envelopes: group.envelopes.map((row) => ({ recipient: row.recipient, frameHex: hex(row.frame) })),
});
export function decodeLabEpochGroup(value: unknown) {
  return Result.gen(function* () {
    const group = yield* Result.mapError(Schema.decodeUnknownResult(Group)(value), () =>
      fail('invalid-response')
    );
    return yield* ownEpochStagedGroup({
      ...group,
      record: new Uint8Array(Buffer.from(group.recordHex, 'hex')),
      envelopes: group.envelopes.map((row) => ({
        recipient: row.recipient,
        frame: new Uint8Array(Buffer.from(row.frameHex, 'hex')),
      })),
    });
  });
}
/** Stored bearer chooses principal; rows/JSON never choose a ledger or device.
 * Storage checks fixed signatures/context, not current parent or permission.
 * The publisher proves the complete genuine poststate and P09 decides inclusion;
 * even a well-signed stored group is inert until independently verified commit. */
export const dispatchLabEpochStaging = Effect.fnUntraced(function* (input: {
  readonly value: unknown;
  readonly genesis: Bytes.GenesisHash;
  readonly credential: LabCredential;
  readonly ledger: () => Effect.Effect<LedgerView, unknown>;
  readonly port: LabEpochStagingStore;
}) {
  const request = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Request)(input.value),
    catch: () => fail('invalid-request'),
  });
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const principal = yield* Effect.fromResult(
    Bytes.signingPublicKey(input.credential.device.toBytes())
  );
  const bound = input.credential.genesis
    ? yield* Effect.fromResult(Bytes.genesisHash(input.credential.genesis.toBytes()))
    : null;
  const ledger = input.ledger;
  const port = Object.freeze({
    stageGroup: input.port.stageGroup.bind(input.port),
    readGroup: input.port.readGroup.bind(input.port),
    deleteGroupFor: input.port.deleteGroupFor.bind(input.port),
  });
  const view = yield* ledger();
  const org = hex(genesis.toBytes()),
    device = hex(principal.toBytes());
  if (
    !view.genesis.equals(genesis) ||
    !bound?.equals(genesis) ||
    !view.inspectState().devices.has(device)
  )
    return yield* fail('unauthorized');
  if (request.op === 'stage') {
    const group = yield* Effect.fromResult(decodeLabEpochGroup(request.group));
    if (group.genesis !== org) return yield* fail('unauthorized');
    const record = yield* Effect.fromResult(decodeRecord(group.record));
    if (record.body.type !== 'ordinary' || !record.body.signer.equals(principal))
      return yield* fail('unauthorized');
    yield* Effect.fromResult(
      verifySignature(
        principal.toBytes(),
        recordSigningBytes(record.bodyBytes),
        record.signature.toBytes()
      )
    );
    for (const row of group.envelopes)
      yield* Effect.fromResult(
        authenticateEpochEnvelopeSignature(
          {
            genesis,
            epoch: yield* Effect.fromResult(Bytes.epochNumber(group.epoch)),
            sender: principal,
            recipient: yield* Effect.fromResult(
              Bytes.signingPublicKey(new Uint8Array(Buffer.from(row.recipient, 'hex')))
            ),
          },
          row.frame
        )
      );
    yield* port.stageGroup(group);
    return { ok: true } as const;
  }
  const key = yield* Effect.fromResult(ownEpochStagedGroupKey(request.key));
  if (key.genesis !== org) return yield* fail('unauthorized');
  if (request.op === 'read') {
    const group = yield* port.readGroup(key);
    return group === null ? null : encodeLabEpochGroup(group);
  }
  yield* port
    .deleteGroupFor(principal, key, request.occupied)
    .pipe(
      Effect.mapError((error) => (error.code === 'unauthorized' ? fail('unauthorized') : error))
    );
  return { ok: true } as const;
});
/** Authenticated local fixture transport. Its owner retains raw fetch AND body
 * until settlement; one request stages the complete immutable group. */
export const makeLabEpochStagingRemote = Effect.fnUntraced(function* (input: {
  readonly url: string;
  readonly fetch: typeof fetch;
}) {
  const url = input.url,
    transport = input.fetch;
  const owner = yield* makeLabSdkOwner(() => ({ close: async () => undefined }));
  const call = <A>(value: unknown, decode: (value: unknown) => A) =>
    owner
      .invoke(async () => {
        const response = await transport(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
          signal: owner.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return Result.fail(
            fail(response.status === 401 || response.status === 403 ? 'unauthorized' : 'transport')
          );
        }
        if (!response.body) return Result.fail(fail('invalid-response'));
        const body = await readBoundedBody(response.body, 6 * 1024 * 1024);
        if (!body) return Result.fail(fail('invalid-response'));
        return Result.try({
          try: () => decode(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))),
          catch: () => fail('invalid-response'),
        });
      })
      .pipe(
        Effect.mapError((error) => fail(error.code === 'closed' ? 'closed' : 'transport')),
        Effect.flatMap(Effect.fromResult)
      );
  const ack = (value: unknown) =>
    Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Literal(true) }))(value);
  return Object.freeze({
    stageGroup: (source: EpochStagedGroup) =>
      Effect.gen(function* () {
        const group = yield* Effect.fromResult(ownEpochStagedGroup(source));
        yield* call({ op: 'stage', group: encodeLabEpochGroup(group) }, ack);
      }),
    readGroup: (source: EpochStagedGroupKey) =>
      Effect.gen(function* () {
        const key = yield* Effect.fromResult(ownEpochStagedGroupKey(source));
        return yield* call({ op: 'read', key }, (value) => {
          if (value === null) return null;
          const group = Result.getOrThrow(decodeLabEpochGroup(value));
          if (
            group.genesis !== key.genesis ||
            group.epoch !== key.epoch ||
            group.commitment !== key.commitment ||
            group.recordHash !== key.recordHash
          )
            throw fail('invalid-response');
          return group;
        });
      }),
    deleteGroup: (
      source: EpochStagedGroupKey,
      occupied: { readonly epoch: number; readonly commitment: string }
    ) =>
      Effect.gen(function* () {
        const key = yield* Effect.fromResult(ownEpochStagedGroupKey(source));
        const condition = { epoch: occupied.epoch, commitment: occupied.commitment };
        yield* call({ op: 'delete', key, occupied: condition }, ack);
      }),
  }) satisfies EpochStagingPort;
});
