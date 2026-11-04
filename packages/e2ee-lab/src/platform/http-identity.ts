import { Data, Effect, Result, Schema } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { verifySignature } from '@lody/e2ee-core/protocol';
import {
  decodeRecord,
  hashRecordBytes,
  verifyLedger,
  joinRequestSigningBytes,
  type JoinRequest,
} from '@lody/e2ee-core/protocol';
import { type DeviceSigner } from '@lody/e2ee-core';
import { signVerified } from '@lody/e2ee-core/protocol';
import { labPossessionMessage } from './credentials';
import { labJoinWire, parseLabJoin } from './join-mailbox';
import { makeLabSdkOwner } from './sdk-owner';
import {
  invitationSnapshotWire,
  parseInvitationSnapshot,
  InvitationSnapshotWire,
} from './invitation-wire';
import type { WorkspaceInvitationSnapshot } from '@lody/e2ee-core';
import { readBoundedBody } from './bounded-body';

export class LabHttpIdentityError extends Data.TaggedError('LabHttpIdentityError')<{
  readonly code: 'invalid-origin' | 'invalid-response' | 'response-too-large' | 'closed';
}> {}
const fail = (code: LabHttpIdentityError['code']) => new LabHttpIdentityError({ code });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const HashHex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Timestamp = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const Challenge = Schema.Struct({ nonce: HashHex });
const Credential = Schema.Struct({
  token: HashHex,
  account: Schema.String,
  deviceHex: HashHex,
  genesisHex: Schema.NullOr(HashHex),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
});
const GenesisReply = Schema.Struct({
  genesis: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2}){1,8192}$/)),
});
const JoinWire = Schema.Struct({
  requestId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
  userId: HashHex,
  signingPublicKey: HashHex,
  encryptionPublicKey: HashHex,
  expiresAt: Schema.NullOr(Timestamp),
  signature: Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/)),
});
const JoinList = Schema.Struct({ requests: Schema.Array(JoinWire) });
const JoinReceipt = Schema.Struct({ ok: Schema.Literal(true) });
const CreationReceipt = Schema.Struct({
  genesisHex: HashHex,
  headHex: HashHex,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(4096)),
  offset: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
const maxReplyBytes = 20 * 1024;

/** Synthetic local possession/bearer client, not product identity or key custody.
 * Scope owns credential fetch AND bounded response body. Native SDK fetch ports
 * borrow its signal and remain owned by their calling transport. No Effect runner
 * or protocol EOF disposal. No strict deadline claim/ordinary leeway change. */
export const makeLabHttpIdentity = Effect.fnUntraced(function* (input: {
  readonly baseUrl: string;
  readonly genesis: Bytes.GenesisHash;
  /** Explicit native local transport/instrumentation capability. */
  readonly fetch?: typeof fetch;
}) {
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const origin = yield* Effect.try({
    try: () => {
      const base = new URL(input.baseUrl);
      if (
        base.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
        base.username ||
        base.password ||
        base.pathname !== '/' ||
        base.search ||
        base.hash
      )
        throw fail('invalid-origin');
      return base.origin;
    },
    catch: () => fail('invalid-origin'),
  });
  const transport = input.fetch ?? fetch;
  const owner = yield* makeLabSdkOwner(() => ({ close: async () => undefined }));
  const genesisHex = hex(genesis.toBytes());
  const url = `${origin}/v1/spaces/${genesisHex}/key-mailbox`;
  const readJson = Effect.fnUntraced(function* (request: () => Promise<Response>, limit: number) {
    const reply = yield* owner.invoke(async () => {
      const response = await request();
      if (response.status !== 200) {
        await response.body?.cancel();
        return { refused: true as const };
      }
      if (!response.body) return { refused: true as const };
      const bytes = await readBoundedBody(response.body, limit);
      return bytes === undefined ? { oversized: true as const } : { bytes };
    });
    if ('refused' in reply) return yield* fail('invalid-response');
    if ('oversized' in reply) return yield* fail('response-too-large');
    return yield* Effect.try({
      try: (): unknown => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.bytes)),
      catch: () => fail('invalid-response'),
    });
  });
  const post = (path: string, value: unknown) =>
    readJson(
      () =>
        transport(origin + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          redirect: 'error',
          signal: owner.signal,
          body: JSON.stringify(value),
        }),
      16 * 1024
    );
  return Object.freeze({
    url,
    stop: owner.stop,
    authenticate: Effect.fnUntraced(function* (
      signer: DeviceSigner,
      binding: 'workspace' | 'unbound' = 'workspace'
    ) {
      if (owner.signal.aborted) return yield* fail('closed');
      const captured = yield* Effect.try({
        try: () =>
          Object.freeze({
            publicKey: Result.getOrThrow(Bytes.signingPublicKey(signer.publicKey.toBytes())),
            sign: signer.sign.bind(signer),
          }),
        catch: () => fail('invalid-response'),
      });
      if (binding !== 'workspace' && binding !== 'unbound') return yield* fail('invalid-response');
      const deviceHex = hex(captured.publicKey.toBytes());
      const account = `synthetic-${deviceHex}`;
      const challenge = yield* Effect.fromResult(
        Result.mapError(
          Schema.decodeUnknownResult(Challenge)(
            yield* post('/v1/credentials/challenge', { account, deviceHex })
          ),
          () => fail('invalid-response')
        )
      );
      const signature = yield* signVerified(
        captured,
        yield* Effect.fromResult(labPossessionMessage(account, captured.publicKey, challenge.nonce))
      );
      const bound = binding === 'workspace' ? genesisHex : null;
      const credential = yield* Effect.fromResult(
        Result.mapError(
          Schema.decodeUnknownResult(Credential)(
            yield* post('/v1/credentials', {
              account,
              deviceHex,
              nonce: challenge.nonce,
              signature: hex(signature.toBytes()),
              genesisHex: bound,
            })
          ),
          () => fail('invalid-response')
        )
      );
      if (
        credential.account !== account ||
        credential.deviceHex !== deviceHex ||
        credential.genesisHex !== bound ||
        credential.expiresAt <= credential.issuedAt
      )
        return yield* fail('invalid-response');
      const authenticatedFetch: typeof fetch = async (request, init) => {
        if (owner.signal.aborted) throw fail('closed');
        const outgoing = new Request(request, init);
        const target = new URL(outgoing.url);
        if (target.origin !== origin || target.username || target.password)
          throw fail('invalid-origin');
        const headers = new Headers(outgoing.headers);
        headers.set('authorization', `Bearer ${credential.token}`);
        return transport(
          new Request(outgoing, {
            headers,
            redirect: 'error',
            signal: AbortSignal.any([outgoing.signal, owner.signal]),
          })
        );
      };
      const validateJoin = Effect.fnUntraced(function* (value: unknown) {
        const wire = yield* Effect.fromResult(
          Result.mapError(Schema.decodeUnknownResult(JoinWire)(value), () =>
            fail('invalid-response')
          )
        );
        const request = yield* Effect.fromResult(parseLabJoin(wire));
        yield* Effect.fromResult(
          verifySignature(
            request.signingPublicKey.toBytes(),
            yield* Effect.fromResult(joinRequestSigningBytes(genesis, request)),
            request.signature.toBytes()
          )
        );
        return Object.freeze(request);
      });
      const submitJoin = Effect.fnUntraced(function* (request: JoinRequest) {
        if (owner.signal.aborted) return yield* fail('closed');
        const owned = yield* validateJoin(
          yield* Effect.try({
            try: () => labJoinWire(request),
            catch: () => fail('invalid-response'),
          })
        );
        if (!owned.signingPublicKey.equals(captured.publicKey))
          return yield* fail('invalid-response');
        yield* Effect.fromResult(
          Result.mapError(
            Schema.decodeUnknownResult(JoinReceipt)(
              yield* readJson(
                () =>
                  authenticatedFetch(`${origin}/v1/spaces/${genesisHex}/joins`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(labJoinWire(owned)),
                  }),
                16 * 1024
              )
            ),
            () => fail('invalid-response')
          )
        );
        // Receipt is inert and can be lost after server persistence. Retrying
        // these original bytes is idempotent; do not generate another identity.
        return owned;
      });
      const listJoins = Effect.fnUntraced(function* () {
        if (owner.signal.aborted) return yield* fail('closed');
        const reply = yield* Effect.fromResult(
          Result.mapError(
            Schema.decodeUnknownResult(JoinList)(
              yield* readJson(
                () => authenticatedFetch(`${origin}/v1/spaces/${genesisHex}/joins`),
                256 * 1024
              )
            ),
            () => fail('invalid-response')
          )
        );
        const ids = new Set<string>(),
          requests: JoinRequest[] = [];
        for (const value of reply.requests) {
          if (ids.has(value.requestId)) return yield* fail('invalid-response');
          ids.add(value.requestId);
          requests.push(yield* validateJoin(value));
        }
        // A signed candidate is not current eligibility or admission authority.
        return Object.freeze(requests);
      });
      const invitationMailbox = Object.freeze({
        put: Effect.fnUntraced(function* (
          requestId: Bytes.RequestId,
          receipt: WorkspaceInvitationSnapshot
        ) {
          const original = invitationSnapshotWire(receipt);
          yield* Effect.fromResult(
            Schema.decodeUnknownResult(JoinReceipt)(
              yield* readJson(
                () =>
                  authenticatedFetch(
                    `${origin}/v1/spaces/${genesisHex}/joins/${hex(requestId.toBytes())}/snapshot`,
                    {
                      method: 'PUT',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(original),
                    }
                  ),
                16 * 1024
              )
            )
          );
        }),
        read: Effect.fnUntraced(function* (requestId: Bytes.RequestId) {
          const reply = yield* Effect.fromResult(
            Schema.decodeUnknownResult(
              Schema.Struct({ snapshot: Schema.NullOr(InvitationSnapshotWire) })
            )(
              yield* readJson(
                () =>
                  authenticatedFetch(
                    `${origin}/v1/spaces/${genesisHex}/joins/${hex(requestId.toBytes())}/snapshot`
                  ),
                4 * 1024 * 1024 + 4096
              )
            )
          );
          return reply.snapshot
            ? yield* Effect.fromResult(parseInvitationSnapshot(reply.snapshot))
            : null;
        }),
      });
      const discoverGenesis = Effect.fnUntraced(function* () {
        if (owner.signal.aborted) return yield* fail('closed');
        const reply = yield* Effect.fromResult(
          Result.mapError(
            Schema.decodeUnknownResult(GenesisReply)(
              yield* readJson(
                () => authenticatedFetch(`${origin}/v1/spaces/${genesisHex}/genesis`),
                maxReplyBytes
              )
            ),
            () => fail('invalid-response')
          )
        );
        const record = new Uint8Array(Buffer.from(reply.genesis, 'hex'));
        const head = hashRecordBytes(record);
        if (!Buffer.from(head.toBytes()).equals(Buffer.from(genesis.toBytes())))
          return yield* fail('invalid-response');
        const decoded = yield* Effect.fromResult(decodeRecord(record));
        if (decoded.body.type !== 'genesis') return yield* fail('invalid-response');
        yield* Effect.fromResult(
          verifyLedger({
            anchor: genesis,
            records: [record],
            checkpoint: { head, length: 1 },
          })
        );
        // Own original metadata only. Do not expose the one-record verifier view
        // as current membership, endpoint, cursor, custody or control bootstrap.
        return Object.freeze({ anchor: genesis, record });
      });
      const createWorkspace = Effect.fnUntraced(function* (record: Uint8Array) {
        if (owner.signal.aborted) return yield* fail('closed');
        const original = yield* Effect.try({
          try: () => new Uint8Array(record),
          catch: () => fail('invalid-response'),
        });
        const decoded = yield* Effect.fromResult(decodeRecord(original));
        const head = hashRecordBytes(original);
        if (
          original.byteLength > 8192 ||
          decoded.body.type !== 'genesis' ||
          !decoded.body.signer.equals(captured.publicKey) ||
          !Buffer.from(head.toBytes()).equals(Buffer.from(genesis.toBytes()))
        )
          return yield* fail('invalid-response');
        yield* Effect.fromResult(
          verifyLedger({
            anchor: genesis,
            records: [original],
            checkpoint: { head, length: 1 },
          })
        );
        const receipt = yield* Effect.fromResult(
          Result.mapError(
            Schema.decodeUnknownResult(CreationReceipt)(
              yield* readJson(
                () =>
                  authenticatedFetch(`${origin}/v1/spaces`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ genesis: hex(original) }),
                  }),
                maxReplyBytes
              )
            ),
            () => fail('invalid-response')
          )
        );
        if (
          receipt.genesisHex !== genesisHex ||
          (receipt.count === 1 && receipt.headHex !== hex(head.toBytes()))
        )
          return yield* fail('invalid-response');
        // An authenticated publication receipt is not independent current-history
        // qualification. Callers keep their own witnessed pins for later startup.
        return Object.freeze({ ...receipt });
      });
      return Object.freeze({
        url,
        fetch: authenticatedFetch,
        discoverGenesis,
        submitJoin,
        listJoins,
        invitationMailbox,
        createWorkspace,
      });
    }),
  });
});
