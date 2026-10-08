import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHostNodeScriptPreamble, type HostNodeRuntime } from './host-node-launcher';
import { buildCredentialHelperValueForPath } from './git-credential-helper-script';

let directory: string;
let emptyBin: string;
let runtimeLog: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'lody-host-node-'));
  emptyBin = path.join(directory, 'empty bin');
  mkdirSync(emptyBin);
  runtimeLog = path.join(directory, 'runtime.log');
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A host runtime under a path with spaces that records its Electron mode, then runs Node. */
const createHostRuntime = (electron: boolean): HostNodeRuntime => {
  const execPath = path.join(directory, 'Lody Helper.app', 'Contents', 'MacOS', 'Lody Helper');
  mkdirSync(path.dirname(execPath), { recursive: true });
  writeFileSync(
    execPath,
    `#!/bin/sh
printf '%s\\n' "\${ELECTRON_RUN_AS_NODE-unset}" >> ${quote(runtimeLog)}
exec ${quote(process.execPath)} "$@"
`
  );
  chmodSync(execPath, 0o755);
  return { execPath, electron };
};

const runtimeInvocations = () => readFileSync(runtimeLog, 'utf8').trim().split('\n');

describe.skipIf(process.platform === 'win32')('host Node launchers', () => {
  it.each([false, true])(
    'runs a generated script without node on PATH (electron=%s)',
    (electron) => {
      const runtime = createHostRuntime(electron);
      const script = path.join(directory, "user's scripts", 'tool');
      mkdirSync(path.dirname(script));
      writeFileSync(
        script,
        `${buildHostNodeScriptPreamble(runtime)}'use strict';
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), file: __filename, strict: (function () { return this; })() === undefined }));
`
      );
      chmodSync(script, 0o755);

      const result = spawnSync(script, ['two words', "it's", '$HOME'], {
        env: { PATH: emptyBin },
        encoding: 'utf8',
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        args: ['two words', "it's", '$HOME'],
        file: realpathSync(script),
        strict: true,
      });
      expect(runtimeInvocations()).toEqual([electron ? '1' : 'unset']);
    }
  );

  it('refuses a runtime path that would break out of the launcher line', () => {
    expect(() =>
      buildHostNodeScriptPreamble({ execPath: '/opt/node\nconsole.log(1)', electron: false })
    ).toThrow();
  });

  it.each([false, true])(
    'serves Git credential helpers through the host runtime (electron=%s)',
    (electron) => {
      const runtime = createHostRuntime(electron);
      const helper = path.join(directory, "helper's dir", 'git-credential-lody.cjs');
      mkdirSync(path.dirname(helper));
      writeFileSync(
        helper,
        `if (process.argv[2] === 'get') process.stdout.write('username=x-access-token\\npassword=from-helper\\n');\n`
      );
      const realGit = path.join(
        execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
        'git'
      );

      const output = execFileSync(
        realGit,
        [
          '-c',
          `credential.helper=${buildCredentialHelperValueForPath(helper, runtime)}`,
          'credential',
          'fill',
        ],
        {
          cwd: directory,
          env: {
            PATH: emptyBin,
            HOME: directory,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
          },
          input: 'protocol=https\nhost=github.com\npath=owner/repo.git\n\n',
          encoding: 'utf8',
        }
      );

      expect(output).toContain('password=from-helper');
      expect(runtimeInvocations()).toEqual([electron ? '1' : 'unset']);
    }
  );
});
