import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCredentialHelperRuntimeEnv,
  formatCredentialHelperCommand,
} from './git-credential-helper-script';

const HELPER_SOURCE = `process.stdin.resume();
process.stdout.write('username=x-access-token\\npassword=ghs_managed\\n\\n');
`;

/** Absolute git path, so the child can run with a PATH that resolves nothing else. */
const resolveGitBinary = (): string =>
  execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' })
    .split(/\r?\n/)[0]
    .trim();

describe('host git credential helper command', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(os.tmpdir(), 'lody-cred-helper-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // The desktop is frequently launched from the Dock/Start menu, where the GUI
  // PATH has no `node` at all. Shadowing `node` with a failing shim reproduces
  // that environment without depending on the machine's real PATH.
  it.skipIf(process.platform === 'win32')(
    'lets git fill credentials when no usable `node` is on PATH',
    () => {
      // Installation directories really do contain spaces ("Lody Helper",
      // "Program Files"), so the produced command must survive the shell.
      const helperDir = path.join(testDir, 'Lody Helper', 'resources');
      mkdirSync(helperDir, { recursive: true });
      const helperPath = path.join(helperDir, 'lody-git-credential-helper.cjs');
      writeFileSync(helperPath, HELPER_SOURCE, 'utf8');

      const shimDir = path.join(testDir, 'no-node-bin');
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(path.join(shimDir, 'node'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });

      const output = execFileSync(
        resolveGitBinary(),
        [
          '-c',
          'credential.helper=',
          '-c',
          `credential.helper=${formatCredentialHelperCommand(process.execPath, helperPath)}`,
          'credential',
          'fill',
        ],
        {
          input: 'protocol=https\nhost=github.com\npath=owner/repo.git\n\n',
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
            GIT_TERMINAL_PROMPT: '0',
            ...buildCredentialHelperRuntimeEnv(),
          },
        }
      );

      expect(output).toContain('username=x-access-token');
      expect(output).toContain('password=ghs_managed');
    }
  );

  it('quotes both words and keeps embedded quotes escaped', () => {
    expect(
      formatCredentialHelperCommand('/opt/Lody Helper/node', '/tmp/a b/helper.cjs', 'darwin')
    ).toBe('!"/opt/Lody Helper/node" "/tmp/a b/helper.cjs"');
    expect(formatCredentialHelperCommand('/usr/bin/node', '/tmp/we"ird/helper.cjs', 'linux')).toBe(
      '!"/usr/bin/node" "/tmp/we\\"ird/helper.cjs"'
    );
  });

  // Git runs the `!` form through its bundled MinGW bash, where a backslash is an
  // escape character rather than a path separator.
  it('rewrites Windows separators as forward slashes', () => {
    expect(
      formatCredentialHelperCommand(
        'C:\\Program Files\\Lody\\Lody.exe',
        'C:\\Users\\dev\\.lody\\repos\\r\\helper.cjs',
        'win32'
      )
    ).toBe('!"C:/Program Files/Lody/Lody.exe" "C:/Users/dev/.lody/repos/r/helper.cjs"');
  });
});

describe('buildCredentialHelperRuntimeEnv', () => {
  it('propagates the Electron-as-Node flag to git children', () => {
    expect(buildCredentialHelperRuntimeEnv({ ELECTRON_RUN_AS_NODE: '1' })).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  it('adds nothing under a plain Node runtime', () => {
    expect(buildCredentialHelperRuntimeEnv({})).toEqual({});
  });
});
