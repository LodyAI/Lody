import { Context, Effect, Layer } from 'effect';
import { makeWorkspaceControlHandle } from '@lody/e2ee-core/internal';
import { makeSqliteEpochRotation } from '@lody/e2ee-core/internal';
import { LedgerLog } from '@lody/e2ee-core/services';
import { SubmissionJournal } from '@lody/e2ee-core/services';
import { sqliteSubmissionJournal } from '@lody/e2ee-core/adapters/node-sqlite';
import {
  makeStreamsLedgerLog,
  type LedgerSubmissionStream,
} from '@lody/e2ee-core/adapters/loro-streams';
import type { DeviceSigner } from '@lody/e2ee-core';
import type { LedgerCheckpoint } from '@lody/e2ee-core';
import type { LedgerFeedError } from '@lody/e2ee-core';
import { makeLabLedgerClient } from './ledger-client';
export { WorkspaceControlError as LabLedgerActorError } from '@lody/e2ee-core';
/** Native Lab adapters only; the public workspace owns command/P09 orchestration. */
export const makeLabLedgerActor = Effect.fnUntraced(function* (
  input: Parameters<typeof makeLabLedgerClient>[0] & {
    readonly journalPath: string;
    readonly stream: LedgerSubmissionStream;
    readonly signer: DeviceSigner;
    readonly checkpoint: () => Effect.Effect<LedgerCheckpoint, LedgerFeedError>;
  }
) {
  const client = yield* makeLabLedgerClient(input);
  const context = yield* Layer.build(sqliteSubmissionJournal({ path: input.journalPath }));
  const remote = yield* makeStreamsLedgerLog({
    genesis: input.genesis,
    stream: input.stream,
    checkpoint: input.checkpoint,
    budget: input.budget,
  });
  const journal = Context.get(context, SubmissionJournal);
  const control = yield* makeWorkspaceControlHandle({ ...input, client, journal, remote });
  return Object.freeze({
    ...control,
    /** The submission journal and ledger log behind this actor, as workflow ports. */
    journal,
    remote,
    makeEpochRotation: (
      config: Pick<
        Parameters<typeof makeSqliteEpochRotation>[0],
        'path' | 'mode' | 'installed' | 'protector' | 'staging'
      >
    ) =>
      makeSqliteEpochRotation({
        ...config,
        genesis: input.genesis,
        signer: input.signer,
        ledger: () => control.refresh().pipe(Effect.map((current) => current.view)),
      }).pipe(
        Effect.provideService(SubmissionJournal, journal),
        Effect.provideService(LedgerLog, remote)
      ),
  });
});
