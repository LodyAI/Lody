import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import os from 'node:os';
import { z } from 'zod';
import {
  LODY_SUPERVISOR_CONTRACT_ENV,
  LODY_SUPERVISOR_INSTANCE_ID_ENV,
  LODY_SUPERVISOR_PID_ENV,
  LODY_SUPERVISOR_TOKEN_ENV,
} from '@lody/shared/node/local-cli-supervisor';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { requestLocalCliHostShutdown } from '@lody/shared/node/local-cli-host-lease';
import { calculateWorkerMaxOldSpaceMiB } from '@lody/cli-supervisor';
export { LODY_LOG_DIR } from '@/utils/log-retention';

export const DAEMON_PID_FILE = path.join(getLodyDataDir(), 'daemon.pid');

// Keep the watchdog small and reserve the proportional heap budget for the
// long-lived Worker. The worker limit is intentionally machine-relative so an
// 8GB Mac cannot claim the same V8 heap as a 32GB development machine.
export const DAEMON_WATCHDOG_MAX_OLD_SPACE_MB = 512;
export const DAEMON_WORKER_MAX_OLD_SPACE_MB = calculateWorkerMaxOldSpaceMiB(os.totalmem());

// `<active installation data root>/daemon.pid` is the daemon Supervisor control record: diagnostics
// plus the private Host-control token `lody daemon stop` authenticates with.
// It is never an ownership lock — the Host lease is. Only the complete v1 JSON
// shape is accepted; PID liveness must not be derived from this file.
const DaemonPidRecordSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  instanceId: z.string().min(1),
  controlToken: z.string().min(1),
  startedAtMs: z.number().finite(),
});

export type DaemonPidRecord = z.infer<typeof DaemonPidRecordSchema>;

export function readPidFileRecord(filePath: string = DAEMON_PID_FILE): DaemonPidRecord | null {
  try {
    const parsed = DaemonPidRecordSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomically publishes diagnostics after the caller has acquired the Host lease. */
export function writePidFile(
  pid: number,
  instanceId: string,
  controlToken: string,
  filePath: string = DAEMON_PID_FILE
): DaemonPidRecord {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = {
    version: 1,
    pid,
    instanceId,
    controlToken,
    startedAtMs: Date.now(),
  } satisfies DaemonPidRecord;
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Preserve the original atomic publish failure.
    }
    throw error;
  }
  return record;
}

/** Removes the record only if it still belongs to the expected owner. */
export function removePidFile(
  expected?: DaemonPidRecord,
  filePath: string = DAEMON_PID_FILE
): boolean {
  try {
    if (expected) {
      const current = readPidFileRecord(filePath);
      if (!current || current.pid !== expected.pid || current.instanceId !== expected.instanceId) {
        return false;
      }
    }
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function resolveLodyBin(): string {
  // In bundled mode, process.argv[1] points to the lody entry (dist/index.js)
  return process.argv[1] ?? 'lody';
}

// --- Daemon runner readiness handshake -------------------------------------
//
// `lody daemon start` (and the watchdog upgrade handoff) spawn a detached
// `daemon-runner` with an extra pipe on fd 3. The runner writes exactly one
// JSON line describing its launch outcome, then closes the fd. A successful
// outcome means the supervised Worker reached its local-ready boundary, not
// merely that the watchdog claimed the Host lease and wrote its PID record.

export const DAEMON_RUNNER_READY_FD_ENV = 'LODY_DAEMON_RUNNER_READY_FD';
const DAEMON_RUNNER_READY_FD = 3;
const DAEMON_RUNNER_READY_TIMEOUT_MS = 30_000;
const DAEMON_RUNNER_READY_MAX_BUFFER = 8 * 1024;
const DAEMON_RUNNER_SHUTDOWN_GRACE_MS = 40_000;
const DAEMON_RUNNER_FORCE_KILL_WAIT_MS = 5_000;

const DaemonRunnerLaunchOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    pid: z.number().int().positive(),
    instanceId: z.string().min(1),
  }),
  z.object({
    status: z.literal('occupied'),
    ownerMode: z.string().optional(),
    ownerPid: z.number().int().positive().optional(),
  }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);

export type DaemonRunnerLaunchOutcome = z.infer<typeof DaemonRunnerLaunchOutcomeSchema>;

/**
 * One-shot: reports the runner's launch outcome to the launcher, then closes
 * the channel and drops the env value so children never inherit it. Safe to
 * call when the runner was started without a launcher (env absent).
 */
export function reportDaemonRunnerLaunchOutcome(outcome: DaemonRunnerLaunchOutcome): void {
  const fdRaw = process.env[DAEMON_RUNNER_READY_FD_ENV];
  delete process.env[DAEMON_RUNNER_READY_FD_ENV];
  if (!fdRaw) return;
  const fd = Number.parseInt(fdRaw, 10);
  if (!Number.isInteger(fd) || fd < DAEMON_RUNNER_READY_FD) return;
  try {
    fs.writeSync(fd, `${JSON.stringify(outcome)}\n`);
  } catch {
    // The launcher may already be gone; readiness reporting is best-effort.
  }
  try {
    fs.closeSync(fd);
  } catch {
    // Already closed.
  }
}

export type SpawnDaemonRunnerResult =
  | { status: 'ready'; pid: number; instanceId: string }
  | {
      status: 'occupied';
      runnerPid: number;
      ownerMode?: string | undefined;
      ownerPid?: number | undefined;
    }
  | { status: 'error'; runnerPid: number; message: string }
  | { status: 'missing_child_pid' }
  | { status: 'runner_exited'; runnerPid: number }
  | { status: 'timeout'; runnerPid: number };

type DaemonRunnerWaitResult = {
  outcome: SpawnDaemonRunnerResult;
  cancelRunner: boolean;
};

/** Translate the runner report and identify outcomes whose child must be awaited. */
export function interpretDaemonRunnerLaunchOutcome(
  outcome: DaemonRunnerLaunchOutcome,
  runnerPid: number
): DaemonRunnerWaitResult {
  switch (outcome.status) {
    case 'ready':
      return {
        outcome: { status: 'ready', pid: runnerPid, instanceId: outcome.instanceId },
        cancelRunner: false,
      };
    case 'occupied':
      return {
        outcome: {
          status: 'occupied',
          runnerPid,
          ownerMode: outcome.ownerMode,
          ownerPid: outcome.ownerPid,
        },
        cancelRunner: false,
      };
    case 'error':
      // The report is written before the runner's fatal cleanup releases its
      // Host lease. Await this exact child so upgrade handoff fallback cannot
      // race the failing replacement and mistake it for a new owner.
      return {
        outcome: { status: 'error', runnerPid, message: outcome.message },
        cancelRunner: true,
      };
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

function isChildProcessRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForChildProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isChildProcessRunning(child)) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onExit: () => void;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('close', onExit);
      resolve(exited);
    };
    onExit = () => finish(true);
    timeout = setTimeout(() => finish(!isChildProcessRunning(child)), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
    if (!isChildProcessRunning(child)) finish(true);
  });
}

/**
 * A failed foreground launch must not leave its exact detached child running.
 * Ask that runner's authenticated Host endpoint to drain its Worker; the exact
 * ChildProcess handle we spawned is the fallback and force-stop authority.
 */
export async function terminateSpawnedDaemonRunner(
  child: ChildProcess,
  runnerPid: number,
  options: { shutdownGraceMs?: number; forceKillWaitMs?: number } = {}
): Promise<boolean> {
  if (!isChildProcessRunning(child)) return true;

  // Prefer the runner's authenticated cross-platform shutdown channel so its
  // Worker drains even where OS signals do not reach Node handlers (Windows).
  const pidRecord = readPidFileRecord();
  let gracefulShutdownRequested = false;
  if (pidRecord?.pid === runnerPid) {
    const requested = await requestLocalCliHostShutdown({
      instanceId: pidRecord.instanceId,
      token: pidRecord.controlToken,
      expectedPid: runnerPid,
      expectedMode: 'daemon',
    });
    gracefulShutdownRequested = requested.ok;
  }
  if (!gracefulShutdownRequested) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Exit state below remains authoritative.
    }
  }
  if (
    await waitForChildProcessExit(child, options.shutdownGraceMs ?? DAEMON_RUNNER_SHUTDOWN_GRACE_MS)
  ) {
    return true;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The final wait reports whether the exact child actually exited.
  }
  return await waitForChildProcessExit(
    child,
    options.forceKillWaitMs ?? DAEMON_RUNNER_FORCE_KILL_WAIT_MS
  );
}

/**
 * Spawns a detached daemon runner with a scrubbed environment and waits for
 * its readiness report. A ready runner stays detached; a timed-out or invalid
 * handshake is terminated and awaited before failure returns.
 */
export async function spawnDaemonRunnerAndAwaitReady(
  passthroughArgs: string[],
  options: { timeoutMs?: number } = {}
): Promise<SpawnDaemonRunnerResult> {
  const bin = resolveLodyBin();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [DAEMON_RUNNER_READY_FD_ENV]: String(DAEMON_RUNNER_READY_FD),
  };
  delete env.LODY_DAEMON_SUPERVISED;
  delete env.LODY_ELECTRON_BOOTSTRAP;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env[LODY_SUPERVISOR_PID_ENV];
  delete env[LODY_SUPERVISOR_INSTANCE_ID_ENV];
  delete env[LODY_SUPERVISOR_TOKEN_ENV];
  delete env[LODY_SUPERVISOR_CONTRACT_ENV];

  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${DAEMON_WATCHDOG_MAX_OLD_SPACE_MB}`,
      bin,
      'daemon-runner',
      ...passthroughArgs,
    ],
    {
      detached: true,
      // On Windows a detached child would otherwise get its own visible
      // console window.
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      env,
    }
  );
  const runnerPid = child.pid;
  if (runnerPid === undefined) {
    child.unref();
    return { status: 'missing_child_pid' };
  }

  const readyPipe = (child.stdio[DAEMON_RUNNER_READY_FD] ?? null) as Readable | null;
  const waitResult = await new Promise<DaemonRunnerWaitResult>((resolve) => {
    let settled = false;
    let buffer = '';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: SpawnDaemonRunnerResult, cancelRunner = false) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve({ outcome, cancelRunner });
    };
    timeout = setTimeout(
      () => finish({ status: 'timeout', runnerPid }, true),
      options.timeoutMs ?? DAEMON_RUNNER_READY_TIMEOUT_MS
    );
    timeout.unref?.();
    if (!readyPipe) {
      finish({ status: 'error', runnerPid, message: 'readiness channel unavailable' }, true);
      return;
    }
    readyPipe.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        if (buffer.length > DAEMON_RUNNER_READY_MAX_BUFFER) {
          finish({ status: 'error', runnerPid, message: 'invalid readiness report' }, true);
        }
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish({ status: 'error', runnerPid, message: 'invalid readiness report' }, true);
        return;
      }
      const outcome = DaemonRunnerLaunchOutcomeSchema.safeParse(parsed);
      if (!outcome.success) {
        finish({ status: 'error', runnerPid, message: 'invalid readiness report' }, true);
        return;
      }
      const interpreted = interpretDaemonRunnerLaunchOutcome(outcome.data, runnerPid);
      finish(interpreted.outcome, interpreted.cancelRunner);
    });
    // EOF without a report means the runner exited before its Worker became ready.
    readyPipe.once('end', () => finish({ status: 'runner_exited', runnerPid }, true));
    readyPipe.once('error', () => finish({ status: 'runner_exited', runnerPid }, true));
  });

  readyPipe?.removeAllListeners();
  readyPipe?.destroy();
  let result = waitResult.outcome;
  if (waitResult.cancelRunner && !(await terminateSpawnedDaemonRunner(child, runnerPid))) {
    result = {
      status: 'error',
      runnerPid,
      message: `Daemon launch failed (${result.status}) and runner ${runnerPid} did not exit`,
    };
  }
  child.unref();
  return result;
}
