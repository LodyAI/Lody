import type { ScheduleAuthorizationRequest } from '@lody/shared';
import { existsSync } from 'node:fs';
import { Clock, Effect } from 'effect';
import { z } from 'zod';
import {
  RealtimeJournal,
  RealtimeJournalError,
  type RealtimeStartPermit,
} from './realtime-journal';

const attempt = <A>(body: () => A) => Effect.try({ try: body, catch: (cause) => cause });

const retainedIntentSchema = z.union([
  z.tuple([z.literal(1), z.string(), z.string()]),
  z.tuple([z.literal(1), z.string(), z.string(), z.string()]),
]);

const intentSchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  userTurnId: z.string().min(1),
  /** Display metadata only; execution identity comes from the verified signer. */
  requesterUserId: z.string().optional(),
  inputConfig: z.unknown().optional(),
  /** Every local project this machine resolved for the turn; empty means projectless. */
  localProjectIds: z.array(z.string().min(1)).optional(),
});
export type EncryptedExecutionIntent = z.infer<typeof intentSchema>;
/** The shape is structurally compatible with the workspace host freshness gate. */
export type ExecutionAuthorization =
  | {
      readonly _tag: 'Authorized';
      readonly isCurrent?: () => boolean;
      readonly principal?: 'owner' | 'member';
    }
  | { readonly _tag: 'Denied'; readonly reason: string };
export type AuthorizeEncryptedExecution = (
  workspaceId: string,
  requesterDevice: string,
  localProjectId?: string
) => Effect.Effect<ExecutionAuthorization, unknown>;
export type VerifiedExecutionOriginal = {
  requesterDevice: string;
  /** Historical ledger actor, never the UI account ID. */
  requesterCryptoUserId: string;
  expiresAt: number;
  schedule?: ScheduleAuthorizationRequest;
};
export type PendingExecutionOriginal = { state: 'pending-evidence'; expiresAt: number };
export type ResolveVerifiedExecutionOriginal = (
  intent: EncryptedExecutionIntent
) => Effect.Effect<VerifiedExecutionOriginal | PendingExecutionOriginal | undefined, unknown>;

export type EncryptedExecutionClaim =
  | {
      state: 'claimed';
      permit: RealtimeStartPermit;
      /** `owner` only when the verified signer belongs to this machine owner's
       * membership; anything else, including an unstated principal, is `member`. */
      principal: 'owner' | 'member';
    }
  | { state: 'denied'; reason?: 'e2ee_machine_not_shared' }
  | { state: 'uncertain' | 'completed' | 'expired' | 'pending-evidence' };

/** One owner per encrypted workspace. Journal opening stays lazy so a broken
 * execution log never prevents content sync or another workspace from starting. */
export function makeEncryptedAgentExecution(options: {
  genesis: string;
  workspaceId: string;
  targetMachineId: string;
  journal: () => RealtimeJournal;
  authorizeExecution?: AuthorizeEncryptedExecution;
  authorizeSchedule?: (
    request: ScheduleAuthorizationRequest,
    localProjectId?: string
  ) => Effect.Effect<ExecutionAuthorization, unknown>;
  isExecutionOpen?: () => boolean;
  resolveVerifiedOriginal: ResolveVerifiedExecutionOriginal;
  /** Observation only, after the committed actual-start claim. */
  onClaim?: (userTurnId: string) => void;
}) {
  const claim = Effect.fnUntraced(function* (
    input: EncryptedExecutionIntent
  ): Effect.fn.Return<EncryptedExecutionClaim, unknown> {
    const intent = yield* attempt(() => intentSchema.parse(input));
    if (intent.workspaceId !== options.workspaceId)
      return yield* Effect.fail(new RealtimeJournalError('identity_conflict'));
    const key = {
      genesis: options.genesis,
      workspaceId: intent.workspaceId,
      targetMachineId: options.targetMachineId,
      requestId: `agent-start:${intent.userTurnId}`,
    };
    // Stable business evidence, separate from each transport's original frame.
    // No prompt, plaintext response, or transport request id belongs here.
    const frame = Buffer.from(JSON.stringify([1, intent.sessionId, intent.userTurnId]));
    const journal = yield* attempt(options.journal);
    const read = () => {
      const retained = journal.read(key);
      if (retained) {
        // Earlier intent evidence included a display account ID. Match only the
        // business identity, preserving those exact bytes and every start fence.
        const saved = retainedIntentSchema.parse(
          JSON.parse(Buffer.from(retained.frame).toString('utf8'))
        );
        if (saved[1] !== intent.sessionId || saved[2] !== intent.userTurnId)
          throw new RealtimeJournalError('identity_conflict');
      }
      return retained;
    };
    let retained = yield* attempt(read);
    if (retained && retained.state !== 'received') return { state: retained.state };
    if (options.isExecutionOpen?.() === false) return { state: 'denied' };
    const verified = yield* options.resolveVerifiedOriginal(intent);
    if (verified && 'state' in verified) {
      // Snapshot timestamps can bound waiting, but never grant execution. A
      // recovered signed original still defines the actual admission deadline.
      return {
        state:
          (yield* Clock.currentTimeMillis) >= verified.expiresAt ? 'expired' : 'pending-evidence',
      };
    }
    if (
      !verified ||
      !/^[0-9a-f]{64}$/.test(verified.requesterDevice) ||
      !Number.isSafeInteger(verified.expiresAt) ||
      verified.expiresAt < 0
    )
      return { state: 'denied' };
    const authorizeExecution = options.authorizeExecution;
    if (!authorizeExecution) return { state: 'denied' };
    const targets: readonly (string | undefined)[] = intent.localProjectIds?.length
      ? [...new Set(intent.localProjectIds)]
      : [undefined];
    // Each touched project needs its own switch; every grant's fence must still hold.
    const authorizeTargets = Effect.fnUntraced(function* (
      authorize: AuthorizeEncryptedExecution
    ): Effect.fn.Return<ExecutionAuthorization, unknown> {
      const fences: (() => boolean)[] = [];
      // Owner identity survives only if every grant names the owner principal.
      let owner = true;
      for (const target of targets) {
        const result = yield* authorize(intent.workspaceId, verified.requesterDevice, target);
        if (result._tag !== 'Authorized') return result;
        if (result.isCurrent) fences.push(result.isCurrent);
        if (result.principal !== 'owner') owner = false;
      }
      return {
        _tag: 'Authorized',
        ...(fences.length ? { isCurrent: () => fences.every((current) => current()) } : {}),
        ...(owner ? { principal: 'owner' as const } : {}),
      };
    });
    let authorization = yield* authorizeTargets(authorizeExecution);
    if (authorization._tag !== 'Authorized')
      return authorization.reason === 'e2ee_machine_not_shared'
        ? { state: 'denied', reason: 'e2ee_machine_not_shared' }
        : { state: 'denied' };
    let scheduleCurrent: (() => boolean) | undefined;
    if (verified.schedule) {
      if (!options.authorizeSchedule) return { state: 'denied' };
      const authorizeSchedule = options.authorizeSchedule;
      const scheduleRequest = verified.schedule;
      const schedule = yield* authorizeTargets((_workspaceId, _device, target) =>
        authorizeSchedule(scheduleRequest, target)
      );
      if (schedule._tag !== 'Authorized')
        return {
          state:
            schedule.reason === 'e2ee_schedule_evidence_pending'
              ? (yield* Clock.currentTimeMillis) < verified.expiresAt
                ? 'pending-evidence'
                : 'expired'
              : 'denied',
          ...(schedule.reason === 'e2ee_machine_not_shared'
            ? { reason: 'e2ee_machine_not_shared' as const }
            : {}),
        };
      scheduleCurrent = schedule.isCurrent;
      // Schedule signer refreshes may advance the ledger snapshot. Recheck the
      // turn signer without dropping the independent Schedule source fences.
      authorization = yield* authorizeTargets(authorizeExecution);
      if (authorization._tag !== 'Authorized')
        return {
          state: 'denied',
          ...(authorization.reason === 'e2ee_machine_not_shared'
            ? { reason: 'e2ee_machine_not_shared' as const }
            : {}),
        };
    }
    // Authorization can yield. Re-read before receive so concurrent channels
    // reuse the first expiry instead of replacing or extending its evidence.
    retained = yield* attempt(read);
    if (retained && verified.expiresAt < retained.expiresAt) return { state: 'denied' };
    if (retained && retained.requester !== verified.requesterDevice)
      return yield* Effect.fail(new RealtimeJournalError('identity_conflict'));
    const request = retained ?? {
      ...key,
      requester: verified.requesterDevice,
      expiresAt: verified.expiresAt,
      frame,
    };
    const executionCurrent = authorization.isCurrent;
    const principal =
      authorization.principal === 'owner' ? ('owner' as const) : ('member' as const);
    return yield* attempt(() => {
      // No await between the terminal lifecycle fence and the durable start.
      if (
        options.isExecutionOpen?.() === false ||
        executionCurrent?.() === false ||
        scheduleCurrent?.() === false
      )
        return { state: 'denied' as const };
      journal.receive(request);
      const result = journal.claim(request);
      if (result.state === 'claimed') {
        try {
          options.onClaim?.(intent.userTurnId);
        } catch {
          /* Diagnostics never change execution. */
        }
      }
      return result.state === 'existing'
        ? {
            state:
              result.record.state === 'completed' ? ('completed' as const) : ('uncertain' as const),
          }
        : { ...result, principal };
    });
  });
  const complete = (permit: RealtimeStartPermit) =>
    attempt(() => {
      options.journal().finish(permit, Buffer.from('{"state":"settled"}'));
    });
  return { claim, complete };
}
export type EncryptedAgentExecution = ReturnType<typeof makeEncryptedAgentExecution>;

/** Provision only when neither the main file nor retained control evidence
 * exists. A missing main file after use is a fault, never a fresh empty log. */
export function lazyExecutionJournal(filename: string, now: () => number): () => RealtimeJournal {
  let journal: RealtimeJournal | undefined;
  return () => {
    if (journal) return journal;
    if (existsSync(filename) || existsSync(`${filename}.control.sqlite`))
      return (journal = new RealtimeJournal(filename, now));
    try {
      return (journal = RealtimeJournal.create(filename, now));
    } catch (cause) {
      if (
        cause instanceof RealtimeJournalError &&
        cause.cause instanceof Error &&
        'code' in cause.cause &&
        cause.cause.code === 'EEXIST'
      )
        return (journal = new RealtimeJournal(filename, now));
      throw cause;
    }
  };
}
