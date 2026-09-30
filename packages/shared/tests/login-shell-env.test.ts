import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseLoginShellEnvOutput, probeLoginShellEnv } from '../src/node/login-shell-env';
import { isPidAliveSync } from '../src/node/process';

// Real shells under a throwaway HOME: the probe's contract is what a login
// shell's rc files leave in its environment.
describe.skipIf(process.platform === 'win32')('probeLoginShellEnv', () => {
  let home: string;
  const env = () => ({ HOME: home, PATH: '/usr/bin:/bin', ZDOTDIR: home });

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'lody-login-shell-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('recovers what the login profile exports, whatever the profile prints', async () => {
    await writeFile(
      path.join(home, '.profile'),
      'echo "welcome banner"\nexport LODY_PROBE_VALUE="$(printf \'one\\ntwo=three\')"\n'
    );

    const result = await probeLoginShellEnv({ shell: '/bin/sh', env: env(), timeout: '10 seconds' });

    expect(result?.LODY_PROBE_VALUE).toBe('one\ntwo=three');
    expect(result?.HOME).toBe(home);
    // Every variable keeps its name, including the first one after the
    // delimiter (macOS /bin/sh prints `echo -n` literally).
    expect(result?.PATH).toBeDefined();
    expect(Object.keys(result ?? {}).filter((key) => /\s/u.test(key))).toEqual([]);
  });

  // The probe disables oh-my-zsh auto-update and tmux autostart for itself;
  // passing them on would disable them in every Lody terminal too.
  it('returns none of the variables the probe injected into its own shell', async () => {
    const result = await probeLoginShellEnv({
      shell: '/bin/sh',
      env: { ...env(), ZSH_TMUX_AUTOSTART: 'true' },
      timeout: '10 seconds',
    });

    expect(result?.DISABLE_AUTO_UPDATE).toBeUndefined();
    expect(result?.ZSH_TMUX_AUTOSTARTED).toBeUndefined();
    expect(result?.ZSH_TMUX_AUTOSTART).toBe('true');
  });

  // shell-env could not reap a hung shell; the daemon kept it until exit.
  it('ends a shell whose profile hangs and reports no environment', async () => {
    const pidFile = path.join(home, 'shell.pid');
    await writeFile(path.join(home, '.profile'), `echo $$ > "${pidFile}"\nsleep 30\n`);

    const result = await probeLoginShellEnv({ shell: '/bin/sh', env: env(), timeout: '1 second' });

    expect(result).toBeNull();
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    expect(isPidAliveSync(pid)).toBe(false);
  });

  it.skipIf(!existsSync('/bin/zsh') && !existsSync('/bin/bash'))(
    'falls back to zsh or bash when the login shell cannot start',
    async () => {
      const exportLine = 'export LODY_PROBE_VALUE=fallback\n';
      await writeFile(path.join(home, '.zshenv'), exportLine);
      await writeFile(path.join(home, '.bash_profile'), exportLine);

      const result = await probeLoginShellEnv({
        shell: '/nonexistent/lody-shell',
        env: env(),
        timeout: '10 seconds',
      });

      expect(result?.LODY_PROBE_VALUE).toBe('fallback');
    }
  );
});

describe('parseLoginShellEnvOutput', () => {
  // BusyBox `env` has no -0; the probe then prints one variable per line.
  it('reads newline-separated output from an env without -0', () => {
    expect(
      parseLoginShellEnvOutput(
        'banner_LODY_SHELL_ENV_DELIMITER_PATH=/usr/bin\nHOME=/root\n_LODY_SHELL_ENV_DELIMITER_'
      )
    ).toEqual({ PATH: '/usr/bin', HOME: '/root' });
  });

  it('reports nothing when the shell never reached the probe', () => {
    expect(parseLoginShellEnvOutput('command not found: env')).toBeNull();
  });
});
