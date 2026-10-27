import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';

const ResetReceipt = z.object({ archive: z.string().nullable() }).strict();
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
  resetId: string
) {
  return yield* io(async () => {
    if (!/^[a-f0-9-]{36}$/.test(resetId)) throw failure('invalid-input');
    const receipt = `${directory}.reset-${resetId}.json`;
    let archive: string;
    try {
      const stored = ResetReceipt.parse(JSON.parse(await readFile(receipt, 'utf8')));
      if (stored.archive === null) return null;
      if (typeof stored.archive !== 'string' || !stored.archive.startsWith(`${directory}.archive-`))
        throw failure('storage');
      archive = stored.archive;
      try {
        await lstat(archive);
        return archive;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(directory, archive);
      return archive;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const receiptFile = await open(receipt, 'wx', 0o600);
        try {
          await receiptFile.writeFile(JSON.stringify({ archive: null }));
          await receiptFile.sync();
        } finally {
          await receiptFile.close();
        }
        return null;
      }
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('storage');
    archive = `${directory}.archive-${new Date(now).toISOString().replaceAll(':', '-')}-${randomUUID()}`;
    const receiptFile = await open(receipt, 'wx', 0o600);
    try {
      await receiptFile.writeFile(JSON.stringify({ archive }));
      await receiptFile.sync();
    } finally {
      await receiptFile.close();
    }
    await rename(directory, archive);
    return archive;
  });
});

/** Check a completed receipt before draining a replacement that may already be
 * active. An interrupted pre-rename plan is not a completed reset. */
export const completedE2eeIdentityReset = Effect.fnUntraced(function* (
  directory: string,
  resetId: string
) {
  return yield* io(async () => {
    try {
      const stored = ResetReceipt.parse(
        JSON.parse(await readFile(`${directory}.reset-${resetId}.json`, 'utf8'))
      );
      if (stored.archive === null) return { archive: null };
      if (typeof stored.archive !== 'string' || !stored.archive.startsWith(`${directory}.archive-`))
        throw failure('storage');
      await lstat(stored.archive);
      return { archive: stored.archive as string };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  });
});
