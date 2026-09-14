import type { SessionId } from './ids';

export const SESSION_LIFECYCLE_VERSION = 1 as const;

export type SessionLifecycleState = 'archived' | 'active';

export type SessionLifecycleOrder = {
  counter: string;
  actorId: string;
};

export type SessionLifecycleOperation = {
  version: typeof SESSION_LIFECYCLE_VERSION;
  operationId: string;
  subjectId: SessionId;
  targetIds: readonly SessionId[];
  state: SessionLifecycleState;
  order: SessionLifecycleOrder;
};

export type SessionLifecycleWinner = {
  operationId: string;
  state: SessionLifecycleState;
  order: SessionLifecycleOrder;
};

export type SessionLifecycleRevision = {
  /** Stable, canonical identity. It is intentionally not a wall-clock value. */
  revisionId: string;
  operationIds: readonly string[];
  bySessionId: ReadonlyMap<SessionId, SessionLifecycleWinner>;
};

export class SessionLifecycleProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLifecycleProtocolError';
  }
}
export class SessionLifecycleOperationConflictError extends SessionLifecycleProtocolError {
  constructor(readonly operationId: string) {
    super(`Conflicting payloads use lifecycle operation id ${operationId}`);
    this.name = 'SessionLifecycleOperationConflictError';
  }
}

const CANONICAL_COUNTER_PATTERN = /^(0|[1-9][0-9]*)$/;

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SessionLifecycleProtocolError(`${field} must be a non-empty string`);
  }
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function compareSessionLifecycleOrder(
  left: Pick<SessionLifecycleOperation, 'operationId' | 'order'>,
  right: Pick<SessionLifecycleOperation, 'operationId' | 'order'>
): number {
  const leftCounter = BigInt(left.order.counter);
  const rightCounter = BigInt(right.order.counter);
  if (leftCounter < rightCounter) return -1;
  if (leftCounter > rightCounter) return 1;
  const actorOrder = compareUtf8(left.order.actorId, right.order.actorId);
  return actorOrder === 0 ? compareUtf8(left.operationId, right.operationId) : actorOrder;
}

export function parseSessionLifecycleOperation(value: unknown): SessionLifecycleOperation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionLifecycleProtocolError('Lifecycle operation must be an object');
  }
  const input = value as Record<string, unknown>;
  if (input.version !== SESSION_LIFECYCLE_VERSION) {
    throw new SessionLifecycleProtocolError(`Unsupported lifecycle operation version ${String(input.version)}`);
  }
  assertNonEmptyString(input.operationId, 'operationId');
  assertNonEmptyString(input.subjectId, 'subjectId');
  if (input.state !== 'archived' && input.state !== 'active') {
    throw new SessionLifecycleProtocolError('state must be archived or active');
  }
  if (!Array.isArray(input.targetIds) || input.targetIds.length === 0) {
    throw new SessionLifecycleProtocolError('targetIds must be a non-empty array');
  }
  const targetIds = input.targetIds.map((targetId, index) => {
    assertNonEmptyString(targetId, `targetIds[${index}]`);
    return targetId as SessionId;
  });
  if (new Set(targetIds).size !== targetIds.length) {
    throw new SessionLifecycleProtocolError('targetIds must not contain duplicates');
  }
  if (!targetIds.includes(input.subjectId as SessionId)) {
    throw new SessionLifecycleProtocolError('targetIds must include subjectId');
  }
  if (typeof input.order !== 'object' || input.order === null || Array.isArray(input.order)) {
    throw new SessionLifecycleProtocolError('order must be an object');
  }
  const order = input.order as Record<string, unknown>;
  assertNonEmptyString(order.counter, 'order.counter');
  if (!CANONICAL_COUNTER_PATTERN.test(order.counter)) {
    throw new SessionLifecycleProtocolError('order.counter must be canonical non-negative decimal');
  }
  assertNonEmptyString(order.actorId, 'order.actorId');

  return {
    version: SESSION_LIFECYCLE_VERSION,
    operationId: input.operationId,
    subjectId: input.subjectId as SessionId,
    targetIds,
    state: input.state,
    order: { counter: order.counter, actorId: order.actorId },
  };
}

export function canonicalizeSessionLifecycleOperation(
  operation: SessionLifecycleOperation
): SessionLifecycleOperation {
  const parsed = parseSessionLifecycleOperation(operation);
  return {
    ...parsed,
    targetIds: [...parsed.targetIds].sort(compareUtf8),
  };
}

export function encodeSessionLifecycleOperation(operation: SessionLifecycleOperation): string {
  const canonical = canonicalizeSessionLifecycleOperation(operation);
  return JSON.stringify({
    version: canonical.version,
    operationId: canonical.operationId,
    subjectId: canonical.subjectId,
    targetIds: canonical.targetIds,
    state: canonical.state,
    order: canonical.order,
  });
}

export function sessionLifecycleOperationsEqual(
  left: SessionLifecycleOperation,
  right: SessionLifecycleOperation
): boolean {
  return encodeSessionLifecycleOperation(left) === encodeSessionLifecycleOperation(right);
}

export function resolveSessionLifecycleRevision(
  values: Iterable<unknown>,
  options: {
    /** Unknown and deleted targets remain absent and cannot be resurrected. */
    existingSessionIds?: ReadonlySet<SessionId>;
  } = {}
): SessionLifecycleRevision {
  const byOperationId = new Map<string, SessionLifecycleOperation>();
  for (const value of values) {
    const operation = canonicalizeSessionLifecycleOperation(parseSessionLifecycleOperation(value));
    const existing = byOperationId.get(operation.operationId);
    if (existing && !sessionLifecycleOperationsEqual(existing, operation)) {
      throw new SessionLifecycleOperationConflictError(operation.operationId);
    }
    byOperationId.set(operation.operationId, operation);
  }

  const operations = [...byOperationId.values()].sort(compareSessionLifecycleOrder);
  const bySessionId = new Map<SessionId, SessionLifecycleWinner>();
  for (const operation of operations) {
    for (const targetId of operation.targetIds) {
      if (options.existingSessionIds && !options.existingSessionIds.has(targetId)) continue;
      const previous = bySessionId.get(targetId);
      if (
        previous &&
        compareSessionLifecycleOrder(
          { operationId: previous.operationId, order: previous.order },
          operation
        ) >= 0
      ) {
        continue;
      }
      bySessionId.set(targetId, {
        operationId: operation.operationId,
        state: operation.state,
        order: operation.order,
      });
    }
  }

  const operationIds = operations.map((operation) => operation.operationId);
  const winners = [...bySessionId.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([sessionId, winner]) => [sessionId, winner.operationId, winner.state]);
  return {
    revisionId: JSON.stringify([operationIds, winners]),
    operationIds,
    bySessionId,
  };
}

export function getEffectiveSessionArchivedState(
  revision: SessionLifecycleRevision,
  sessionId: SessionId,
  baseline = false
): boolean {
  const winner = revision.bySessionId.get(sessionId);
  return winner ? winner.state === 'archived' : baseline;
}
