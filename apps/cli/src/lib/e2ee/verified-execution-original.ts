import {
  getSessionRoomId,
  normalizeSessionTurnInputConfig,
  queuedInputEvidence,
  type SessionId,
} from '@lody/shared';
import { isDeepStrictEqual } from 'node:util';
import { Effect, type Scope } from 'effect';
import type { LoroDoc, OpId } from 'loro-crdt';
import type { PayloadProtectionOpenInput } from '@loro-dev/streams-crdt';
import type { EncryptedExecutionIntent } from './agent-execution';
import type { ExecutionOrigins } from './execution-origins';

type OpenContent = Parameters<ExecutionOrigins['resolve']>[2];
type RecoverOrigin = (
  docId: string,
  id: OpId,
  open: OpenContent
) => Effect.Effect<void, unknown, Scope.Scope>;
type LedgerState = {
  readonly devices: ReadonlyMap<
    string,
    { readonly machineId?: string; readonly membershipId: { toBytes(): Uint8Array } }
  >;
  readonly members: ReadonlyMap<string, { readonly userId: { toBytes(): Uint8Array } }>;
};
type OpenedDispatch = {
  readonly args: { sessionId: string; userTurnId: string; userId: string; inputConfig?: unknown };
  readonly requesterDevice: string;
  readonly expiresAt: number;
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const isContentUnauthorized = (cause: unknown) =>
  cause instanceof Error &&
  'code' in cause &&
  (cause as { _tag?: unknown })._tag === 'ContentError' &&
  cause.code === 'unauthorized';

/** The workspace host's one resolver of who authored the input a start names. */
export function makeVerifiedExecutionOriginal(options: {
  workspaceId: string;
  /** This machine's signing key: the only author of derived inputs. */
  selfDevice: string;
  isClosed: () => boolean;
  origins: ExecutionOrigins;
  readIncoming: (
    intent: EncryptedExecutionIntent
  ) => Effect.Effect<{ frame: Uint8Array } | null | undefined, unknown>;
  openDispatch: (machineId: string, frameHex: string) => Effect.Effect<OpenedDispatch, unknown>;
  ledger: () => Effect.Effect<{ inspectState(): LedgerState }, unknown>;
  openContent: (
    intent: EncryptedExecutionIntent,
    request: PayloadProtectionOpenInput
  ) => ReturnType<OpenContent>;
  recover?: RecoverOrigin;
}) {
  return (
    intent: EncryptedExecutionIntent,
    doc?: LoroDoc,
    lookup: { readonly origin?: boolean } = {}
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (options.isClosed() || intent.workspaceId !== options.workspaceId) return undefined;
        // Origin lookups and this machine's own inputs always use the signed row,
        // whose `derivedFrom` the dispatch fast path cannot carry.
        const fromDoc = lookup.origin
          ? undefined
          : doc?.getMap('rpcDispatchOriginals').get(intent.userTurnId);
        // This original cache is an accelerator, never the actual-start journal.
        // Its local I/O fault cannot block the independently signed durable origin.
        const cached = yield* options
          .readIncoming(intent)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        const rpcOriginal =
          typeof fromDoc === 'string' ? fromDoc : cached ? hex(cached.frame) : undefined;
        if (rpcOriginal !== undefined) {
          if (cached && hex(cached.frame) !== rpcOriginal) return undefined;
          const view = yield* options.ledger();
          const state = view.inspectState();
          const machineId = state.devices.get(options.selfDevice)?.machineId;
          if (!machineId) return undefined;
          const verified = yield* options.openDispatch(machineId, rpcOriginal);
          if (
            verified.args.sessionId !== intent.sessionId ||
            verified.args.userTurnId !== intent.userTurnId ||
            !isDeepStrictEqual(verified.args.inputConfig ?? {}, intent.inputConfig ?? {})
          )
            return undefined;
          // A self-authored input may be derived; only its signed row says so.
          if (verified.requesterDevice !== options.selfDevice) {
            const device = state.devices.get(verified.requesterDevice);
            const member = device && state.members.get(hex(device.membershipId.toBytes()));
            if (!member) return undefined;
            return {
              requesterDevice: verified.requesterDevice,
              requesterCryptoUserId: hex(member.userId.toBytes()),
              expiresAt: verified.expiresAt,
            };
          }
        }
        if (!doc) return undefined;
        const resolved = yield* options.origins.resolve(
          intent,
          doc,
          (request) => options.openContent(intent, request),
          options.recover,
          lookup
        );
        if (
          !resolved ||
          'state' in resolved ||
          !resolved.queued ||
          resolved.requesterDevice !== options.selfDevice
        )
          return resolved;
        // This machine signs every promoted row, so its signature proves the row's
        // content, not who queued it. A client's own marked row stops at the return above.
        const row = resolved.queued;
        const queuedOriginal = doc.getMap('queueDispatchOriginals').get(intent.userTurnId);
        const automation = normalizeSessionTurnInputConfig(row.inputConfig)?._lodyAutomation;
        if (automation === undefined && typeof queuedOriginal === 'string') {
          const state = (yield* options.ledger()).inspectState();
          const machineId = state.devices.get(options.selfDevice)?.machineId;
          if (!machineId) return undefined;
          // Opening a request checks its signer against the current ledger.
          const verified = yield* options
            .openDispatch(machineId, queuedOriginal)
            .pipe(
              Effect.catch((cause: unknown) =>
                isContentUnauthorized(cause) ? Effect.succeed(undefined) : Effect.fail(cause)
              )
            );
          if (!verified) return undefined;
          const evidence = queuedInputEvidence(row.inputConfig);
          const device = state.devices.get(verified.requesterDevice);
          const member = device && state.members.get(hex(device.membershipId.toBytes()));
          if (
            !evidence ||
            !member ||
            verified.requesterDevice === options.selfDevice ||
            verified.args.sessionId !== intent.sessionId ||
            verified.args.userTurnId !== intent.userTurnId ||
            verified.args.userId !== row.userId ||
            queuedInputEvidence(verified.args.inputConfig) !== evidence
          )
            return undefined;
          return {
            requesterDevice: verified.requesterDevice,
            requesterCryptoUserId: hex(member.userId.toBytes()),
            expiresAt: verified.expiresAt,
          };
        }
        const receipted = yield* Effect.try({
          try: () =>
            options.origins.hasQueuedInput({
              sessionId: intent.sessionId,
              userTurnId: intent.userTurnId,
              timestamp: row.timestamp,
              userId: row.userId,
              inputConfig: row.inputConfig,
            }),
          catch: (cause) => cause,
        }).pipe(Effect.catch(() => Effect.succeed(false)));
        return receipted ? resolved : undefined;
      })
    );
}

export const sessionContentResource = (sessionId: string) =>
  `doc:${getSessionRoomId(sessionId as SessionId)}`;
