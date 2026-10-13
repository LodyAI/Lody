import { Effect } from 'effect';
import {
  SubmissionRemote,
  SubmissionRemoteError,
  SubmissionJournal,
  submitRecord,
  resumeSubmission,
} from '../../src/submission';
import { sqliteSubmissionJournal } from '../../src/submission/sqlite';
import { anchor, host, rotate } from './fixture';
const [mode, journalPath, hostPath] = process.argv.slice(2);
const remote = host(hostPath);
const service = {
  ...remote.service,
  appendCas: (
    _anchor: Parameters<typeof remote.service.appendCas>[0],
    expected: Parameters<typeof remote.service.appendCas>[1],
    record: Uint8Array
  ) => {
    if (mode === 'before-cas') return Effect.sync(() => process.exit(71));
    return remote.service
      .appendCas(_anchor, expected, record)
      .pipe(
        Effect.flatMap(() =>
          mode === 'lost-response'
            ? Effect.sync(() => process.exit(72))
            : Effect.fail(new SubmissionRemoteError())
        )
      );
  },
};
const program = Effect.gen(function* () {
  const result =
    mode === 'reopen' ? yield* resumeSubmission(anchor) : yield* submitRecord(anchor, rotate());
  const journal = yield* SubmissionJournal;
  const row = yield* journal.load(anchor);
  process.stdout.write(
    JSON.stringify({
      result: result?.outcome,
      record: result && Buffer.from(result.record).toString('hex'),
      phase: row.outcome ?? (row.record ? 'Pending' : 'Idle'),
      hostLength: remote.read().length,
    })
  );
});
try {
  await Effect.runPromise(
    program.pipe(
      Effect.provideService(SubmissionRemote, mode === 'reopen' ? remote.service : service),
      Effect.provide(sqliteSubmissionJournal(journalPath))
    )
  );
} finally {
  remote.db.close();
}
