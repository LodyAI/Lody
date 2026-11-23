import { SeatInvitePreviewSchema } from '@lody/cloud-api/seat-invite-preview';
import {
  isTransientGatewayStatus,
  TRANSIENT_GATEWAY_RETRY_DELAYS_MS,
} from '@lody/shared/transient-gateway';
import { Cause, Effect, Exit, Result } from 'effect';
import { z } from 'zod';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import {
  api,
  makeBatchMailboxStatus,
  makeInlineMailboxFetch,
  makeInlineMailboxPut,
  makeInlineStageGroup,
  makeMailboxStatusCache,
  type E2eeContentTokenRequest,
  type E2eeMemberOffer,
  type E2eeWorkspaceHistoryRequest,
} from '@lody/cloud-api';
import { decodeMemberKeyPackage, MemberOfferSchema } from '@lody/e2ee-client/member';
import { Bytes, decodeRecord, hashRecordBytes } from '@lody/e2ee-core/protocol';
import { LedgerFeedError } from '@lody/e2ee-core';
import {
  BackendError,
  LedgerLogError,
  type ClientCustodyScope,
  type KeyMailbox,
  type EpochStagingStore,
  type LedgerFeedSource,
  type LedgerLog,
} from '@lody/e2ee-core/services';
import {
  decodeEpochStagedGroup,
  encodeEpochStagedGroup,
  ownEpochStagedGroup,
  ownEpochStagedGroupKey,
} from '@lody/e2ee-core/host';
import {
  makeInlineVersionReadHead,
  sharingReplySchemas,
  type SharingRemote,
} from '@lody/e2ee-machine-sharing';
import {
  decodePersonalRequest,
  type PersonalExchange,
  type PersonalExchangeResponse,
  type PersonalHostRemote,
} from '@lody/e2ee-client';

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const raw = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bytes = (max: number) =>
  z
    .string()
    .regex(/^(?:[0-9a-f]{2})+$/)
    .max(max * 2);
const checkpoint = z.object({ headHash: hash, length: integer.max(16384) });
/** Public signed-history DTO projection. Backend advisory fields (for example
 * ledgerCapacity) stop at this network boundary; core still verifies every record. */
export const historyPage = z.object({
  workspaceId: z.string(),
  genesisHash: hash,
  checkpoint,
  startIndex: integer,
  recordsHex: z.array(bytes(16384)).max(64),
  position: z.string().min(1).max(1024),
  nextCursor: z.string().min(1).max(4096).nullable(),
});
const join = z.object({
  workspaceId: z.string(),
  accountId: z.string(),
  genesisHash: hash,
  pairingSessionId: z.string().regex(/^[0-9a-f]{32}$/),
  signingPublicKey: hash,
  credentialHash: hash,
  requestHex: bytes(8192),
  status: z.enum(['pending', 'cancelled', 'admitting', 'admitted', 'conflict', 'published']),
});
const grant = z.object({
  token: z.string().min(1).max(16384),
  attachmentToken: hash.optional(),
  bucketId: z.string().min(1),
  gatewayBaseUrl: z.string().url(),
  expiresIn: integer.min(1).max(900),
  expiresAt: integer,
});
const slot = z.object({ genesis: hash, epoch: integer, recipient: hash });
export const mailboxStatus = slot.extend({
  revision: integer,
  status: z.enum([
    'NeedsEnvelope',
    'EnvelopeStored',
    'InstallationReported',
    'Ineligible',
    'Obsolete',
  ]),
});
const cacheBounded = <V>(map: Map<string, V>, key: string, value: V) => {
  if (map.size >= 512 && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
};
// Member invitation relay replies, checked as the desktop host checks them.
const memberRequest = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  accountId: z.string().min(1),
  keyPackageHex: bytes(4096),
  signingPublicKey: hash,
  requestId: z.string().regex(/^[0-9a-f]{32}$/),
  source: z.enum(['email', 'link']),
  state: z.enum(['pending', 'admitting', 'committed', 'rejected', 'cancelled']),
  expiresAt: integer,
  // Passed through unparsed: the public session verifies the endorsement itself, and a
  // malformed relay copy must only cost automatic admission, never explicit approval.
  offer: z.custom<E2eeMemberOffer>(() => true),
});
const failure = (reason: BackendError['reason'] = 'invalid-response') =>
  new BackendError({ service: 'PersonalCloudHost', reason });
/** Member-invitation refusals an administrator acts on; only the mapped code leaves, never
 * the server's message. */
const memberInvitationRefusals = new Set(['e2ee_member_invitation_request_pending']);
export class MemberInvitationRefusedError extends BackendError {
  constructor(readonly code: string) {
    super({ service: 'PersonalCloudHost', reason: 'unavailable' });
  }
}
/** A server's explicit `e2ee_*` refusal code, kept as the cause of the failure. Only the
 * code leaves, never the server's message. */
export class BackendRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BackendRefusal';
  }
}
/** A credential-bound endpoint's refusal of this device or membership. Only calls that send
 * this device's own credential construct it, and it is surfaced only while the account guard
 * still holds; the same code from an account-session call or an unparsed failure stays a
 * plain refusal. */
export class E2eeAccessRefusal extends BackendRefusal {
  constructor(override readonly code: 'e2ee_device_revoked' | 'e2ee_member_removed') {
    super(code);
    this.name = 'E2eeAccessRefusal';
  }
}
class SelfServiceRateLimitRefusal extends BackendRefusal {
  constructor(readonly retryAt: number) {
    super('e2ee_self_service_rate_limited');
    this.name = 'SelfServiceRateLimitRefusal';
  }
}
const selfServiceRateLimit = (cause: unknown) => {
  const retryAt = (cause as { data?: { retryAt?: unknown } } | null)?.data?.retryAt;
  return typeof retryAt === 'number' && Number.isSafeInteger(retryAt) && retryAt >= 0
    ? new SelfServiceRateLimitRefusal(retryAt)
    : null;
};
const accessLossCodes = new Set(['e2ee_device_revoked', 'e2ee_member_removed']);
/** The backend's `ConvexError` refusal code, if it is a well-formed `e2ee_*` code. */
export const refusalCode = (cause: unknown) => {
  const code = (cause as { data?: { code?: unknown } } | null)?.data?.code;
  return typeof code === 'string' && /^e2ee_[a-z0-9_-]{1,64}$/.test(code) ? code : null;
};
const invitationRefusal = (cause: unknown) => {
  const code = refusalCode(cause);
  return code && memberInvitationRefusals.has(code) ? new MemberInvitationRefusedError(code) : null;
};
/** Every other failed call stays `unavailable`, the core's retryable reason: a refusal is
 * never a decision the client must accept, and core keeps its originals and retries (a
 * mailbox put refused `e2ee_mailbox_ledger_stale` succeeds once the sender catches up).
 * The server's code rides along as the cause, so a refusal is distinguishable from an
 * outage in diagnostics without changing what core retries. */
const callFailure = (cause: unknown, bound: boolean) => {
  const code = refusalCode(cause);
  return new BackendError({
    service: 'PersonalCloudHost',
    reason: 'unavailable',
    ...(code
      ? {
          cause:
            bound && accessLossCodes.has(code)
              ? new E2eeAccessRefusal(code as E2eeAccessRefusal['code'])
              : ((code === 'e2ee_self_service_rate_limited' ? selfServiceRateLimit(cause) : null) ??
                new BackendRefusal(code)),
        }
      : {}),
  });
};
/** The access-loss refusal carried by one failure of this adapter, if any. */
export const accessRefusal = (error: unknown): E2eeAccessRefusal | null =>
  (error instanceof BackendError || error instanceof LedgerFeedError) &&
  error.cause instanceof E2eeAccessRefusal
    ? error.cause
    : null;
export type PersonalCloudConnection = {
  /** Already authenticated product client. The session owner retains and retires it. */
  readonly client: {
    query<Q extends FunctionReference<'query'>>(
      ref: Q,
      args: FunctionArgs<Q>
    ): Promise<FunctionReturnType<Q>>;
    mutation<M extends FunctionReference<'mutation'>>(
      ref: M,
      args: FunctionArgs<M>
    ): Promise<FunctionReturnType<M>>;
    action<A extends FunctionReference<'action'>>(
      ref: A,
      args: FunctionArgs<A>
    ): Promise<FunctionReturnType<A>>;
  };
  readonly currentAccount: () => Effect.Effect<string | null, unknown>;
};

/** Retry only explicit gateway failures, before mapping away transport details. */
const isTransientGatewayError = (cause: unknown): boolean => {
  if (
    refusalCode(cause) !== null ||
    cause instanceof BackendError ||
    cause instanceof BackendRefusal
  )
    return false;
  if (typeof cause !== 'object' || cause === null) return false;
  const error = cause as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof error.message === 'string' && /e2ee_[a-z0-9_-]+/.test(error.message)) return false;
  const status = error.status ?? error.statusCode;
  if (status !== undefined) return isTransientGatewayStatus(status);
  // Some transports expose an explicit HTTP status only in the error message.
  const reported =
    typeof error.message === 'string'
      ? /^(?:Server Error: |HTTP (?:error |status )?)(\d{3})\b/i.exec(error.message)
      : null;
  return reported !== null && isTransientGatewayStatus(Number(reported[1]));
};

export const gatewayRequest = (
  work: () => Promise<unknown>,
  guard: Effect.Effect<unknown, unknown>,
  backoff: readonly number[] = TRANSIENT_GATEWAY_RETRY_DELAYS_MS
): Effect.Effect<unknown, unknown> =>
  Effect.gen(function* () {
    const delays = backoff.slice(0, TRANSIENT_GATEWAY_RETRY_DELAYS_MS.length);
    for (let attempt = 0; ; attempt++) {
      yield* guard;
      const result = yield* Effect.result(
        Effect.tryPromise({ try: work, catch: (cause) => cause })
      );
      if (Result.isSuccess(result)) return result.success;
      if (!isTransientGatewayError(result.failure) || attempt >= delays.length)
        return yield* Effect.fail(result.failure);
      const delay = delays[attempt];
      yield* Effect.sleep(Number.isFinite(delay) && delay >= 0 ? delay : 0);
    }
  });

/** Concrete cloud protocol adapter. All outputs remain untrusted until the public host verifies them. */
export function makePersonalCloudNetwork(
  input: PersonalCloudConnection & {
    readonly scope: ClientCustodyScope;
    readonly replacement?: (request: PersonalExchange) => Effect.Effect<boolean, unknown>;
    /** Upper bound of one cloud call in milliseconds. Defaults to desktop's 30 s. */
    readonly requestTimeoutMs?: number;
    readonly retryBackoffMs?: readonly number[];
    readonly genesisRecordHex?: string;
  }
) {
  const { client, currentAccount } = input;
  const requestTimeout = input.requestTimeoutMs ?? 30_000;
  const scope = Object.freeze({ ...input.scope });
  const genesisHash = hex(scope.genesis.toBytes());
  const genesisInput = bytes(16384).safeParse(input.genesisRecordHex);
  const candidateGenesis = genesisInput.success ? raw(genesisInput.data) : undefined;
  const decodedGenesis =
    candidateGenesis === undefined ? undefined : decodeRecord(candidateGenesis);
  const verifiedGenesisRecord =
    candidateGenesis !== undefined &&
    decodedGenesis !== undefined &&
    Result.isSuccess(decodedGenesis) &&
    decodedGenesis.success.body.type === 'genesis' &&
    hex(hashRecordBytes(candidateGenesis).toBytes()) === genesisHash
      ? candidateGenesis
      : undefined;
  const inlineVersionReadHead = makeInlineVersionReadHead();
  const inlineMailboxPut = makeInlineMailboxPut();
  const inlineMailboxFetch = makeInlineMailboxFetch();
  const batchMailboxStatus = makeBatchMailboxStatus();
  const selfStatusCache = makeMailboxStatusCache({ ttlMs: 1000 });
  const withinRoundCache = makeMailboxStatusCache({ ttlMs: 200 });
  const selfRecipients = new Map<string, string>();
  const inlineStageGroup = makeInlineStageGroup();
  const inlineMailboxReads = new Map<string, string>();
  const inlineMailboxStatuses = new Map<string, z.infer<typeof mailboxStatus>>();
  const inlineStagedGroups = new Map<string, unknown>();
  const isUnsupportedBatchError = (error: unknown) => {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return /Could not find public function|ArgumentValidationError/.test(message);
  };
  const guard = Effect.fnUntraced(function* () {
    if ((yield* currentAccount()) !== scope.accountId) return yield* failure('unauthorized');
    return undefined;
  });
  const guarded = <A>(effect: Effect.Effect<A, BackendError>): Effect.Effect<A, BackendError> =>
    guard().pipe(
      Effect.mapError((error) => (error instanceof BackendError ? error : failure('unavailable'))),
      Effect.andThen(effect)
    );
  /** `bound`: the call sends this device's own credential, so its access-loss refusal is
   * about this device. The account guard is rechecked before such a refusal leaves. */
  const request = <A>(
    work: () => Promise<unknown>,
    schema: z.ZodType<A>,
    bound = false
  ): Effect.Effect<A, BackendError> =>
    Effect.gen(function* () {
      yield* guard();
      // A socket that never settles (backgrounded app, network switch, sleeping tab) would
      // otherwise hold the host's session work forever. As on desktop, an unanswered call
      // becomes the retryable outcome-unknown failure: callers keep their originals and
      // resend them exactly, and a timeout never proves revocation or removal.
      const value = yield* gatewayRequest(work, guard(), input.retryBackoffMs).pipe(
        Effect.mapError((cause) =>
          cause instanceof BackendError
            ? cause
            : (invitationRefusal(cause) ?? callFailure(cause, bound))
        ),
        Effect.timeoutOrElse({
          duration: requestTimeout,
          orElse: () => Effect.fail(failure('unavailable')),
        }),
        Effect.catchIf(
          (error) => accessRefusal(error) !== null,
          (error) => guard().pipe(Effect.andThen(Effect.fail(error)))
        )
      );
      yield* guard();
      return yield* Effect.try({ try: () => schema.parse(value), catch: () => failure() });
    }).pipe(
      Effect.mapError((error) => (error instanceof BackendError ? error : failure('unavailable')))
    );
  /** Every call sending this device's own credential. */
  const boundRequest = <A>(work: () => Promise<unknown>, schema: z.ZodType<A>) =>
    request(work, schema, true);
  const access = (credential: string) => ({ workspaceId: scope.workspaceId, credential });
  const history = (args: Omit<E2eeWorkspaceHistoryRequest, 'workspaceId' | 'cliToken'> = {}) =>
    request(
      () => client.action(api.e2eeWorkspaces.history, { ...args, workspaceId: scope.workspaceId }),
      historyPage,
      args.credential !== undefined
    ).pipe(
      Effect.flatMap((page) =>
        page.workspaceId === scope.workspaceId && page.genesisHash === genesisHash
          ? Effect.succeed(page)
          : Effect.fail(failure())
      )
    );
  const allHistory = Effect.fnUntraced(function* (credential?: string) {
    const pages: z.infer<typeof historyPage>[] = [];
    let cursor: string | undefined;
    let fixed: z.infer<typeof checkpoint> | undefined;
    let count = 0,
      size = 0;
    for (let i = 0; i < 256; i++) {
      const page = yield* history({
        ...(credential ? { credential } : {}),
        ...(cursor ? { cursor, checkpoint: fixed! } : {}),
      });
      fixed ??= page.checkpoint;
      if (
        page.startIndex !== count ||
        page.checkpoint.headHash !== fixed.headHash ||
        page.checkpoint.length !== fixed.length
      )
        return yield* failure();
      count += page.recordsHex.length;
      size += page.recordsHex.reduce((n, r) => n + r.length / 2, 0);
      if (count > fixed.length || size > 32 * 1024 * 1024) return yield* failure();
      pages.push(page);
      if (page.nextCursor === null) {
        if (count !== fixed.length) return yield* failure();
        return pages;
      }
      if (!page.recordsHex.length || page.nextCursor === cursor) return yield* failure();
      cursor = page.nextCursor;
    }
    return yield* failure();
  });
  const remote: PersonalHostRemote['Service'] = {
    accountId: scope.accountId,
    exchange: (source) => {
      const original = { ...source };
      return Effect.gen(function* () {
        if (
          original.accountId !== scope.accountId ||
          original.workspaceId !== scope.workspaceId ||
          original.genesisHash !== genesisHash
        )
          return yield* failure('unauthorized');
        const session = {
          workspaceId: scope.workspaceId,
          pairingSessionId: original.pairingSessionId,
        };
        if (original.action === 'cancel') {
          // Reconcile the exact server original before sending cancellation.
          const previous = yield* request(
            () => client.query(api.e2eeJoinMailbox.status, session),
            join
          );
          yield* checkJoin(previous, original);
          yield* request(
            () => client.mutation(api.e2eeJoinMailbox.cancel, session),
            z.object({ status: z.literal('cancelled') })
          );
          return { ...original, status: 'cancelled' as const };
        }
        let reply: z.infer<typeof join> & { invitationHex?: string | null };
        if (original.action === 'begin') {
          const parsed = yield* Effect.try({
            try: () => decodePersonalRequest(original.requestHex),
            catch: () => failure(),
          });
          if (
            parsed.workspaceId !== scope.workspaceId ||
            parsed.genesisHash !== genesisHash ||
            parsed.pairingSessionId !== original.pairingSessionId
          )
            return yield* failure();
          reply = yield* request(
            () =>
              client.mutation(api.e2eeJoinMailbox.begin, {
                ...session,
                genesisHash,
                signingPublicKey: parsed.signingPublicKey,
                credentialHash: parsed.credentialHash,
                requestHex: original.requestHex,
              }),
            join
          );
        } else {
          reply = yield* request(
            () => client.query(api.e2eeJoinMailbox.claim, session),
            join.extend({
              invitationHex: bytes(3 * 1024 * 1024).nullable(),
              publisher: hash.nullable(),
            })
          );
        }
        yield* checkJoin(reply, original);
        const response = {
          version: 1 as const,
          accountId: scope.accountId,
          ...session,
          genesisHash,
          requestHex: original.requestHex,
        };
        if (reply.status === 'published') {
          if (!reply.invitationHex) return yield* failure();
          const replacement = input.replacement ? yield* input.replacement(original) : false;
          return {
            ...response,
            status: 'approved' as const,
            invitationHex: reply.invitationHex,
            ...(replacement ? { history: yield* allHistory() } : {}),
          };
        }
        // An admission reservation/ledger projection without endorsed original is not approval.
        return {
          ...response,
          status: reply.status === 'admitted' ? 'admitting' : reply.status,
        } as PersonalExchangeResponse;
      });
    },
  };
  function checkJoin(reply: z.infer<typeof join>, original: PersonalExchange) {
    return reply.accountId === scope.accountId &&
      reply.workspaceId === scope.workspaceId &&
      reply.genesisHash === genesisHash &&
      reply.pairingSessionId === original.pairingSessionId &&
      reply.requestHex === original.requestHex
      ? Effect.void
      : Effect.fail(failure());
  }
  // The relay settles an AdmitMember only together with the admitted device's credential
  // hash, which binds the membership and that device's credential. The approving session
  // signs only a package it listed and pinned; its hash is kept here from the same relay
  // packages, keyed by request id and device key, and the backend rechecks it against the
  // reservation. An admission with no known hash is refused rather than left unbound.
  const memberCredentials = new Map<string, string>();
  const rememberMember = (keyPackageHex: string) => {
    try {
      const { request, credentialHash } = decodeMemberKeyPackage(keyPackageHex);
      memberCredentials.set(
        `${hex(request.requestId.toBytes())}:${hex(request.signingPublicKey.toBytes())}`,
        credentialHash
      );
    } catch {
      // A malformed package is refused by the session itself; it never gains a hash.
    }
  };
  /** A revoked device's credential no longer reads history, but the signed record that
   * revoked it must still reach this device: only after `e2ee_device_revoked` from the
   * credential-bound read, read the same history under the account session. Every record is
   * still verified against the pinned genesis by the ledger owner; the relay chooses nothing.
   * If that read fails too, the credential's refusal remains the failure. */
  const fallback = <A>(
    read: (bound: { credential?: string }) => Effect.Effect<A, BackendError>,
    credential: string
  ) =>
    read({ credential }).pipe(
      Effect.catchIf(
        (error) => accessRefusal(error)?.code === 'e2ee_device_revoked',
        (refused) => read({}).pipe(Effect.mapError(() => refused))
      )
    );
  const ledger = (
    credential: string
  ): { source: LedgerFeedSource['Service']; log: LedgerLog['Service'] } => {
    let inline: z.infer<typeof historyPage> | undefined;
    let lastRead: z.infer<typeof historyPage> | undefined;
    return {
      source: {
        readAfter: (offset) =>
          Effect.suspend(() => {
            // Only the next read may borrow this hint. LedgerFeed still verifies and
            // persists every original; a miss keeps the ordinary credential fallback.
            const page = inline;
            inline = undefined;
            const bootstrap =
              page &&
              offset === '-1' &&
              page.startIndex === 1 &&
              verifiedGenesisRecord !== undefined;
            const matched =
              page &&
              (bootstrap || offset.startsWith(`p1:${scope.workspaceId}:${page.startIndex}:`));
            return (
              matched
                ? guard().pipe(Effect.as(page))
                : fallback(
                    (bound) => history({ ...bound, ...(offset === '-1' ? {} : { after: offset }) }),
                    credential
                  )
            ).pipe(
              Effect.map((value) => {
                lastRead = value;
                return {
                  requestOffset: offset,
                  nextOffset: value.position,
                  records: bootstrap
                    ? [verifiedGenesisRecord!.slice(), ...value.recordsHex.map(raw)]
                    : value.recordsHex.map(raw),
                  upToDate: value.nextCursor === null,
                };
              })
            );
          }).pipe(
            Effect.mapError((error) => {
              const refused = accessRefusal(error);
              return new LedgerFeedError({
                code: 'native-unavailable',
                ...(refused ? { cause: refused } : {}),
              });
            })
          ),
      },
      log: {
        readFrom: (anchor, base) =>
          Effect.gen(function* () {
            yield* guard();
            if (!anchor.equals(scope.genesis)) return yield* failure();
            const previous = lastRead;
            if (
              !previous ||
              previous.startIndex + previous.recordsHex.length !== base.length ||
              previous.checkpoint.length !== base.length ||
              previous.checkpoint.headHash !== hex(base.head.toBytes())
            ) {
              const pages = yield* fallback((bound) => allHistory(bound.credential), credential);
              const records = pages.flatMap((page) => page.recordsHex.map(raw));
              if (
                !records[base.length - 1] ||
                !hashRecordBytes(records[base.length - 1]!).equals(base.head)
              )
                return yield* failure();
              return {
                records: records.slice(base.length),
                checkpoint: {
                  length: pages[0]!.checkpoint.length,
                  head: Result.getOrThrow(Bytes.recordHash(raw(pages[0]!.checkpoint.headHash))),
                },
              };
            }
            const records: Uint8Array[] = [];
            let cursor: string | undefined;
            let fixed: z.infer<typeof checkpoint> | undefined;
            let size = 0;
            for (let i = 0; i < 256; i++) {
              const hint = i === 0 && inline?.startIndex === base.length ? inline : undefined;
              const page =
                hint ??
                (yield* fallback(
                  (bound) =>
                    history({
                      ...bound,
                      ...(cursor ? { cursor, checkpoint: fixed! } : { after: previous.position }),
                    }),
                  credential
                ));
              fixed ??= page.checkpoint;
              if (
                page.workspaceId !== scope.workspaceId ||
                page.genesisHash !== genesisHash ||
                page.startIndex !== base.length + records.length ||
                page.checkpoint.length !== fixed.length ||
                page.checkpoint.headHash !== fixed.headHash
              )
                return yield* failure();
              for (const record of page.recordsHex) {
                size += record.length / 2;
                if (size > 32 * 1024 * 1024) return yield* failure();
                records.push(raw(record));
              }
              if (base.length + records.length > fixed.length) return yield* failure();
              if (page.nextCursor === null) {
                // The session's normal feed refresh consumes and verifies this page too.
                if (i === 0) inline = page;
                return {
                  records,
                  checkpoint: {
                    length: fixed.length,
                    head: Result.getOrThrow(Bytes.recordHash(raw(fixed.headHash))),
                  },
                };
              }
              cursor = page.nextCursor;
            }
            return yield* failure();
          }).pipe(Effect.mapError(() => new LedgerLogError({}))),
        read: (anchor) => {
          if (!anchor.equals(scope.genesis)) return Effect.fail(new LedgerLogError({}));
          return fallback((bound) => allHistory(bound.credential), credential).pipe(
            Effect.map((pages) => ({
              records: pages.flatMap((p) => p.recordsHex.map(raw)),
              checkpoint: {
                length: pages[0].checkpoint.length,
                head: Result.getOrThrow(Bytes.recordHash(raw(pages[0].checkpoint.headHash))),
              },
            })),
            Effect.mapError(() => new LedgerLogError({}))
          );
        },
        appendCas: (anchor, expected, body) => {
          const original = hex(body);
          return Effect.gen(function* () {
            inline = undefined;
            const record = yield* Effect.fromResult(decodeRecord(raw(original)));
            if (
              !anchor.equals(scope.genesis) ||
              record.body.type !== 'ordinary' ||
              !record.body.previousHash.equals(expected.head)
            )
              return yield* failure();
            const id = hex(hashRecordBytes(raw(original)).toBytes());
            const operation = record.body.operation;
            const credentialHash =
              operation.type === 'admitMember'
                ? memberCredentials.get(
                    `${hex(operation.request.requestId.toBytes())}:${hex(operation.request.signingPublicKey.toBytes())}`
                  )
                : undefined;
            if (operation.type === 'admitMember' && !credentialHash) return yield* failure();
            const result = yield* request(
              () =>
                client.action(api.e2eeWorkspaces.appendRecord, {
                  workspaceId: scope.workspaceId,
                  requestId: id,
                  recordHex: original,
                  ...(credentialHash ? { credentialHash } : {}),
                }),
              z.object({
                status: z.enum(['committed', 'conflict']),
                recordHash: hash,
                // A bad optional accelerator must not invalidate a durable append reply.
                historyPage: historyPage.optional().catch(undefined),
              })
            );
            const page = result.historyPage;
            if (
              result.recordHash === id &&
              page &&
              page.workspaceId === scope.workspaceId &&
              page.genesisHash === genesisHash &&
              page.recordsHex.length > 0 &&
              page.startIndex === expected.length &&
              page.startIndex + page.recordsHex.length <= page.checkpoint.length
            )
              inline = page;
            if (result.recordHash !== id || result.status !== 'committed')
              return yield* failure('conflict');
            return undefined;
          }).pipe(
            Effect.mapError((error) =>
              error instanceof BackendError && error.cause instanceof SelfServiceRateLimitRefusal
                ? new LedgerLogError({
                    reason: 'self-service-rate-limited',
                    retryAt: error.cause.retryAt,
                  })
                : new LedgerLogError({})
            )
          );
        },
      },
    };
  };
  const mailbox = (credential: string): KeyMailbox['Service'] => {
    const device = access(credential);
    const readKey = (id: string) => `${credential}\0${id}`;
    const statusKey = (target: { genesis: string; epoch: number; recipient: string }) =>
      `${credential}\0${target.genesis}\0${target.epoch}\0${target.recipient}`;
    const verifyStatus = (
      captured: { genesis: string; epoch: number; recipient: string },
      value: z.infer<typeof mailboxStatus>
    ) =>
      value.genesis === captured.genesis &&
      value.epoch === captured.epoch &&
      value.recipient === captured.recipient
        ? Effect.succeed(value)
        : Effect.fail(failure());
    return {
      put: (id, frame) => {
        const frameHex = hex(frame);
        return Effect.suspend(() => {
          selfStatusCache.invalidateAccess(device);
          withinRoundCache.invalidateAccess(device);
          return boundRequest(
            () =>
              inlineMailboxPut({ ...device, id, frameHex }, (args) =>
                client.mutation(api.e2eeMailbox.put, args)
              ),
            z.union([z.null(), z.object({ frameHex: bytes(512), slot: mailboxStatus })])
          );
        }).pipe(
          Effect.tap((receipt) =>
            Effect.sync(() => {
              if (receipt !== null) {
                cacheBounded(inlineMailboxReads, readKey(id), receipt.frameHex);
                cacheBounded(inlineMailboxStatuses, statusKey(receipt.slot), receipt.slot);
                selfStatusCache.invalidateSlot(device, receipt.slot);
                withinRoundCache.invalidateSlot(device, receipt.slot);
              } else {
                selfStatusCache.invalidateAccess(device);
                withinRoundCache.invalidateAccess(device);
              }
            })
          ),
          Effect.asVoid
        );
      },
      read: (id) =>
        Effect.suspend(() => {
          const rk = readKey(id);
          if (inlineMailboxReads.has(rk)) {
            const cached = inlineMailboxReads.get(rk)!;
            inlineMailboxReads.delete(rk);
            return guarded(Effect.succeed(raw(cached)));
          }
          return boundRequest(
            () => client.query(api.e2eeMailbox.read, { ...device, id }),
            bytes(512).nullable()
          ).pipe(Effect.map((value) => (value === null ? null : raw(value))));
        }),
      fetch: (epoch, cursor, limit) =>
        boundRequest(
          () =>
            inlineMailboxFetch({ ...device, epoch, cursor, limit }, (args) =>
              client.query(api.e2eeMailbox.fetch, args)
            ),
          z.object({
            items: z.array(z.object({ sender: hash, frameHex: bytes(512) })).max(100),
            next: z
              .string()
              .regex(/^[0-9a-f]{64}:[0-9a-f]{64}$/)
              .nullable(),
            slot: mailboxStatus.optional().catch(undefined),
          })
        ).pipe(
          Effect.tap((page) =>
            Effect.sync(() => {
              if (
                page.slot !== undefined &&
                page.slot.genesis === genesisHash &&
                page.slot.epoch === epoch
              ) {
                cacheBounded(selfRecipients, credential, page.slot.recipient);
                selfStatusCache.set(device, page.slot);
              }
            })
          ),
          Effect.map((page) => ({
            items: page.items.map((item) => ({ sender: item.sender, frame: raw(item.frameHex) })),
            next: page.next,
          }))
        ),
      status: (target) => {
        const captured = { ...target };
        if (captured.genesis !== genesisHash) return Effect.fail(failure());
        return Effect.suspend(() => {
          const key = statusKey(captured);
          if (inlineMailboxStatuses.has(key)) {
            const cached = inlineMailboxStatuses.get(key)!;
            inlineMailboxStatuses.delete(key);
            return guarded(verifyStatus(captured, cached));
          }
          const cachedStatus =
            selfStatusCache.get(device, captured) ?? withinRoundCache.get(device, captured);
          if (cachedStatus !== undefined) return guarded(verifyStatus(captured, cachedStatus));
          return Effect.tryPromise({
            try: (signal) => {
              if (signal.aborted) return Promise.reject(failure('unavailable'));
              let usedSingle = false;
              const promise = batchMailboxStatus(
                { ...device, slot: captured },
                {
                  single: async (args) => {
                    usedSingle = true;
                    const exit = await Effect.runPromiseExit(
                      boundRequest(() => client.query(api.e2eeMailbox.status, args), mailboxStatus)
                    );
                    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
                    return exit.value;
                  },
                  batch: async (args) => {
                    let rawError: unknown;
                    const exit = await Effect.runPromiseExit(
                      boundRequest(
                        () =>
                          client.query(api.e2eeMailbox.batchStatus, args).catch((error) => {
                            rawError = error;
                            throw error;
                          }),
                        z.array(mailboxStatus)
                      )
                    );
                    if (Exit.isFailure(exit)) {
                      if (rawError !== undefined && isUnsupportedBatchError(rawError))
                        throw rawError;
                      throw Cause.squash(exit.cause);
                    }
                    return exit.value;
                  },
                }
              ).then((value) => {
                if (usedSingle) {
                  if (captured.recipient === selfRecipients.get(credential)) {
                    selfStatusCache.set(device, value);
                  } else {
                    withinRoundCache.set(device, value);
                  }
                }
                return value;
              });
              return new Promise<z.infer<typeof mailboxStatus>>((resolve, reject) => {
                const onAbort = () => reject(failure('unavailable'));
                signal.addEventListener('abort', onAbort, { once: true });
                promise.then(
                  (value) => {
                    signal.removeEventListener('abort', onAbort);
                    resolve(value);
                  },
                  (error) => {
                    signal.removeEventListener('abort', onAbort);
                    reject(error);
                  }
                );
              });
            },
            catch: (error) => (error instanceof BackendError ? error : failure('unavailable')),
          }).pipe(Effect.flatMap((value) => verifyStatus(captured, value)));
        });
      },
      report: (report, publication) => {
        const reportHex = hex(report),
          publicationHex = publication === undefined ? undefined : hex(publication);
        return Effect.suspend(() => {
          selfStatusCache.invalidateAccess(device);
          withinRoundCache.invalidateAccess(device);
          return boundRequest(
            () =>
              client.mutation(api.e2eeMailbox.report, {
                ...device,
                reportHex,
                ...(publicationHex === undefined ? {} : { publicationHex }),
              }),
            z.null()
          );
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              selfStatusCache.invalidateAccess(device);
              withinRoundCache.invalidateAccess(device);
            })
          ),
          Effect.asVoid
        );
      },
      repair: (target, id, rejectedDigest) => {
        const captured = { ...target };
        if (captured.genesis !== genesisHash) return Effect.fail(failure());
        return Effect.suspend(() => {
          inlineMailboxStatuses.delete(statusKey(captured));
          selfStatusCache.invalidateSlot(device, captured);
          withinRoundCache.invalidateSlot(device, captured);
          return boundRequest(
            () =>
              client.mutation(api.e2eeMailbox.repair, {
                ...device,
                slot: captured,
                id,
                ...(rejectedDigest === undefined ? {} : { rejectedDigest }),
              }),
            z.null()
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                selfStatusCache.invalidateSlot(device, captured);
                withinRoundCache.invalidateSlot(device, captured);
              })
            ),
            Effect.asVoid
          );
        });
      },
    };
  };
  const staging = (credential: string): EpochStagingStore['Service'] => {
    const device = access(credential);
    const groupKey = (key: {
      genesis: string;
      epoch: number;
      commitment: string;
      recordHash: string;
    }) => `${credential}\0${key.genesis}\0${key.epoch}\0${key.commitment}\0${key.recordHash}`;
    const verifyGroup = (
      key: { genesis: string; epoch: number; commitment: string; recordHash: string },
      value: unknown
    ) =>
      value === null
        ? Effect.succeed(null)
        : Effect.fromResult(decodeEpochStagedGroup(value)).pipe(
            Effect.flatMap((group) =>
              group.genesis === key.genesis &&
              group.epoch === key.epoch &&
              group.commitment === key.commitment &&
              group.recordHash === key.recordHash
                ? Effect.succeed(group)
                : Effect.fail(failure())
            ),
            Effect.mapError(() => failure())
          );
    return {
      stageGroup: (source) => {
        const captured = Result.map(ownEpochStagedGroup(source), encodeEpochStagedGroup);
        return Effect.fromResult(captured).pipe(
          Effect.mapError(() => failure()),
          Effect.flatMap((group) =>
            group.genesis === genesisHash
              ? boundRequest(
                  () =>
                    inlineStageGroup({ ...device, group }, (args) =>
                      client.mutation(api.e2eeEpochStaging.stageGroup, args)
                    ),
                  z.object({ ok: z.literal(true), group: z.unknown().optional() })
                ).pipe(
                  Effect.tap((reply) =>
                    Effect.sync(() => {
                      if (reply.group !== undefined)
                        cacheBounded(inlineStagedGroups, groupKey(group), reply.group);
                    })
                  )
                )
              : Effect.fail(failure())
          ),
          Effect.asVoid
        );
      },
      readGroup: (source) => {
        const captured = ownEpochStagedGroupKey(source);
        return Effect.fromResult(captured).pipe(
          Effect.mapError(() => failure()),
          Effect.flatMap((key) =>
            key.genesis !== genesisHash
              ? Effect.fail(failure())
              : Effect.suspend(() => {
                  const gk = groupKey(key);
                  if (inlineStagedGroups.has(gk)) {
                    const cached = inlineStagedGroups.get(gk);
                    inlineStagedGroups.delete(gk);
                    return guarded(verifyGroup(key, cached));
                  }
                  return boundRequest(
                    () => client.query(api.e2eeEpochStaging.readGroup, { ...device, key }),
                    z.unknown()
                  ).pipe(Effect.flatMap((value) => verifyGroup(key, value)));
                })
          )
        );
      },
      deleteGroup: (source, occupied) => {
        const captured = ownEpochStagedGroupKey(source),
          occupiedSlot = { ...occupied };
        return Effect.fromResult(captured).pipe(
          Effect.mapError(() => failure()),
          Effect.flatMap((key) => {
            inlineStagedGroups.delete(groupKey(key));
            if (
              key.genesis !== genesisHash ||
              occupiedSlot.epoch !== key.epoch ||
              !/^[0-9a-f]{64}$/.test(occupiedSlot.commitment) ||
              occupiedSlot.commitment === key.commitment
            )
              return Effect.fail(failure());
            return boundRequest(
              () =>
                client.mutation(api.e2eeEpochStaging.deleteGroup, {
                  ...device,
                  key,
                  occupied: occupiedSlot,
                }),
              z.object({ ok: z.literal(true), done: z.boolean() })
            ).pipe(
              Effect.flatMap((reply) =>
                reply.done ? Effect.void : Effect.fail(failure('unavailable'))
              )
            );
          })
        );
      },
    };
  };
  const isAllowedGatewayUrl = (rawUrl: string): boolean => {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:') return true;
      if (parsed.protocol !== 'http:') return false;
      const host = parsed.hostname.toLowerCase();
      return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    } catch {
      return false;
    }
  };
  const contentToken = (
    credential: string,
    args: Omit<E2eeContentTokenRequest, 'workspaceId' | 'credential' | 'cliToken'>
  ) => {
    const original = {
      ...access(credential),
      ...(args.rejectedToken === undefined ? {} : { rejectedToken: args.rejectedToken }),
      ...(args.rpcOnly ? { rpcOnly: true as const } : {}),
    };
    return boundRequest(
      () => client.action(api.e2eeContent.contentStreamsToken, original),
      grant
    ).pipe(
      Effect.flatMap((value) =>
        value.bucketId !== 'lody' &&
        value.bucketId !== 'default' &&
        isAllowedGatewayUrl(value.gatewayBaseUrl)
          ? Effect.succeed(value)
          : Effect.fail(failure())
      )
    );
  };
  // Device-authenticated member relay. The credential is the session's own; a reply for
  // another workspace is refused here, and the public host verifies every package.
  const memberAccess = (access: { workspaceId: string; credential: string }) =>
    access.workspaceId === scope.workspaceId
      ? Effect.succeed({ workspaceId: scope.workspaceId, credential: access.credential })
      : Effect.fail(failure('unauthorized'));
  const sameWorkspace = <A extends { workspaceId: string }>(value: A) =>
    value.workspaceId === scope.workspaceId ? Effect.succeed(value) : Effect.fail(failure());
  const members = {
    createInvitation: (
      access: { workspaceId: string; credential: string },
      input: { offer: E2eeMemberOffer; email?: string }
    ) =>
      Effect.flatMap(memberAccess(access), (device) =>
        boundRequest(
          () =>
            client.mutation(api.e2eeMembers.createInvitation, {
              ...device,
              offer: { ...input.offer },
              ...(input.email === undefined ? {} : { email: input.email }),
            }),
          z.object({ offer: MemberOfferSchema })
        ).pipe(Effect.tap((value) => sameWorkspace(value.offer)))
      ),
    pending: (access: { workspaceId: string; credential: string }) =>
      Effect.flatMap(memberAccess(access), (device) =>
        boundRequest(
          () => client.query(api.e2eeMembers.pending, device),
          z
            .object({
              // Each invitation stands alone: one listed in an unexpected shape is left out
              // instead of failing approval, rejection and revocation of the rest.
              invitations: z.array(z.unknown()).max(100),
              unsignedInvitations: z
                .array(z.object({ token: z.string(), email: z.string().max(320) }))
                .max(100)
                .optional(),
              items: z
                .array(
                  memberRequest.extend({
                    applicantName: z.string(),
                    applicantEmail: z.string(),
                    memberLimitReached: z.boolean().optional(),
                  })
                )
                .max(100),
              hasMore: z.boolean(),
              seatPreview: SeatInvitePreviewSchema,
            })
            .transform(({ unsignedInvitations, ...value }) => ({
              ...value,
              invitations: value.invitations.flatMap((item) => {
                const parsed = MemberOfferSchema.safeParse(item);
                if (!parsed.success) return [];
                // Unsigned email invitation (created before signed offers): still revocable
                // by token; re-sending to its address issues a signed replacement. It never
                // admits automatically.
                const unsigned = unsignedInvitations?.find(
                  (entry) => entry.token === parsed.data.token
                );
                return [
                  unsigned
                    ? { ...parsed.data, needsReissue: true as const, email: unsigned.email }
                    : parsed.data,
                ];
              }),
            }))
        ).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              for (const item of value.items) rememberMember(item.keyPackageHex);
            })
          )
        )
      ),
    read: (access: { workspaceId: string; credential: string }, requestId: string) =>
      Effect.flatMap(memberAccess(access), (device) =>
        boundRequest(
          () => client.query(api.e2eeMembers.read, { ...device, requestId }),
          memberRequest
        ).pipe(
          Effect.flatMap(sameWorkspace),
          Effect.tap((value) => Effect.sync(() => rememberMember(value.keyPackageHex)))
        )
      ),
    reject: (access: { workspaceId: string; credential: string }, requestId: string) =>
      Effect.flatMap(memberAccess(access), (device) =>
        boundRequest(
          () => client.mutation(api.e2eeMembers.reject, { ...device, requestId }),
          z.object({ state: z.literal('rejected') })
        )
      ),
    revoke: (access: { workspaceId: string; credential: string }, token: string) =>
      Effect.flatMap(memberAccess(access), (device) =>
        boundRequest(
          () => client.mutation(api.e2eeMembers.revoke, { ...device, token }),
          z.object({ revoked: z.literal(true) })
        )
      ),
    /** Joining side, under the account login: this device has no admitted credential yet.
     * Replies are untrusted until the host compares them with its retained original. */
    submit: (input: { token: string; keyPackageHex: string }) =>
      request(
        () =>
          client.mutation(api.e2eeMembers.submit, {
            token: input.token,
            keyPackageHex: input.keyPackageHex,
          }),
        memberRequest
      ).pipe(Effect.flatMap(sameWorkspace)),
    claim: (input: { workspaceId: string; requestId: string }) =>
      input.workspaceId === scope.workspaceId
        ? request(
            () =>
              client.query(api.e2eeMembers.claim, {
                workspaceId: input.workspaceId,
                requestId: input.requestId,
              }),
            memberRequest
          ).pipe(Effect.flatMap(sameWorkspace))
        : Effect.fail(failure('unauthorized')),
    /** Joining side, under the account login: retire this account's ended request before
     * joining from another invitation. Only `cancelled` lets the host settle the old one. */
    retire: (input: { token: string; keyPackageHex: string }) =>
      request(
        () =>
          client.mutation(api.e2eeMembers.retire, {
            token: input.token,
            keyPackageHex: input.keyPackageHex,
          }),
        z.object({
          state: z.enum(['pending', 'admitting', 'committed', 'rejected', 'cancelled']),
        })
      ),
  };
  /** Device-authenticated machine-sharing policy transport for this workspace only. The
   * host supplies its own credential in each request and verifies every reply with core;
   * an exact copy of the request goes out, and a reply for another workspace is refused. */
  const sharingRequest = <I extends { workspaceId: string }, A>(
    input: I,
    send: (original: I) => Promise<unknown>,
    schema: z.ZodType<A>
  ) =>
    input.workspaceId === scope.workspaceId
      ? boundRequest(() => send({ ...input }), schema)
      : Effect.fail(failure());
  const machineSharing: SharingRemote = {
    readHead: (input) =>
      sharingRequest(
        input,
        (original) =>
          inlineVersionReadHead(original, (args) =>
            client.action(api.e2eeMachineSharing.readHead, args)
          ),
        sharingReplySchemas.readHead
      ),
    readVersion: (input) =>
      sharingRequest(
        input,
        (original) => client.action(api.e2eeMachineSharing.readVersion, original),
        sharingReplySchemas.readVersion
      ),
    readRequest: (input) =>
      sharingRequest(
        input,
        (original) => client.action(api.e2eeMachineSharing.readRequest, original),
        sharingReplySchemas.readRequest
      ),
    commit: (input) =>
      sharingRequest(
        input,
        (original) => client.action(api.e2eeMachineSharing.commit, original),
        sharingReplySchemas.commit
      ),
  };
  return Object.freeze({
    remote: { ...remote, history: (credential: Uint8Array) => allHistory(hex(credential)) },
    ledger,
    mailbox,
    staging,
    contentToken,
    allHistory,
    members,
    machineSharing,
  });
}
