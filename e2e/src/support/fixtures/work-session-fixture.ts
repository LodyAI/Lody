import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';

const execFileAsync = promisify(execFile);
const SCRIPTED_ACP_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/scripted-acp.mjs'
);

export type ScriptedAcpEvent = {
  at: string;
  pid: number;
  event: string;
  sessionId?: string;
  mode?: string;
  stopReason?: string;
};

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}

export class WorkSessionFixture {
  readonly projectName = 'lody-e2e-work';
  readonly projectRoot: string;
  readonly acpEventLogPath: string;
  readonly scriptedAcpEntry = SCRIPTED_ACP_ENTRY;
  readonly scriptedAgentCommandLine: string;

  private constructor(
    readonly tempRoot: string,
    eventLogPath?: string
  ) {
    this.projectRoot = join(tempRoot, this.projectName);
    this.acpEventLogPath = eventLogPath ?? join(tempRoot, 'scripted-acp-events.jsonl');
    this.scriptedAgentCommandLine = [process.execPath, this.scriptedAcpEntry, this.acpEventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  static async create(eventLogPath?: string): Promise<WorkSessionFixture> {
    const tempBase = process.platform === 'win32' ? tmpdir() : '/tmp';
    const fixture = new WorkSessionFixture(
      mkdtempSync(join(tempBase, 'lody-e2e-work-')),
      eventLogPath
    );
    try {
      mkdirSync(fixture.projectRoot, { recursive: true });
      writeFileSync(
        join(fixture.projectRoot, 'README.md'),
        '# Synthetic Lody E2E workspace\n\nThis repository contains no user data.\n',
        'utf8'
      );
      await execFileAsync('git', ['init', '--initial-branch=main', fixture.projectRoot]);
      await execFileAsync('git', ['-C', fixture.projectRoot, 'add', 'README.md']);
      await execFileAsync('git', [
        '-C',
        fixture.projectRoot,
        '-c',
        'user.name=Lody E2E',
        '-c',
        'user.email=e2e@lody.invalid',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-m',
        'test: initialize synthetic workspace',
      ]);
      return fixture;
    } catch (error) {
      fixture.dispose();
      throw error;
    }
  }

  readAcpEvents(): ScriptedAcpEvent[] {
    try {
      return readFileSync(this.acpEventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as ScriptedAcpEvent];
          } catch {
            // A process may be in the middle of appending the final JSONL record.
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async waitForAcpEvent(event: string, minimumCount = 1): Promise<ScriptedAcpEvent[]> {
    await expect
      .poll(() => this.readAcpEvents().filter((entry) => entry.event === event).length, {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toBeGreaterThanOrEqual(minimumCount);
    return this.readAcpEvents().filter((entry) => entry.event === event);
  }

  getStartedAgentPids(): number[] {
    return [
      ...new Set(
        this.readAcpEvents()
          .filter((entry) => entry.event === 'process-start')
          .map((entry) => entry.pid)
      ),
    ];
  }

  async expectAgentProcessesExited(pids = this.getStartedAgentPids()): Promise<void> {
    expect(pids.length, 'The scripted ACP process never started').toBeGreaterThan(0);
    await expect
      .poll(() => pids.filter(isProcessAlive), {
        timeout: 30_000,
        intervals: [50, 100, 250, 500],
      })
      .toEqual([]);
  }

  dispose(): void {
    rmSync(this.tempRoot, { recursive: true, force: true });
  }
}
