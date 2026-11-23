/**
 * UNSTABLE test and Lab helpers: one-call forms of `LedgerSubmission` bound to
 * a workspace, still requiring `SubmissionJournal` and `LedgerLog`.
 */
import { Effect, Layer } from 'effect';
import { LedgerSubmission } from '../submission';
import type { SubmissionResult } from '../../services/ledger';
import { WorkspaceScope } from '../../services/workspace';
import type { GenesisHash } from '../foundation/bytes';

/** `LedgerSubmission` bound to `workspace`. */
export const submissionLayer = (workspace: GenesisHash) =>
  LedgerSubmission.layer.pipe(Layer.provide(Layer.succeed(WorkspaceScope, { genesis: workspace })));
const withSubmission = <A, E>(
  workspace: GenesisHash,
  work: (submission: LedgerSubmission['Service']) => Effect.Effect<A, E>
) =>
  Effect.gen(function* () {
    return yield* work(yield* LedgerSubmission);
  }).pipe(Effect.provide(submissionLayer(workspace)));
/** `LedgerSubmission.submit` for `workspace`. */
export const submitRecord = (workspace: GenesisHash, record: Uint8Array) =>
  withSubmission(workspace, (s) => s.submit(record));
/** `LedgerSubmission.resume` for `workspace`. */
export const resumeSubmission = (workspace: GenesisHash) =>
  withSubmission(workspace, (s) => s.resume());
/** `LedgerSubmission.acknowledge` for `workspace`. */
export const acknowledgeSubmission = (workspace: GenesisHash, result: SubmissionResult) =>
  withSubmission(workspace, (s) => s.acknowledge(result));
