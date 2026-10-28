import { Effect } from 'effect';
import type { LoroDoc } from 'loro-crdt';
import { captureScheduleAuthorization, type ScheduleAuthorizationRequest } from '@lody/shared';
import type { ExecutionOrigins } from './execution-origins';
import type { AuthorizeEncryptedExecution, ExecutionAuthorization } from './agent-execution';

/** One invocation's current ledger checks; never persist a successful grant. */
export const authorizeEncryptedSchedule = Effect.fnUntraced(function* (options: {
  workspaceId: string;
  request: ScheduleAuthorizationRequest;
  doc: LoroDoc;
  origins: ExecutionOrigins;
  open: Parameters<ExecutionOrigins['resolveSchedule']>[2];
  recover?: Parameters<ExecutionOrigins['resolveSchedule']>[3];
  authorizeExecution: AuthorizeEncryptedExecution;
  isExecutionOpen: () => boolean;
}): Effect.fn.Return<ExecutionAuthorization, unknown, import('effect').Scope.Scope> {
  const denied = { _tag: 'Denied', reason: 'e2ee_schedule_not_authorized' } as const;
  if (!options.isExecutionOpen()) return denied;
  const unchanged = captureScheduleAuthorization(options.doc, options.request.manualRunKey);
  const signers = yield* options.origins.resolveSchedule(
    options.request,
    options.doc,
    options.open,
    options.recover
  );
  if (signers && 'state' in signers)
    return { _tag: 'Denied', reason: 'e2ee_schedule_evidence_pending' };
  if (!signers?.length) return denied;
  for (const signer of signers) {
    const authorization = yield* options.authorizeExecution(options.workspaceId, signer);
    if (authorization._tag !== 'Authorized') return authorization;
  }
  return options.isExecutionOpen() && unchanged() ? { _tag: 'Authorized' } : denied;
});
