import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ResolvedCodexProfile } from './codex-profile-store';

const UsageRecordSchema = z.object({ version: z.literal(1), token: z.uuid() }).strict();
const NativeProofSchema = z
  .object({ nativePid: z.number().int().positive().optional(), nativeExited: z.boolean() })
  .strict();
export type CodexProfileProcessUsage = (() => Promise<void>) & {
  token: string;
  recordNativePid(pid: number | undefined): void;
  abandonBeforeSpawn(): Promise<void>;
};

function nativeProcessIsGone(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function readProof(file: string) {
  try {
    return NativeProofSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Unknown processes delay deletion only; they never restrict another session's start. */
export async function reconcileCodexProfileProcesses(
  profile: ResolvedCodexProfile
): Promise<boolean> {
  const directory = path.join(profile.home, '..', 'processes');
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let idle = true;
  for (const entry of entries) {
    if (!/^[0-9a-f-]{36}\.json$/.test(entry)) continue;
    const recordFile = path.join(directory, entry);
    const proofFile = path.join(directory, entry.replace(/\.json$/, '.native.json'));
    const proof = await readProof(proofFile);
    if (proof?.nativeExited || nativeProcessIsGone(proof?.nativePid)) {
      await rm(recordFile, { force: true });
      await rm(proofFile, { force: true });
    } else idle = false;
  }
  return idle;
}

/** Register before checking the tombstone: deletion either sees this use or prevents its spawn. */
export async function registerCodexProfileProcess(
  profile: ResolvedCodexProfile,
  options: { directNative?: boolean; cleanup?: boolean } = {}
): Promise<CodexProfileProcessUsage> {
  const directory = path.join(profile.home, '..', 'processes');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Invalid Codex process storage');
  const token = randomUUID();
  const recordFile = path.join(directory, `${token}.json`);
  const proofFile = path.join(directory, `${token}.native.json`);
  await writeFile(recordFile, JSON.stringify(UsageRecordSchema.parse({ version: 1, token })), {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    const record = z
      .object({ state: z.enum(['pending', 'ready', 'removed']) })
      .parse(JSON.parse(await readFile(path.join(profile.home, '..', 'profile.json'), 'utf8')));
    if (record.state === 'removed' && !options.cleanup)
      throw new Error('This Codex account was removed; add a new provider');
    if (record.state !== 'ready' && !options.directNative)
      throw new Error('Authenticate this Codex account before starting a session');
  } catch (error) {
    await rm(recordFile, { force: true });
    throw error;
  }
  let nativePid: number | undefined;
  const removeOwn = async () => {
    await rm(recordFile, { force: true });
    await rm(proofFile, { force: true });
  };
  const release = async () => {
    const proof = await readProof(proofFile);
    if (
      (options.directNative && nativePid === undefined) ||
      proof?.nativeExited ||
      nativeProcessIsGone(nativePid ?? proof?.nativePid)
    )
      await removeOwn();
  };
  release.token = token;
  release.recordNativePid = (pid: number | undefined) => {
    nativePid = pid;
    if (pid === undefined) return;
    try {
      writeFileSync(proofFile, JSON.stringify({ nativePid: pid, nativeExited: false }), {
        mode: 0o600,
      });
    } catch {
      /* Keep the use record when native process ownership cannot be persisted. */
    }
  };
  release.abandonBeforeSpawn = removeOwn;
  return release;
}
