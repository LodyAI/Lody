import { Effect } from 'effect';
import type { LoroDoc } from 'loro-crdt';
import {
  captureScheduleAuthorization,
  ScheduleDefinitionSchema,
  type ScheduleAuthorizationRequest,
} from '@lody/shared';
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
  /** Actual resolved Session target at start; omitted at handoff, which uses the signed definition. */
  executionTarget?: { localProjectId?: string };
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
  let localProjectId = options.executionTarget?.localProjectId;
  if (!options.executionTarget) {
    const definition = ScheduleDefinitionSchema.safeParse(
      options.doc.getMap('definition').toJSON()
    );
    if (!definition.success) return denied;
    if (definition.data.project?.kind === 'local')
      localProjectId = definition.data.project.localProjectId;
  }
  let checks: (() => boolean)[] = [];
  const isCurrent = () =>
    options.isExecutionOpen() && unchanged() && checks.every((check) => check());
  // A later principal's authenticated refresh can invalidate an earlier snapshot.
  // Recheck once using the now-populated requester caches, retaining every actor's fence.
  for (let pass = 0; pass < 2; pass++) {
    checks = [];
    for (const signer of signers) {
      const authorization = yield* options.authorizeExecution(
        options.workspaceId,
        signer,
        localProjectId
      );
      if (authorization._tag !== 'Authorized') return authorization;
      if (authorization.isCurrent) checks.push(authorization.isCurrent);
    }
    if (isCurrent()) return { _tag: 'Authorized', isCurrent };
  }
  return denied;
});
