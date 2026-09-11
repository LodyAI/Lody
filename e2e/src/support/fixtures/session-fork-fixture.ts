import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';

const execFileAsync = promisify(execFile);
const ACP_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), 'session-fork-acp.mjs');

export type SessionForkEvent = {
  at: string;
  pid: number;
  event: string;
  sessionId?: string;
  sourceSessionId?: string;
  sourceTurnId?: string;
  turnId?: string;
  cwd?: string;
};

function quoteCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/["\\$`]/gu, '\\$&')}"`;
}

function isSameExistingPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export function isProcessAlive(pid: number): boolean {
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

export class SessionForkFixture {
  readonly projectName = 'lody-e2e-work';
  readonly projectRoot: string;
  readonly eventLogPath: string;
  readonly agentCommandLine: string;

  private constructor(readonly tempRoot: string) {
    this.projectRoot = join(tempRoot, this.projectName);
    this.eventLogPath = join(tempRoot, 'scripted-acp-events.jsonl');
    this.agentCommandLine = [process.execPath, ACP_ENTRY, this.eventLogPath]
      .map(quoteCommandArgument)
      .join(' ');
  }

  static async create(): Promise<SessionForkFixture> {
    const tempBase = process.platform === 'win32' ? tmpdir() : '/tmp';
    const fixture = new SessionForkFixture(mkdtempSync(join(tempBase, 'lody-e2e-work-')));
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

  readEvents(): SessionForkEvent[] {
    try {
      return readFileSync(this.eventLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as SessionForkEvent];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async waitForSourcePrompt(): Promise<SessionForkEvent> {
    let sourcePrompt: SessionForkEvent | undefined;
    const projectRoot = realpathSync(this.projectRoot);
    await expect
      .poll(
        () => {
          const events = this.readEvents();
          const sourceSessionIds = new Set(
            events
              .filter(
                (entry) =>
                  entry.event === 'session-new' &&
                  entry.sessionId &&
                  entry.cwd &&
                  isSameExistingPath(entry.cwd, projectRoot)
              )
              .map((entry) => entry.sessionId!)
          );
          sourcePrompt = events.find(
            (entry) => entry.event === 'prompt-end' && sourceSessionIds.has(entry.sessionId!)
          );
          return sourcePrompt?.sessionId;
        },
        { timeout: 30_000, intervals: [50, 100, 250, 500] }
      )
      .toEqual(expect.any(String));
    return sourcePrompt!;
  }

  dispose(): void {
    rmSync(this.tempRoot, { recursive: true, force: true });
  }
}
