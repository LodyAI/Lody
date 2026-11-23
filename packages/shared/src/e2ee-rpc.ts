/** Narrow dispatch intent; the target validates inputConfig with its existing turn codec. */
export type E2eeDispatchInput = {
  sessionId: string;
  userTurnId: string;
  userId: string;
  timestamp: string;
  inputConfig: unknown;
};
/** Public original ciphertext receipt. No key or execution authority crosses the host boundary. */
export type E2eePreparedDispatch = {
  requestId: string;
  targetMachineId: string;
  frameHex: string;
  /** Feature requests only: ordered, individually signed chunks of one original. */
  frames?: string[];
  requesterDevice: string;
  expiresAt: number;
  /** Dispatch only: the signed execution intent the caller stores with the turn or queue
   * item in the same commit (`e2ee-execution-intent.ts`). */
  e2eeIntent?: string;
};
/** Delivery receipt only. Actual execution remains behind the shared agent-start claim. */
export type E2eeDispatchAck = {
  type: 'session/dispatch-turn_response';
  sessionId: string;
  userTurnId: string;
  accepted: boolean;
  disposition: 'accepted' | 'duplicate' | 'already-terminal' | 'not-owned' | 'error';
};

import { z } from 'zod';
import { LocalMachineRpcRequestSchema, type LocalMachineRpcRequest } from './local-machine-rpc';

/** Same-machine IPC only: never admitted on the encrypted feature channel. Dispatch has
 * its own signed channel. */
type E2eeLocalOnlyMethod =
  | 'ios-simulator/agent-control'
  | 'ios-simulator/control'
  | 'android-emulator/agent-control'
  | 'android-emulator/control'
  | 'mcp/list-tools'
  | 'mcp/authentication'
  | 'session/call-tool'
  | 'session/get-active-invocation-context'
  | 'file/resolve-local'
  | 'session/dispatch-turn'
  | 'session/preview-endpoint-acquire'
  | 'session/preview-endpoint-release';
export type E2eeAdmittedMethod = Exclude<LocalMachineRpcRequest['method'], E2eeLocalOnlyMethod>;
/**
 * `read` needs no execution journal; `write` claims one. Scope decides who may sign
 * ([contract](AGENTS.md#encrypted-feature-rpc)). `remoteControl` needs the target's
 * `e2eeRemoteControl` capability.
 */
export type E2eeRpcPolicy = {
  readonly lane: 'read' | 'write';
  readonly scope: 'machine' | 'session-read' | 'session' | 'project';
  readonly remoteControl?: true;
};
const machineRead = { lane: 'read', scope: 'machine' } as const;
const machineWrite = { lane: 'write', scope: 'machine' } as const;
const sessionRead = { lane: 'read', scope: 'session-read' } as const;
const projectRead = { lane: 'read', scope: 'project' } as const;
const sessionControl = { lane: 'write', scope: 'session', remoteControl: true } as const;
export const E2EE_RPC_POLICIES = {
  'session/history-read': sessionRead,
  'session/history-write': { lane: 'write', scope: 'session' },
  'session/live-status': sessionRead,
  'code-collab/open-diff-manifest': sessionRead,
  'code-collab/read-blob': sessionRead,
  'machine/status': machineRead,
  'machine/ping': machineRead,
  'machine/acp-binary-status': machineRead,
  'file/preview': machineRead,
  'file/download-chunk': machineRead,
  'file/list-dir': { ...machineRead, remoteControl: true },
  'code-collab/open-text': machineRead,
  'code-collab/refresh-text': machineRead,
  'code-collab/lsp-definition': machineRead,
  'code-collab/lsp-references': machineRead,
  'local-project/list-branches': projectRead,
  'local-project/git-state': { ...projectRead, remoteControl: true },
  'project/probe-local-member': { ...projectRead, remoteControl: true },
  'session/fork': { lane: 'write', scope: 'session' },
  'session/cancel': sessionControl,
  'session/terminate': sessionControl,
  'session/steer': sessionControl,
  'session/goal': sessionControl,
  'session/withdraw-input': sessionControl,
  'session/edit-and-resend': machineWrite,
  'session/preview-create': machineWrite,
  'session/preview-revoke': machineWrite,
  'session/preview-status': machineWrite,
  'machine/acp-interaction': machineWrite,
  'sorbet/credentials-list': machineWrite,
  'sorbet/credentials-logout': machineWrite,
  'sorbet/providers-list': machineWrite,
  'sorbet/providers-create': machineWrite,
  'sorbet/providers-update': machineWrite,
  'sorbet/providers-delete': machineWrite,
  'sorbet/providers-refresh': machineWrite,
  'sorbet/models-list': machineWrite,
  'code-collab/get-file-index': machineWrite,
  'code-collab/save-text': machineWrite,
  'code-collab/open-current-diff': machineWrite,
  'code-collab/open-all-changes-diff': machineWrite,
  'code-collab/open-turn-diff': machineWrite,
  'code-collab/init-directory': machineWrite,
  'local-project/control': { ...machineWrite, remoteControl: true },
  'machine/memory': { ...machineWrite, remoteControl: true },
  'machine/pi-extensions': { ...machineWrite, remoteControl: true },
  'machine/acp-binary-install': { ...machineWrite, remoteControl: true },
  'machine/provider-rate-limits-refresh': { ...machineWrite, remoteControl: true },
} as const satisfies { readonly [M in E2eeAdmittedMethod]: E2eeRpcPolicy };

export const e2eeRpcPolicy = (method: string): E2eeRpcPolicy | undefined =>
  Object.hasOwn(E2EE_RPC_POLICIES, method)
    ? E2EE_RPC_POLICIES[method as E2eeAdmittedMethod]
    : undefined;
export const isE2eeFeatureMethod = (method: string): boolean => !!e2eeRpcPolicy(method);
export const isE2eeRemoteControlMethod = (method: string): boolean =>
  e2eeRpcPolicy(method)?.remoteControl === true;
export const isE2eeProjectScopedMethod = (method: string): boolean =>
  e2eeRpcPolicy(method)?.scope === 'project';

export type E2eeFeatureTarget =
  | { kind: 'machine' }
  | { kind: 'session-read' | 'session'; sessionId: string }
  | { kind: 'project'; localProjectId: string };
export function e2eeFeatureTarget(request: LocalMachineRpcRequest): E2eeFeatureTarget {
  const scope = e2eeRpcPolicy(request.method)?.scope ?? 'machine';
  const params: object = request.params;
  if (scope === 'project' && 'localProjectId' in params)
    return { kind: 'project', localProjectId: String(params.localProjectId) };
  if (scope === 'session' || scope === 'session-read') {
    const sessionId =
      'sourceSessionId' in params
        ? params.sourceSessionId
        : 'sessionId' in params
          ? params.sessionId
          : undefined;
    if (typeof sessionId === 'string') return { kind: scope, sessionId };
  }
  return { kind: 'machine' };
}
export const E2eeFeatureInputSchema = z
  .object({
    requestId: z.string().regex(/^[0-9a-f]{32}$/),
    request: LocalMachineRpcRequestSchema.refine((request) => isE2eeFeatureMethod(request.method)),
  })
  .strict();
export type E2eeFeatureInput = { requestId: string; request: LocalMachineRpcRequest };

export type E2eeReadQueryMethod = {
  [M in E2eeAdmittedMethod]: (typeof E2EE_RPC_POLICIES)[M]['lane'] extends 'read' ? M : never;
}[E2eeAdmittedMethod];
/** Closed set of reads with no machine writes or execution claims. */
export const E2EE_READ_QUERY_METHODS = (
  Object.keys(E2EE_RPC_POLICIES) as E2eeAdmittedMethod[]
).filter((method) => E2EE_RPC_POLICIES[method].lane === 'read') as readonly E2eeReadQueryMethod[];
/** In-process ordinary-method adapter intent, never an encrypted wire payload. */
export type E2eeQueryInput = { queryId: string; method: E2eeReadQueryMethod; params: unknown };
/** Encrypted method outcome; raw host exceptions never cross this boundary. */
export type E2eeQueryResult =
  | { result: unknown; error?: never }
  | { error: { code: string; message: string; data?: unknown }; result?: never };

export function isE2eeReadQuery(method: string, _params: unknown): method is E2eeReadQueryMethod {
  return e2eeRpcPolicy(method)?.lane === 'read';
}
/** Associated data for the separately encrypted, one-shot authentication input. */
export function e2eeAcpInteractionInputContext(input: {
  workspaceId: string;
  machineId: string;
  requesterDevice: string;
  interactionRequestId: string;
  interactionId: string;
}): string {
  return JSON.stringify([
    'lody-e2ee-acp-input-v1',
    input.workspaceId,
    input.machineId,
    input.requesterDevice,
    input.interactionRequestId,
    input.interactionId,
  ]);
}

/** Associated data for progress and results encrypted to the initiating device. */
export function e2eeAcpInteractionResponseContext(input: {
  workspaceId: string;
  machineId: string;
  requesterDevice: string;
  interactionRequestId: string;
  requestId: string;
}): string {
  return JSON.stringify([
    'lody-e2ee-acp-response-v1',
    input.workspaceId,
    input.machineId,
    input.requesterDevice,
    input.interactionRequestId,
    input.requestId,
  ]);
}
