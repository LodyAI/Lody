import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  interpretDaemonRunnerLaunchOutcome,
  readPidFileRecord,
  removePidFile,
  terminateSpawnedDaemonRunner,
  writePidFile,
} from './daemon-shared';

const tempDirs: string[] = [];

function createPidPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-daemon-owner-'));
  tempDirs.push(dir);
  return path.join(dir, 'daemon.pid');
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class FakeRunnerChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  onKill: (signal: NodeJS.Signals) => void = () => {};

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.onKill(signal);
    return true;
  }

  finish(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
  }
}

describe('daemon PID ownership', () => {
  it('atomically replaces stale diagnostics after Host ownership is acquired', () => {
    const filePath = createPidPath();
    writePidFile(101, 'stale', 'stale-token', filePath);
    const current = writePidFile(202, 'current', 'current-token', filePath);

    expect(readPidFileRecord(filePath)).toEqual(current);
  });

  it('does not let a stale owner delete a replacement owner record', () => {
    const filePath = createPidPath();
    const stale = writePidFile(101, 'stale', 'stale-token', filePath);
    expect(removePidFile(stale, filePath)).toBe(true);
    const replacement = writePidFile(202, 'replacement', 'replacement-token', filePath);

    expect(removePidFile(stale, filePath)).toBe(false);
    expect(readPidFileRecord(filePath)).toEqual(replacement);
  });

  it('rejects records without the full v1 identity, including legacy numeric files', () => {
    const filePath = createPidPath();
    fs.writeFileSync(filePath, '303', 'utf8');
    expect(readPidFileRecord(filePath)).toBeNull();

    fs.writeFileSync(filePath, JSON.stringify({ version: 1, pid: 303 }), 'utf8');
    expect(readPidFileRecord(filePath)).toBeNull();
  });
});

describe('daemon runner launch cleanup', () => {
  it('awaits a runner that reported startup failure before returning the error', () => {
    expect(
      interpretDaemonRunnerLaunchOutcome(
        { status: 'error', message: 'worker bootstrap failed' },
        999_000
      )
    ).toEqual({
      outcome: {
        status: 'error',
        runnerPid: 999_000,
        message: 'worker bootstrap failed',
      },
      cancelRunner: true,
    });
  });

  it('waits for a timed-out spawned runner to stop gracefully', async () => {
    const child = new FakeRunnerChild();
    child.onKill = (signal) => child.finish(signal);

    await expect(
      terminateSpawnedDaemonRunner(child as unknown as ChildProcess, 999_001)
    ).resolves.toBe(true);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('force-kills the spawned runner when graceful shutdown does not finish', async () => {
    vi.useFakeTimers();
    const child = new FakeRunnerChild();
    child.onKill = (signal) => {
      if (signal === 'SIGKILL') child.finish(signal);
    };

    const stopped = terminateSpawnedDaemonRunner(child as unknown as ChildProcess, 999_002, {
      shutdownGraceMs: 10,
      forceKillWaitMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);

    await expect(stopped).resolves.toBe(true);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
