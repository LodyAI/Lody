import {
  AccountProfileIdSchema,
  resolveAccountProfileId,
  type ACPSessionId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

export type AccountHandoffResult = {
  sessionId: SessionId;
  accountProfileId: string;
  acpSessionId: ACPSessionId;
  continuation: boolean;
};

export type AccountHandoffDeps = {
  acquire: () => (() => void) | null;
  assertIdle: () => Promise<void>;
  read: () => Promise<SessionMeta>;
  validate: (meta: SessionMeta, accountProfileId: string) => Promise<void>;
  checkpoint: (patch: Partial<SessionMeta>) => Promise<void>;
  stop: () => Promise<void>;
  launch: (
    meta: SessionMeta,
    accountProfileId: string,
    resume?: ACPSessionId
  ) => Promise<ACPSessionId>;
  isResumeFailure: (error: unknown) => boolean;
  now: () => number;
};

/** The account/provider pair changes only after the candidate has established a session. */
export async function switchSessionAccount(
  request: { sessionId: SessionId; accountProfileId: string; requestId: string },
  deps: AccountHandoffDeps
): Promise<AccountHandoffResult> {
  const target = AccountProfileIdSchema.parse(request.accountProfileId);
  if (!request.requestId.trim()) throw new Error('Account switch request id is required.');
  const release = deps.acquire();
  if (!release) throw new Error('Session is busy; retry the account switch between requests.');
  let source: SessionMeta | undefined;
  let stopped = false;
  let intentWritten = false;
  try {
    await deps.assertIdle();
    source = await deps.read();
    const from = resolveAccountProfileId(source.accountProfileId);
    const prior = source.accountTransitions?.find(
      (transition) => transition.requestId === request.requestId
    );
    if (prior) {
      if (prior.toAccountProfileId !== target)
        throw new Error('Account switch request id was already used for a different account.');
      if (!source.acpSessionId) throw new Error('The committed provider binding is unavailable.');
      return {
        sessionId: request.sessionId,
        accountProfileId: from,
        acpSessionId: source.acpSessionId,
        continuation: Boolean(source.accountContinuation),
      };
    }
    if (from === target && source.acpSessionId && !source.accountHandoff) {
      // Even a no-op needs a receipt: replay after a later switch must remain a no-op.
      intentWritten = true;
      await deps.checkpoint({
        accountTransitions: [
          ...(source.accountTransitions ?? []),
          {
            requestId: request.requestId,
            fromAccountProfileId: from,
            fromAcpSessionId: source.acpSessionId,
            toAccountProfileId: from,
            toAcpSessionId: source.acpSessionId,
            continuation: Boolean(source.accountContinuation),
            committedAt: deps.now(),
          },
        ],
      });
      return {
        sessionId: request.sessionId,
        accountProfileId: target,
        acpSessionId: source.acpSessionId,
        continuation: Boolean(source.accountContinuation),
      };
    }
    await deps.validate(source, target);
    await deps.assertIdle();
    // Set before awaiting: a failed disk flush may still have changed the in-memory mirror.
    intentWritten = true;
    await deps.checkpoint({
      accountHandoff: {
        requestId: request.requestId,
        sourceAccountProfileId: from,
        sourceAcpSessionId: source.acpSessionId,
        targetAccountProfileId: target,
      },
    });
    await deps.assertIdle();
    stopped = true;
    await deps.stop();
    let next: ACPSessionId;
    let continuation = !source.acpSessionId;
    try {
      next = await deps.launch(source, target, source.acpSessionId);
      continuation ||= next !== source.acpSessionId;
    } catch (error) {
      if (!source.acpSessionId || !deps.isResumeFailure(error)) throw error;
      await deps.stop();
      next = await deps.launch(source, target);
      continuation = true;
    }
    await deps.checkpoint({
      accountProfileId: target,
      acpSessionId: next,
      accountHandoff: null,
      accountRateLimits: null,
      accountContinuation: continuation ? { acpSessionId: next } : source.accountContinuation,
      accountTransitions: [
        ...(source.accountTransitions ?? []),
        {
          requestId: request.requestId,
          fromAccountProfileId: from,
          fromAcpSessionId: source.acpSessionId,
          toAccountProfileId: target,
          toAcpSessionId: next,
          continuation,
          committedAt: deps.now(),
        },
      ],
    });
    return {
      sessionId: request.sessionId,
      accountProfileId: target,
      acpSessionId: next,
      continuation,
    };
  } catch (error) {
    // Failed candidates must not survive with a different durable binding.
    try {
      if (stopped) await deps.stop();
    } finally {
      if (source && intentWritten) {
        await deps.checkpoint({
          accountProfileId: resolveAccountProfileId(source.accountProfileId),
          acpSessionId: source.acpSessionId,
          accountHandoff: null,
          accountContinuation: source.accountContinuation ?? null,
          accountRateLimits: source.accountRateLimits ?? null,
          accountTransitions: source.accountTransitions ?? [],
        });
      }
    }
    throw error;
  } finally {
    release();
  }
}
