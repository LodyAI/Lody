import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';

const ResetReceipt = z
  .object({
    archive: z.string().nullable(),
    source: z.object({ dev: z.number(), ino: z.number() }).strict().nullable(),
  })
  .strict();
const receiptFor = (directory: string, resetId: string, receiptsDirectory?: string) =>
  receiptsDirectory
    ? join(
        receiptsDirectory,
        `${createHash('sha256').update(directory).digest('hex')}.reset-${resetId}.json`
      )
    : `${directory}.reset-${resetId}.json`;
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function complete(receipt: string) {
  let file;
  try {
    file = await open(`${receipt}.complete`, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function retained(directory: string, receipt: string) {
  const stored = ResetReceipt.parse(JSON.parse(await readFile(receipt, 'utf8')));
  if (
    stored.archive !== null &&
    (!stored.archive.startsWith(`${directory}.archive-`) ||
      dirname(stored.archive) !== dirname(directory))
  )
    throw failure('storage');
  return stored;
}
async function originalStillPresent(
  directory: string,
  source: z.infer<typeof ResetReceipt>['source']
) {
  const actual = await lstat(directory);
  if (!source || actual.dev !== source.dev || actual.ino !== source.ino) throw failure('storage');
}

const failure = (code: string) => Object.assign(new Error(`e2ee_${code}`), { code });
const io = <A>(work: () => Promise<A>) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: work,
      catch: () => failure('storage'),
    })
  );

/** A stable sibling SQLite lock survives directory archival. Shared leases live
 * for the complete native owner; reset requires exclusive access, without waiting
 * on another process or guessing lock ownership from a PID. */
export const leaseE2eeIdentity = Effect.fnUntraced(function* (
  directory: string,
  exclusive = false
) {
  if (!isAbsolute(directory)) return yield* Effect.fail(failure('invalid-input'));
  const db = yield* Effect.acquireRelease(
    io(async () => {
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      const path = `${directory}.identity-lock.sqlite`;
      const file = await open(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
          throw failure('storage');
      } finally {
        await file.close();
      }
      return new DatabaseSync(path);
    }),
    (connection) => Effect.sync(() => connection.close())
  );
  yield* Effect.try({
    try: () =>
      db.exec(
        exclusive
          ? 'PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'
          : 'PRAGMA busy_timeout=0; BEGIN; SELECT * FROM sqlite_master'
      ),
    catch: () => failure('identity-busy'),
  });
  return undefined;
});

/** Caller must drain in-process owners and hold the exclusive identity lease.
 * Rename the entire directory on the same volume: no original is opened,
 * repaired, copied or deleted. Absence is an idempotent already-empty result. */
export const archiveE2eeIdentity = Effect.fnUntraced(function* (
  directory: string,
  now: number,
  resetId: string,
  receiptsDirectory?: string
) {
  return yield* io(async () => {
    if (!/^[a-f0-9-]{36}$/.test(resetId)) throw failure('invalid-input');
    const receipt = receiptFor(directory, resetId, receiptsDirectory);
    let stored: z.infer<typeof ResetReceipt> | undefined;
    try {
      stored = await retained(directory, receipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (stored) {
      if (stored.archive === null || (await exists(`${receipt}.complete`))) return stored.archive;
      if (!(await exists(stored.archive))) {
        await originalStillPresent(directory, stored.source);
        await rename(directory, stored.archive);
      }
      await complete(receipt);
      return stored.archive;
    }
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw failure('storage');
    const archive = info
      ? `${directory}.archive-${new Date(now).toISOString().replaceAll(':', '-')}-${randomUUID()}`
      : null;
    await mkdir(dirname(receipt), { recursive: true, mode: 0o700 });
    const receiptFile = await open(receipt, 'wx', 0o600);
    try {
      await receiptFile.writeFile(
        JSON.stringify({ archive, source: info ? { dev: info.dev, ino: info.ino } : null })
      );
      await receiptFile.sync();
    } finally {
      await receiptFile.close();
    }
    if (archive) await rename(directory, archive);
    await complete(receipt);
    return archive;
  });
});

/** Check a completed receipt before draining a replacement. Completion markers
 * and caller-selected receipt storage survive broader account archival too. An
 * unfinished plan may resume only against the original directory inode. */
export const completedE2eeIdentityReset = Effect.fnUntraced(function* (
  directory: string,
  resetId: string,
  receiptsDirectory?: string
) {
  return yield* io(async () => {
    const receipt = receiptFor(directory, resetId, receiptsDirectory);
    let stored;
    try {
      stored = await retained(directory, receipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stored.archive === null || (await exists(`${receipt}.complete`)))
      return { archive: stored.archive };
    if (await exists(stored.archive)) {
      await complete(receipt);
      return { archive: stored.archive };
    }
    await originalStillPresent(directory, stored.source);
    return null;
  });
});
