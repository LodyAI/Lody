import { Cause, Effect, Exit } from 'effect';
import { z } from 'zod';
import {
  api,
  type E2eeAppendRecordRequest,
  type E2eeWorkspaceHistoryPage,
  type E2eeWorkspaceBatchReply,
  type E2eeAppendRecordReply,
  type E2eeWorkspaceHistoryRequest,
} from '@lody/cloud-api';
import type { AccountPairingRelay, AccountPairingStore } from '@lody/e2ee-client/account-pairing';
import { makeIndexedDbAccountPairingStore } from '@lody/e2ee-client/account-pairing/browser';
import {
  gatewayRequest,
  historyPage,
  mailboxStatus,
  refusalCode,
  type PersonalCloudConnection,
} from './network';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const bytes = z.string().regex(/^(?:[0-9a-f]{2})+$/);
const workspace = z.object({
  workspaceId: z.string().min(1),
  genesisHash: hash,
  checkpoint: z
    .object({ headHash: hash, length: z.number().int().positive() })
    .nullable()
    .optional()
    .catch(undefined),
});
const summary = z.object({
  requestId: z.string().min(1),
  status: z.enum(['pending', 'approved', 'declined', 'expired']),
  deviceName: z.string(),
  approximateLocation: z.string().nullable(),
  requestedAt: z.number(),
  expiresAt: z.number(),
});
const record = z.object({
  requestId: z.string().min(1),
  status: z.enum(['pending', 'approved', 'declined', 'expired']),
  deviceName: z.string(),
  approximateLocation: z.string().nullable(),
  requestedAt: z.number(),
  expiresAt: z.number(),
  lookupId: z.string().min(1),
  requestHex: bytes,
  requestTagHex: bytes,
  workspaces: z.array(workspace),
});
// The service never returns the approver's device credential to the new device.
const invitation = z.object({
  workspaceId: z.string().min(1),
  genesisHash: hash,
  invitationHex: bytes,
  admissionRecordHex: bytes.max(16384).optional().catch(undefined),
  mailboxPreview: z
    .object({
      epoch: z.number().int().nonnegative(),
      items: z.array(z.object({ sender: hash, frameHex: bytes.max(1024) })).max(100),
      next: z.null(),
      slot: mailboxStatus,
    })
    .optional()
    .catch(undefined),
});
const approval = z.object({
  approvalHex: bytes,
  approvalTagHex: bytes,
  invitations: z.array(invitation),
  publishedAt: z.number(),
});
const claim = z
  .object({
    status: z.enum(['pending', 'approved', 'declined', 'expired']),
    approvals: z.array(approval),
  })
  .nullable();

const fail = () => new Error('e2ee_pairing_relay_failed');
/** Service refusals the pairing UI explains (`@lody/platform` `E2eeAccountPairingErrorCode`),
 * as on desktop; every other failure stays the generic retryable relay failure. */
const REFUSALS: Readonly<Record<string, string>> = {
  e2ee_account_pairing_disabled: 'pairing-unavailable',
  e2ee_account_pairing_rate_limited: 'pairing-rate-limited',
};
const refusal = (cause: unknown) => {
  const server = refusalCode(cause);
  const code = server ? REFUSALS[server] : undefined;
  return code ? Object.assign(new Error(`e2ee_${code}`), { code }) : fail();
};

/** Authenticated relay only. Every returned field is advisory until the shared
 * account-pairing workflow verifies the canonical bytes and tags. */
export function makePersonalCloudAccountPairingRelay(
  input: PersonalCloudConnection & {
    /** Upper bound of one relay call in milliseconds. Defaults to 30 s. */
    readonly requestTimeoutMs?: number;
    readonly retryBackoffMs?: readonly number[];
  }
): AccountPairingRelay {
  const request = <A>(work: () => Promise<unknown>, schema: z.ZodType<A>) =>
    Effect.gen(function* () {
      const account = yield* input.currentAccount();
      if (!account) return yield* Effect.fail(fail());
      const guard = Effect.gen(function* () {
        if ((yield* input.currentAccount()) !== account) return yield* Effect.fail(fail());
      });
      // An unanswered socket fails as the same retryable relay failure, never a hang.
      const value = yield* gatewayRequest(work, guard, input.retryBackoffMs).pipe(
        Effect.mapError(refusal),
        Effect.timeoutOrElse({
          duration: input.requestTimeoutMs ?? 30_000,
          orElse: () => Effect.fail(fail()),
        })
      );
      yield* guard;
      return yield* Effect.try({
        try: () => schema.parse(value),
        catch: fail,
      });
    });
  return {
    submit: (value) =>
      request(() => input.client.mutation(api.e2eeAccountPairing.submit, { ...value }), summary),
    read: (lookupId) =>
      request(
        () => input.client.query(api.e2eeAccountPairing.read, { lookupId }),
        record.nullable()
      ),
    decline: (requestId) =>
      request(
        () => input.client.mutation(api.e2eeAccountPairing.decline, { requestId }),
        z.object({ status: z.literal('declined') })
      ),
    publish: (value) =>
      request(
        () => input.client.mutation(api.e2eeAccountPairing.publish, { ...value }),
        z.object({
          status: z.literal('published'),
          deliveredWorkspaces: z.array(z.string().min(1)).max(64).optional().catch(undefined),
        })
      ),
    claim: (lookupId) =>
      request(() => input.client.query(api.e2eeAccountPairing.claim, { lookupId }), claim),
  };
}

/**
 * Every cloud port of account pairing over one transport: the relay, the account-login
 * ledger append, and the requester's workspace list and history. Each call needs a
 * signed-in account before and after it and is bounded (default 30 s), so no host can hand
 * the workflow an unanswered promise. `personalEntry` bounds them again on its own clock.
 */
export function makePersonalCloudAccountPairingPorts(
  input: PersonalCloudConnection & {
    /** Upper bound of one call in milliseconds. Defaults to 30 s. */
    readonly requestTimeoutMs?: number;
    readonly retryBackoffMs?: readonly number[];
    /** Runs each bounded call; owning tests pass a TestClock runtime. */
    readonly runExit?: <A, E>(effect: Effect.Effect<A, E>) => Promise<Exit.Exit<A, E>>;
  }
) {
  const runExit = input.runExit ?? Effect.runPromiseExit;
  const call = async <A>(work: () => Promise<A>): Promise<A> => {
    const exit = await runExit(
      Effect.gen(function* () {
        if (!(yield* input.currentAccount())) return yield* Effect.fail(fail());
        const value = yield* Effect.tryPromise({ try: work, catch: (cause) => cause }).pipe(
          Effect.timeoutOrElse({
            duration: input.requestTimeoutMs ?? 30_000,
            orElse: () => Effect.fail(fail()),
          })
        );
        if (!(yield* input.currentAccount())) return yield* Effect.fail(fail());
        return value;
      })
    );
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  };
  const parseBatch = <A>(schema: z.ZodType<A>, value: unknown): E2eeWorkspaceBatchReply<A> =>
    z
      .object({
        items: z
          .array(
            z.discriminatedUnion('status', [
              z.object({ workspaceId: z.string().min(1), status: z.literal('ok'), result: schema }),
              z.object({
                workspaceId: z.string().min(1),
                status: z.literal('error'),
                code: z.string().min(1),
              }),
            ])
          )
          .min(1)
          .max(64),
      })
      .parse(value);
  const historyBatch = (items: E2eeWorkspaceHistoryRequest[]) => {
    const original = structuredClone(items);
    return call(async () =>
      parseBatch<E2eeWorkspaceHistoryPage>(
        historyPage,
        await input.client.action(api.e2eeWorkspaces.historyBatch, { items: original })
      )
    );
  };
  const appendRecordsBatch = (items: E2eeAppendRecordRequest[]) => {
    const original = structuredClone(items);
    return call(async () =>
      parseBatch<E2eeAppendRecordReply>(
        z.object({
          status: z.enum(['committed', 'conflict']),
          recordHash: hash,
          historyPage: historyPage.optional(),
        }),
        await input.client.action(api.e2eeWorkspaces.appendRecordsBatch, { items: original })
      )
    );
  };
  return {
    relay: makePersonalCloudAccountPairingRelay(input),
    historyBatch,
    appendRecordsBatch,
    appendRecord: (request: E2eeAppendRecordRequest) =>
      call(() => input.client.action(api.e2eeWorkspaces.appendRecord, { ...request })),
    requester: {
      historyBatch,
      workspaces: async () =>
        (await call(() => input.client.query(api.e2eeMembers.workspaces, {}))).map((workspace) => ({
          workspaceId: workspace.id,
          name: workspace.name,
          genesisHash: workspace.genesisHash,
        })),
      history: (request: E2eeWorkspaceHistoryRequest) =>
        call(async () =>
          historyPage.parse(await input.client.action(api.e2eeWorkspaces.history, request))
        ),
    },
  };
}

export function makePersonalAccountPairingStore(
  accountId: string
): AccountPairingStore & { close(): void } {
  return makeIndexedDbAccountPairingStore({ accountId });
}
