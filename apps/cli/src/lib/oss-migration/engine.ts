import fs from 'node:fs/promises';
import path from 'node:path';
import { Context, Data, Effect } from 'effect';
import { isSessionDocRoomId } from '@lody/shared';
import { atomicJson, preparedDocumentPath, sourceDocumentPath } from './source';
import { hashBytes, prepareDocument, type Journal, type Manifest } from './model';
import type { MigrationTarget } from './target';
import { migrateAttachments, validateAttachments } from './attachments';
import type { SessionAttachmentTransfer } from '../session-attachment-transfer';

export class MigrationFailed extends Data.TaggedError('MigrationFailed')<{
  message: string;
  cause?: unknown;
}> {}
// The callback's abort signal reaches I/O immediately; cleanup awaits its settlement.
// A bounded cleanup also protects the command from an adapter that ignores cancellation.
export const migrationStep = <T>(run: (signal: AbortSignal) => Promise<T>) =>
  Effect.callback<T, MigrationFailed>((resume, signal) => {
    const settled = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run(signal);
      })
      .then(
        (value) => {
          if (!signal.aborted) resume(Effect.succeed(value));
        },
        (cause: unknown) => {
          if (!signal.aborted)
            resume(
              Effect.fail(
                new MigrationFailed({
                  message: cause instanceof Error ? cause.message : 'Migration failed',
                  cause,
                })
              )
            );
        }
      );
    return Effect.promise(() => settled).pipe(Effect.timeout('5 seconds'), Effect.orDie);
  }).pipe(Effect.timeout('5 minutes'));
export class MigrationRuntime extends Context.Service<
  MigrationRuntime,
  {
    target: MigrationTarget;
    transfer: SessionAttachmentTransfer;
    progress: (message: string) => void;
  }
>()('lody/oss-migration/runtime') {}

export const migrateSnapshot = Effect.fn('migrateSnapshot')(function* (
  manifest: Manifest,
  journal: Journal,
  directory: string
) {
  const runtime = yield* MigrationRuntime;
  const save = () => migrationStep(() => atomicJson(path.join(directory, 'journal.json'), journal));
  // Full local preflight runs before any remote mutation, even on resume.
  for (const entry of manifest.documents) {
    yield* migrationStep(async () => {
      const bytes = await fs.readFile(sourceDocumentPath(directory, entry.id));
      if (hashBytes(bytes) !== entry.sha256)
        throw new Error(`Corrupt migration snapshot: ${entry.id}`);
      const doc = prepareDocument(bytes, entry, manifest);
      if (isSessionDocRoomId(entry.id))
        await validateAttachments(
          doc,
          entry.id.slice('session-'.length),
          directory,
          manifest.sourceMachineId
        );
    });
  }
  if (journal.complete) {
    runtime.progress(
      'This frozen snapshot was already migrated. Source changes after its creation are not included.'
    );
    return;
  }
  yield* migrationStep((signal) => runtime.target.preflight(manifest, journal.reserved, signal));
  // Prepare all bodies before indexing; each output is frozen once, including upload receipts.
  for (const entry of manifest.documents) {
    const file = preparedDocumentPath(directory, entry.id);
    if (!journal.prepared[entry.id]) {
      yield* migrationStep(async (signal) => {
        const doc = prepareDocument(
          await fs.readFile(sourceDocumentPath(directory, entry.id)),
          entry,
          manifest
        );
        if (isSessionDocRoomId(entry.id))
          await migrateAttachments(
            doc,
            entry.id.slice('session-'.length),
            directory,
            manifest,
            journal,
            runtime.transfer,
            signal
          );
        signal.throwIfAborted();
        const bytes = doc.export({ mode: 'snapshot' });
        await fs.writeFile(file, bytes, { mode: 0o600 });
        signal.throwIfAborted();
        journal.prepared[entry.id] = hashBytes(bytes);
      });
      yield* save();
    }
    yield* migrationStep(async () => {
      const bytes = await fs.readFile(file);
      if (hashBytes(bytes) !== journal.prepared[entry.id])
        throw new Error(`Corrupt prepared snapshot: ${entry.id}`);
    });
  }
  for (const entry of manifest.documents) {
    if (journal.published.includes(entry.id)) continue;
    const bytes = yield* migrationStep(() =>
      fs.readFile(preparedDocumentPath(directory, entry.id))
    );
    yield* migrationStep((signal) =>
      runtime.target.reserve(entry, manifest, journal.reserved.includes(entry.id), signal)
    );
    if (!journal.reserved.includes(entry.id)) {
      journal.reserved.push(entry.id);
      yield* save();
    }
    yield* migrationStep((signal) => runtime.target.upload(entry, manifest, bytes, signal));
    yield* migrationStep((signal) => runtime.target.verify(entry, manifest, bytes, signal));
    runtime.progress(`Verified ${entry.id}`);
  }
  // Dependencies and disabled schedule registry must be durable before session discovery.
  yield* migrationStep((signal) => runtime.target.mergeIndexes(manifest, signal));
  for (const entry of manifest.documents) {
    if (journal.published.includes(entry.id)) continue;
    yield* migrationStep((signal) => runtime.target.publish(entry, manifest, signal));
    journal.published.push(entry.id);
    yield* save();
  }
  journal.complete = true;
  yield* save();
  runtime.progress(
    `Migrated ${manifest.documents.length} documents. Imported sessions are stopped and schedules are disabled.`
  );
});
