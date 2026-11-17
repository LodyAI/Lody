import { ConvexError } from 'convex/values';
import type {
  ShortcutTokenFailure,
  ShortcutTokenGrant,
  ShortcutTokenReply,
  ShortcutTokenRequest,
} from '@lody/cloud-api';
import { HANDLED_SHORTCUT_TOKEN_ERROR, isConvexUnauthenticatedError } from '@lody/shared';

/** Failure stays observable to callers and to the existing auth supervisor. The
 * reporting owner, rather than global unhandled/error-boundary capture, reports it. */
export class ShortcutTokenAttemptError extends ConvexError<{
  kind: string;
  code: string;
}> {
  constructor(readonly failure: ShortcutTokenFailure) {
    super({
      kind: failure.code === 'unauthenticated' ? 'lody.auth' : 'lody.shortcut.token',
      code: failure.code,
    });
    // Preserve the existing supervisor's ConvexError name + symbol contract.
    if (failure.code !== 'unauthenticated') this.name = HANDLED_SHORTCUT_TOKEN_ERROR;
  }
}
export function isHandledShortcutTokenError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined) {
    if (!(current instanceof ShortcutTokenAttemptError) || seen.has(current) || seen.size >= 16)
      return false;
    seen.add(current);
    // Do not let an owned root hide an independent/foreign cause (or a getter
    // failure). Boundary diagnostics will safely project the mixed error.
    try {
      current = current.cause;
    } catch {
      return false;
    }
  }
  return seen.size > 0;
}
export function isHandledShortcutTokenEvent(event: {
  event: string;
  properties?: Record<string, unknown>;
}): boolean {
  const list = event.properties?.$exception_list;
  // Mixed chains retain their independent unknown failure.
  return (
    event.event === '$exception' &&
    Array.isArray(list) &&
    list.length > 0 &&
    list.every(
      (entry: unknown) =>
        !!entry &&
        typeof entry === 'object' &&
        (entry as { type?: unknown }).type === HANDLED_SHORTCUT_TOKEN_ERROR
    )
  );
}

export function shortcutTokenDiagnostic(failure: ShortcutTokenFailure) {
  // Values come from the versioned, fixed server vocabulary. No resource IDs,
  // tokens, error messages, stacks or caller-supplied grouping keys leave here.
  return {
    error: new Error(`Shortcut token ${failure.code}`),
    properties: {
      error_code: `shortcut_${failure.code}`,
      source: 'captureException',
      shortcut_phase: failure.phase,
      ...(failure.status !== undefined ? { shortcut_status: failure.status } : {}),
    },
  };
}

type Operation = { settled: number; counts: Map<string, number> };
/** One instance belongs to one provider effect's account/workspace lifetime.
 * Each resource/access operation keeps counts until success or retirement. No
 * result or authorization decision is cached and no operation is replayed. */
export class ShortcutTokenAttempts {
  private operations = new Map<string, Operation>();
  private sequence = 0;
  private disposed = false;
  private legacy = false;
  constructor(
    private readonly options: {
      attempt: (request: ShortcutTokenRequest) => Promise<ShortcutTokenReply>;
      legacy: (request: ShortcutTokenRequest) => Promise<ShortcutTokenGrant>;
      report: (failure: ShortcutTokenFailure) => void;
      authRejected: () => void;
      active: () => boolean;
    }
  ) {}

  private assertActive() {
    if (this.disposed || !this.options.active())
      throw new ShortcutTokenAttemptError({
        kind: 'denied',
        code: 'forbidden',
        phase: 'authorize',
      });
  }
  async grant(request: ShortcutTokenRequest): Promise<ShortcutTokenGrant> {
    this.assertActive();
    const key = JSON.stringify([
      request.workspaceId,
      request.write,
      request.target.kind,
      request.target.kind === 'body'
        ? request.target.bodyDocId
        : [request.target.ownerUserId, request.target.visibility],
    ]);
    let operation = this.operations.get(key);
    if (!operation) {
      operation = { settled: 0, counts: new Map() };
      this.operations.set(key, operation);
    }
    const sequence = ++this.sequence;
    let reply: ShortcutTokenReply;
    try {
      if (this.legacy) return await this.legacyGrant(request);
      try {
        reply = await this.options.attempt(request);
      } catch (error) {
        this.assertActive();
        if (
          error instanceof Error &&
          /(?:^|\n)\s*Could not find public function for ['\"]?promptShortcuts:getStreamTokenV2['\"]?(?:[.\s]|$)/.test(
            error.message
          )
        ) {
          this.legacy = true; // Capability negotiation only, never an auth cache.
          return await this.legacyGrant(request);
        }
        throw error;
      }
    } catch (error) {
      this.assertActive();
      if (isConvexUnauthenticatedError(error)) this.options.authRejected();
      throw error; // Unknown platform faults keep their original diagnostics.
    }
    this.assertActive();
    const current = sequence >= operation.settled;
    if (current) operation.settled = sequence;
    if (reply.ok) {
      if (current) operation.counts.clear();
      return reply.grant;
    }
    const failure = reply.failure;
    if (current) {
      const reason = `${failure.kind}:${failure.phase}:${failure.code}:${failure.status ?? ''}`;
      const count = (operation.counts.get(reason) ?? 0) + 1;
      operation.counts.set(reason, count);
      if (failure.code === 'unauthenticated' && count === 1) this.options.authRejected();
      if (failure.kind !== 'denied' && count === 1) {
        try {
          this.options.report(failure);
        } catch {
          /* diagnostics never change product failure */
        }
      }
    }
    throw new ShortcutTokenAttemptError(failure);
  }
  private async legacyGrant(request: ShortcutTokenRequest) {
    const grant = await this.options.legacy(request);
    this.assertActive();
    return grant;
  }
  /** Device-local counters only; no analytics replacement or persisted state. */
  counts(): number[] {
    return [...this.operations.values()].flatMap((op) => [...op.counts.values()]);
  }
  dispose() {
    this.disposed = true;
    this.operations.clear();
  }
}
