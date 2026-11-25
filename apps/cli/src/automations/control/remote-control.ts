import { randomUUID } from 'node:crypto';
import type { RpcSecretPublicKey, SessionMeta } from '@lody/shared';
import {
  remoteAutomationIntentSchema,
  remoteAutomationOperationSchema,
  remoteAutomationProofSchema,
  type AutomationCommand,
  type AutomationProgramContext,
  type RemoteAutomationIntent,
  type RemoteAutomationOperation,
  type RemoteAutomationProof,
} from '@lody/shared/automations';
import type { AutomationLedger } from '../storage/ledger';

export type RemoteAutomationVerifier = (input: {
  intent: RemoteAutomationIntent;
  requestToken: string;
}) => Promise<{ requesterUserId: string; expiresAt: number }>;

export type RemoteControlDeps = {
  ledger: AutomationLedger;
  workspaceId: string;
  machineId: string;
  verifyRemoteControl?: RemoteAutomationVerifier;
  ownedCall<A>(body: () => Promise<A>): Promise<A>;
  sessionMeta(sessionId: string): Promise<SessionMeta>;
  sessionContext(sessionId: string, userId: string): Promise<AutomationProgramContext>;
  execute(
    command: AutomationCommand,
    principal: string,
    requesterSessionId?: string
  ): Promise<unknown>;
};

export function createRemoteAutomationController(deps: RemoteControlDeps) {
  const remoteNonce = randomUUID();
  const consumedRemoteRequests = new Map<string, number>();

  return {
    remoteControlNonce: deps.verifyRemoteControl ? remoteNonce : undefined,
    remoteControl: (input: {
      sessionId: string;
      requesterUserId: string;
      operation: RemoteAutomationOperation;
      proof: RemoteAutomationProof;
      responseKey: RpcSecretPublicKey;
    }) =>
      deps.ownedCall(async () => {
        const verify = deps.verifyRemoteControl;
        if (!verify) throw new Error('AUTOMATION_REMOTE_AUTH_UNAVAILABLE');
        const operation = remoteAutomationOperationSchema.parse(input.operation);
        const proof = remoteAutomationProofSchema.parse(input.proof);
        if (proof.runtimeNonce !== remoteNonce) throw new Error('AUTOMATION_RUNTIME_CHANGED');
        for (const [id, expiresAt] of consumedRemoteRequests)
          if (expiresAt <= Date.now()) consumedRemoteRequests.delete(id);
        if (consumedRemoteRequests.has(proof.requestId)) throw new Error('AUTOMATION_REQUEST_USED');
        await deps.sessionMeta(input.sessionId);
        const verified = await verify({
          intent: remoteAutomationIntentSchema.parse({
            workspaceId: deps.workspaceId,
            machineId: deps.machineId,
            sessionId: input.sessionId,
            requesterUserId: input.requesterUserId,
            runtimeNonce: remoteNonce,
            requestId: proof.requestId,
            responseKey: input.responseKey,
            operation,
          }),
          requestToken: proof.requestToken,
        });
        const requester = verified.requesterUserId;
        if (requester !== input.requesterUserId || verified.expiresAt <= Date.now())
          throw new Error('AUTOMATION_PERMISSION_DENIED');
        if (consumedRemoteRequests.has(proof.requestId)) throw new Error('AUTOMATION_REQUEST_USED');
        consumedRemoteRequests.set(proof.requestId, verified.expiresAt);
        await deps.sessionContext(input.sessionId, requester);
        if (operation.type === 'cancel') {
          const wait = deps.ledger.wait(operation.id);
          if (!wait || wait.sessionId !== input.sessionId) throw new Error('AUTOMATION_NOT_FOUND');
          await deps.execute({ type: 'cancel', id: operation.id }, requester);
          return { type: 'cancel' as const };
        }
        if (operation.type === 'list') {
          const all = deps.ledger.waits(undefined, input.sessionId);
          const start = operation.after
            ? all.findIndex((wait) => wait.id === operation.after) + 1
            : 0;
          if (operation.after && start === 0) throw new Error('AUTOMATION_CURSOR_INVALID');
          const waits = [];
          let size = 0;
          for (const wait of all.slice(start)) {
            const receipt = wait.invocationId && deps.ledger.receipt(wait.invocationId);
            const item = {
              id: wait.id,
              sessionId: wait.sessionId,
              reason: wait.reason,
              state: wait.state,
              nextCheckAt: wait.nextCheckAt,
              expiresAt: wait.expiresAt,
              ...(receipt
                ? { continuation: { state: receipt.state, reason: receipt.reason } }
                : {}),
            };
            const bytes = new TextEncoder().encode(JSON.stringify(item)).byteLength;
            if (waits.length && size + bytes > 24_000) break;
            waits.push(item);
            size += bytes;
          }
          const next = start + waits.length < all.length ? waits.at(-1)?.id : undefined;
          return { type: 'list' as const, waits, ...(next ? { next } : {}) };
        }
        const settings = await deps.execute(
          { ...operation, sessionId: input.sessionId },
          requester
        );
        return { type: 'settings' as const, settings };
      }),
  };
}
