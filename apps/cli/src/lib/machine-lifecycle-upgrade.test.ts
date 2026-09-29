import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeProcessTable } from '../../tests/fake-process-table';

const fixture = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => fixture.home,
}));

describe('daemon upgrade command execution', () => {
  let lifecycle: typeof import('./machine-lifecycle');
  let argsFile: string;

  beforeAll(async () => {
    fixture.home = await mkdtemp(path.join(tmpdir(), 'lody upgrade test '));
    argsFile = path.join(fixture.home, 'npm-args.txt');
    const windows = process.platform === 'win32';
    // Exercise a real .cmd shim on Windows, without invoking the installed npm.
    await writeFile(
      path.join(fixture.home, windows ? 'npm.cmd' : 'npm'),
      windows
        ? '@echo off\r\n> "%LODY_TEST_NPM_ARGS_FILE%" (for %%A in (%*) do @echo %%~A)\r\nexit /b %LODY_TEST_NPM_EXIT_CODE%\r\n'
        : '#!/bin/sh\nprintf "%s\\n" "$@" > "$LODY_TEST_NPM_ARGS_FILE"\nexit "$LODY_TEST_NPM_EXIT_CODE"\n',
      { mode: 0o755 }
    );
    lifecycle = await import('./machine-lifecycle');
  });

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await rm(fixture.home, { recursive: true, force: true });
  });

  it.each([0, 1])('handles npm shim exit code %i and consumes the intent', async (exitCode) => {
    // An isolated PATH makes accidentally running a real global install impossible.
    vi.stubEnv('PATH', fixture.home);
    vi.stubEnv('LODY_TEST_NPM_ARGS_FILE', argsFile);
    vi.stubEnv('LODY_TEST_NPM_EXIT_CODE', String(exitCode));
    await lifecycle.writeDaemonUpgradeIntent({
      action: 'upgrade',
      requestId: 'synthetic-upgrade',
      requesterUserId: 'synthetic-user',
      targetVersion: '1.2.3',
      requestedAtMs: 0,
    });
    const errors: string[] = [];

    const upgraded = await lifecycle.runDaemonUpgradeFromIntent({
      logger: { error: (message) => errors.push(message) },
    });

    expect(upgraded).toBe(exitCode === 0);
    expect((await readFile(argsFile, 'utf8')).trim().split(/\s+/)).toEqual([
      'install',
      '-g',
      'lody@1.2.3',
      '--registry=https://registry.npmjs.org',
    ]);
    expect(await lifecycle.readDaemonUpgradeIntent()).toBeNull();
    expect(errors).toEqual(
      exitCode === 0 ? [] : ['[daemon-upgrade] npm install failed with code 1: no output']
    );
  });

  it('cancels a running install by ending its whole process tree', async () => {
    await lifecycle.writeDaemonUpgradeIntent({
      action: 'upgrade',
      requestId: 'synthetic-cancel',
      requesterUserId: 'synthetic-user',
      targetVersion: '1.2.3',
      requestedAtMs: 0,
    });
    const table = new FakeProcessTable('linux');
    const spawned = Promise.withResolvers<number>();
    const controller = new AbortController();

    const upgrade = lifecycle.runDaemonUpgradeFromIntent({
      logger: {},
      signal: controller.signal,
      nodeProcess: {
        ...table.api,
        spawn: (command, args, options) => {
          const child = table.api.spawn(command, args, options);
          if (typeof child.pid === 'number') spawned.resolve(child.pid);
          return child;
        },
      },
    });
    const npmPid = await spawned.promise;
    // A lifecycle script npm started.
    const scriptPid = table.addDescendant(npmPid);
    controller.abort();

    await expect(upgrade).rejects.toMatchObject({ name: 'AbortError' });
    expect(table.isAlive(npmPid)).toBe(false);
    expect(table.isAlive(scriptPid)).toBe(false);
    expect(await lifecycle.readDaemonUpgradeIntent()).toBeNull();
  });
});
