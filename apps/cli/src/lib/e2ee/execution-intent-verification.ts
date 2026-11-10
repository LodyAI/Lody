import {
  decodeE2eeIntentRecord,
  E2EE_INTENT_KIND,
  ScheduleAuthorizationRequestSchema,
  turnExecutionDigest,
} from '@lody/shared';
import { Effect, Result } from 'effect';
import { isContainer, type LoroDoc, type LoroMap } from 'loro-crdt';
import { z } from 'zod';
import { verifyExecutionIntent, type Bytes } from '@lody/e2ee-core/protocol';
import type {
  EncryptedExecutionIntent,
  PendingExecutionOriginal,
  RefusedExecutionOriginal,
  VerifiedExecutionOriginal,
} from './agent-execution';

type LedgerState = {
  readonly devices: ReadonlyMap<
    string,
    {
      readonly machineId?: string;
      readonly kind?: string;
      readonly membershipId: { toBytes(): Uint8Array };
    }
  >;
  readonly members: ReadonlyMap<string, { readonly userId: { toBytes(): Uint8Array } }>;
};
type OpenedDispatch = {
  readonly args: { sessionId: string; userTurnId: string };
  readonly e2eeIntent: string;
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const refused = (reason: RefusedExecutionOriginal['reason']): RefusedExecutionOriginal => ({
  state: 'refused',
  reason,
});
const derivedFromSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(256),
    userTurnId: z.string().trim().min(1).max(256),
  })
  .strict();

/** The newest user row with this ID, as plain JSON; never another role's row. */
function findUserTurn(doc: LoroDoc, userTurnId: string) {
  const list = doc.getList('history');
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const value: unknown = list.get(index);
    if (!isContainer(value) || value.kind() !== 'Map') continue;
    const map = value as LoroMap;
    if (map.get('id') === userTurnId && map.get('role') === 'user')
      return map.toJSON() as Record<string, unknown>;
  }
  return undefined;
}

/**
 * The workspace host's one resolver of who signed the input a start names (owner
 * decision 2026-11-10). The signed intent sits in the turn row beside its content, so a
 * snapshot, a trimmed stream or a late delivery cannot lose it, and no original frame
 * is needed. The verifier recomputes the digest from the content that will run, checks
 * the signature for this workspace, machine, session and message, and then checks the
 * signer against the current ledger. It never decides by time.
 */
export function makeVerifiedExecutionIntent(options: {
  workspaceId: string;
  genesis: Bytes.GenesisHash;
  /** This machine's signing key. Only it may author a derived input. */
  selfDevice: string;
  isClosed: () => boolean;
  /** The realtime path's received request, before its row reaches the document. */
  readIncoming: (
    intent: EncryptedExecutionIntent
  ) => Effect.Effect<{ frame: Uint8Array } | null | undefined, unknown>;
  openDispatch: (machineId: string, frameHex: string) => Effect.Effect<OpenedDispatch, unknown>;
  ledger: () => Effect.Effect<{ inspectState(): LedgerState }, unknown>;
  /** One authenticated latest read; fails when the backend cannot answer. */
  refreshLedger: Effect.Effect<void, unknown>;
}) {
  return (
    intent: EncryptedExecutionIntent,
    doc?: LoroDoc,
    lookup: { readonly origin?: boolean } = {}
  ): Effect.Effect<
    VerifiedExecutionOriginal | PendingExecutionOriginal | RefusedExecutionOriginal | undefined,
    unknown
  > =>
    Effect.gen(function* () {
      if (options.isClosed() || intent.workspaceId !== options.workspaceId) return undefined;
      let state = (yield* options.ledger()).inspectState();
      const machineId = state.devices.get(options.selfDevice)?.machineId;
      if (!machineId) return refused('e2ee_machine_not_member');
      const row = doc ? findUserTurn(doc, intent.userTurnId) : undefined;
      let record: unknown;
      let content: { inputConfig: unknown; derivedFrom?: unknown; scheduleRun?: unknown };
      if (row) {
        record = row.e2eeIntent;
        // A start runs the caller's input, which must be exactly what was signed. An
        // origin lookup names no input and reads the signed row's own.
        content = {
          inputConfig: lookup.origin ? row.inputConfig : intent.inputConfig,
          derivedFrom: row.derivedFrom,
          scheduleRun: row.scheduleRun,
        };
      } else if (!lookup.origin) {
        // Only an accelerator: a local I/O fault waits for the durable row instead.
        const cached = yield* options
          .readIncoming(intent)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (!cached) return undefined;
        const opened = yield* options.openDispatch(machineId, hex(cached.frame));
        if (
          opened.args.sessionId !== intent.sessionId ||
          opened.args.userTurnId !== intent.userTurnId
        )
          return refused('e2ee_scope_mismatch');
        record = opened.e2eeIntent;
        content = { inputConfig: intent.inputConfig };
      } else return undefined;
      if (record === undefined) return refused('e2ee_signature_missing');
      const decoded = decodeE2eeIntentRecord(record);
      if (!decoded || decoded.kind === E2EE_INTENT_KIND.scheduleDeclaration)
        return refused('e2ee_signature_invalid');
      const digest = turnExecutionDigest(content);
      if (!digest) return refused('e2ee_signature_invalid');
      if (
        Result.isFailure(
          verifyExecutionIntent(
            {
              kind: decoded.kind,
              genesis: options.genesis,
              workspaceId: options.workspaceId,
              targetMachineId: machineId,
              scope: intent.sessionId,
              messageId: intent.userTurnId,
              contentDigest: Buffer.from(digest, 'hex'),
            },
            decoded.signer,
            decoded.signature
          )
        )
      )
        return refused('e2ee_signature_invalid');
      const signer = hex(decoded.signer);
      const member = (current: LedgerState) => {
        const device = current.devices.get(signer);
        if (!device || device.kind === 'recovery') return undefined;
        return current.members.get(hex(device.membershipId.toBytes()));
      };
      let found = member(state);
      if (!found) {
        // A new device may postdate this machine's last read. Decide only after an
        // authenticated latest read; without one the input keeps waiting.
        if (Result.isFailure(yield* Effect.result(options.refreshLedger)))
          return { state: 'pending-evidence' };
        state = (yield* options.ledger()).inspectState();
        found = member(state);
        if (!found) return refused('e2ee_sender_not_authorized');
      }
      const derivedFrom =
        row?.derivedFrom === undefined ? undefined : derivedFromSchema.safeParse(row.derivedFrom);
      if (derivedFrom && (!derivedFrom.success || signer !== options.selfDevice))
        return refused('e2ee_signature_invalid');
      const schedule =
        row?.scheduleRun === undefined
          ? undefined
          : ScheduleAuthorizationRequestSchema.extend({
              turnId: z.literal(intent.userTurnId),
            }).safeParse(row.scheduleRun);
      if (schedule && !schedule.success) return refused('e2ee_signature_invalid');
      return {
        requesterDevice: signer,
        requesterCryptoUserId: hex(found.userId.toBytes()),
        ...(schedule?.success ? { schedule: schedule.data } : {}),
        ...(derivedFrom?.success ? { derivedFrom: derivedFrom.data } : {}),
      };
    });
}
