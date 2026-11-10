import { Effect, Result } from 'effect';
import type { LoroDoc } from 'loro-crdt';
import {
  captureScheduleAuthorization,
  decodeE2eeIntentRecord,
  E2EE_INTENT_KIND,
  readScheduleAuthorization,
  scheduleDeclarationSubject,
  ScheduleDefinitionSchema,
  scheduleDocumentFromMirrorState,
  type ScheduleAuthorizationRequest,
} from '@lody/shared';
import { verifyExecutionIntent, type Bytes } from '@lody/e2ee-core/protocol';
import type { AuthorizeEncryptedExecution, ExecutionAuthorization } from './agent-execution';

/** The schedule document as it is now; the fingerprint is always recomputed from it. */
function currentDocument(doc: LoroDoc, scheduleId: string) {
  const raw = doc.toJSON() as {
    definition?: unknown;
    prompt?: unknown;
    message?: { payload?: unknown };
  };
  if (typeof raw.prompt !== 'string') return undefined;
  return (
    scheduleDocumentFromMirrorState({ ...raw, prompt: raw.prompt, timeline: [] }, scheduleId) ??
    undefined
  );
}

/**
 * One invocation's current ledger checks; never persist a successful grant. A
 * declaration's author is its signed execution intent, stored in the declaration
 * itself (owner decision 2026-11-10), so no original frame or time window is involved.
 */
export const authorizeEncryptedSchedule = Effect.fnUntraced(function* (options: {
  workspaceId: string;
  genesis: Bytes.GenesisHash;
  request: ScheduleAuthorizationRequest;
  doc: LoroDoc;
  authorizeExecution: AuthorizeEncryptedExecution;
  /** Actual resolved Session target at start; omitted at handoff, which uses the signed definition. */
  executionTarget?: { localProjectId?: string };
  isExecutionOpen: () => boolean;
}): Effect.fn.Return<ExecutionAuthorization, unknown> {
  const denied = (
    reason: 'e2ee_schedule_not_authorized' | 'e2ee_signature_missing' | 'e2ee_signature_invalid'
  ) => ({ _tag: 'Denied', reason }) as const;
  if (!options.isExecutionOpen()) return denied('e2ee_schedule_not_authorized');
  const { request } = options;
  const unchanged = captureScheduleAuthorization(options.doc, request.manualRunKey);
  const document = yield* Effect.try({
    try: () => currentDocument(options.doc, request.scheduleId),
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (!document) return denied('e2ee_schedule_not_authorized');
  const signers: string[] = [];
  for (const manualRunKey of request.manualRunKey
    ? [undefined, request.manualRunKey]
    : [undefined]) {
    const subject = yield* Effect.try({
      try: () => scheduleDeclarationSubject(document, manualRunKey),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (!subject || subject.contentDigest !== request.definitionFingerprint)
      return denied('e2ee_schedule_not_authorized');
    const selected = readScheduleAuthorization(options.doc, manualRunKey)?.value as
      | Record<string, unknown>
      | undefined;
    if (
      !selected ||
      selected.definitionFingerprint !== request.definitionFingerprint ||
      selected.kind !== (manualRunKey ? 'manual' : 'definition') ||
      (manualRunKey !== undefined && selected.manualRunKey !== manualRunKey)
    )
      return denied('e2ee_schedule_not_authorized');
    if (selected.e2eeIntent === undefined) return denied('e2ee_signature_missing');
    const record = decodeE2eeIntentRecord(selected.e2eeIntent);
    if (
      !record ||
      record.kind !== E2EE_INTENT_KIND.scheduleDeclaration ||
      Result.isFailure(
        verifyExecutionIntent(
          {
            ...subject,
            genesis: options.genesis,
            workspaceId: options.workspaceId,
            contentDigest: Buffer.from(subject.contentDigest, 'hex'),
          },
          record.signer,
          record.signature
        )
      )
    )
      return denied('e2ee_signature_invalid');
    signers.push(Buffer.from(record.signer).toString('hex'));
  }
  let localProjectId = options.executionTarget?.localProjectId;
  if (!options.executionTarget) {
    const definition = ScheduleDefinitionSchema.safeParse(document.definition);
    if (!definition.success) return denied('e2ee_schedule_not_authorized');
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
  return denied('e2ee_schedule_not_authorized');
});
