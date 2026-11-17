import {
  isEnvelope,
  machineRpc,
  openPayload,
  sealPayload,
} from './machine-rpc';

type Grant = () => Promise<{ token: string; gatewayBaseUrl: string }>;
type OwnerResponse = {
  type: string;
  sessionId: string;
  success: boolean;
  operation?: string;
  result?: unknown;
  historyRevision?: number;
  historyCount?: number;
  pageTurns?: unknown;
  error?: string;
  retryReason?: 'superseded';
  historyChange?: unknown;
};

type Turn = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
} & Record<string, unknown>;
export type RoostWindow = {
  checkpoint?: string;
  count: number;
  start: number;
  cursor: string | null;
  turns: readonly Turn[];
};

/** The machine remains the authority for a Roost session's history. */
export function createRoostHistoryTransport(options: {
  workspaceId: string;
  machineId: string;
  sessionId: string;
  getGrant: Grant;
  signal: AbortSignal;
  isCurrent?: () => boolean;
}) {
  const request = async (
    method:
      | 'session/history-read'
      | 'session/history-watch'
      | 'session/history-write',
    payload: Record<string, unknown>,
  ): Promise<OwnerResponse> => {
    const { workspaceId, machineId, sessionId, getGrant, signal } = options;
    const checkScope = () => {
      signal.throwIfAborted();
      if (options.isCurrent && !options.isCurrent())
        throw new Error('workspace_changed');
    };
    checkScope();
    const params = await sealPayload(sessionId, { sessionId, ...payload });
    checkScope();
    const reply = await machineRpc(
      workspaceId,
      machineId,
      method,
      params,
      async () => {
        checkScope();
        const grant = await getGrant();
        checkScope();
        return grant;
      },
      AbortSignal.any([
        signal,
        AbortSignal.timeout(
          method === 'session/history-watch' ? 45_000 : 30_000,
        ),
      ]),
    );
    checkScope();
    if (reply.error) throw new Error(reply.error.code ?? 'history_rpc_failed');
    if (!isEnvelope(reply.result) || reply.result.ownerSessionId !== sessionId)
      throw new Error('invalid_history_envelope');
    const response = await openPayload(reply.result);
    checkScope();
    if (!response || typeof response !== 'object')
      throw new Error('invalid_history_response');
    const result = response as OwnerResponse;
    const expected =
      method === 'session/history-write'
        ? 'session/history-write_response'
        : 'session/history-read_response';
    if (
      result.type !== expected ||
      result.sessionId !== sessionId ||
      typeof result.success !== 'boolean'
    )
      throw new Error('invalid_history_response');
    if (
      method === 'session/history-write' &&
      result.operation !== payload.operation
    )
      throw new Error('invalid_history_response');
    if (
      payload.operation === 'respond_permission' &&
      result.success &&
      typeof result.result !== 'boolean'
    )
      throw new Error('invalid_history_response');
    return result;
  };
  return {
    read: (query: { kind: string; [key: string]: unknown }) =>
      request(
        query.kind === 'watchChanges'
          ? 'session/history-watch'
          : 'session/history-read',
        { query },
      ),
    write: (operation: string, payload: Record<string, unknown>) =>
      request('session/history-write', { operation, payload }),
  };
}
