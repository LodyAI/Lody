import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => fixture.home,
}));

describe('daemon upgrade command execution', () => {
  let lifecycle: typeof import('./machine-lifecycle');
  let argsFile: string;
  let packageRoot: string;
  let bin: string;
  let launchFile: string;

  beforeAll(async () => {
    fixture.home = await realpath(await mkdtemp(path.join(tmpdir(), 'lody upgrade test ')));
    argsFile = path.join(fixture.home, 'npm-args.txt');
    packageRoot = path.join(fixture.home, 'global node_modules', 'lody');
    bin = path.join(packageRoot, 'cli.cjs');
    launchFile = path.join(fixture.home, 'launched.json');
    await mkdir(packageRoot, { recursive: true });
    const windows = process.platform === 'win32';
    // Exercise a real .cmd shim on Windows, without invoking the installed npm.
    await writeFile(
      path.join(fixture.home, windows ? 'npm.cmd' : 'npm'),
      windows
        ? '@echo off\r\nif "%~1"=="root" (echo %LODY_TEST_NPM_ROOT% & exit /b %LODY_TEST_NPM_ROOT_EXIT_CODE%)\r\n> "%LODY_TEST_NPM_ARGS_FILE%" (for %%A in (%*) do @echo %%~A)\r\nexit /b %LODY_TEST_NPM_EXIT_CODE%\r\n'
        : '#!/bin/sh\nif [ "$1" = root ]; then printf "%s\\n" "$LODY_TEST_NPM_ROOT"; exit "$LODY_TEST_NPM_ROOT_EXIT_CODE"; fi\nprintf "%s\\n" "$@" > "$LODY_TEST_NPM_ARGS_FILE"\nexit "$LODY_TEST_NPM_EXIT_CODE"\n',
      { mode: 0o755 }
    );
    lifecycle = await import('./machine-lifecycle');
  });

  beforeEach(async () => {
    vi.stubEnv('PATH', fixture.home);
    vi.stubEnv('LODY_TEST_NPM_ARGS_FILE', argsFile);
    vi.stubEnv('LODY_TEST_NPM_EXIT_CODE', '0');
    vi.stubEnv('LODY_TEST_NPM_ROOT_EXIT_CODE', '0');
    vi.stubEnv('LODY_TEST_NPM_ROOT', path.dirname(packageRoot));
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'lody',
        version: '1.2.3',
        bin: { lody: 'cli.cjs' },
      })
    );
    await writeFile(
      bin,
      `
      const fs = require('node:fs');
      if (process.argv[2] === '--version') { console.log('1.2.3'); }
      else {
        fs.writeFileSync(${JSON.stringify(launchFile)}, JSON.stringify(process.argv.slice(1)));
        fs.writeSync(Number(process.env.LODY_DAEMON_RUNNER_READY_FD), JSON.stringify({
          status: 'ready', pid: process.pid, instanceId: 'synthetic-runner', cliVersion: '1.2.3'
        }) + '\\n');
      }
    `
    );
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

    expect(upgraded).toEqual(exitCode === 0 ? { bin, version: '1.2.3' } : null);
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

  async function install(targetVersion = '1.2.3') {
    await lifecycle.writeDaemonUpgradeIntent({
      action: 'upgrade',
      requestId: 'synthetic-upgrade',
      requesterUserId: 'synthetic-user',
      targetVersion,
      requestedAtMs: 0,
    });
    return lifecycle.runDaemonUpgradeFromIntent({ logger: {} });
  }

  it('hands off from an old npx entry to the verified global install, preserving arguments', async () => {
    const { spawnDaemonRunnerAndAwaitReady } = await import('../commands/daemon-shared');
    const oldEntry = process.argv[1];
    process.argv[1] = path.join(fixture.home, '_npx', 'old-version', 'index.js');
    try {
      const installation = await install('latest');
      if (!installation) throw new Error('Expected verified installation');
      const result = await spawnDaemonRunnerAndAwaitReady(
        ['--synthetic-option', 'value with spaces'],
        { installation }
      );
      expect(result.status).toBe('ready');
      expect(JSON.parse(await readFile(launchFile, 'utf8'))).toEqual([
        bin,
        'daemon-runner',
        '--synthetic-option',
        'value with spaces',
      ]);
    } finally {
      process.argv[1] = oldEntry;
    }
  });

  it('rejects a ready replacement that reports a different version', async () => {
    const { spawnDaemonRunnerAndAwaitReady } = await import('../commands/daemon-shared');
    const installation = await install();
    if (!installation) throw new Error('Expected verified installation');
    await writeFile(
      bin,
      `
      require('node:fs').writeSync(Number(process.env.LODY_DAEMON_RUNNER_READY_FD),
        JSON.stringify({ status: 'ready', pid: process.pid, instanceId: 'wrong-version', cliVersion: '1.2.2' }) + '\\n');
    `
    );
    const result = await spawnDaemonRunnerAndAwaitReady([], { installation });
    expect(result).toMatchObject({
      status: 'error',
      message: 'Daemon reported version 1.2.2; expected 1.2.3',
    });
  });

  it.each([
    ['wrong package', { name: 'other', version: '1.2.3', bin: 'cli.cjs' }],
    ['wrong version', { name: 'lody', version: '1.2.2', bin: 'cli.cjs' }],
    ['missing entry', { name: 'lody', version: '1.2.3', bin: 'missing.cjs' }],
    ['missing bin', { name: 'lody', version: '1.2.3' }],
  ])('rejects %s after npm install succeeds', async (_label, manifest) => {
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
    expect(await install()).toBeNull();
    expect(await lifecycle.readDaemonUpgradeIntent()).toBeNull();
  });

  it('rejects a bin outside the installed package', async () => {
    await writeFile(path.join(packageRoot, '..', 'outside.cjs'), "console.log('1.2.3')");
    await writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'lody',
        version: '1.2.3',
        bin: '../outside.cjs',
      })
    );
    expect(await install()).toBeNull();
  });

  it.each(["console.log('1.2.2')", 'process.exit(1)'])(
    'rejects an entry with incorrect runtime version or failed startup: %s',
    async (source) => {
      await writeFile(bin, source);
      expect(await install()).toBeNull();
    }
  );

  it('rejects invalid npm root output', async () => {
    vi.stubEnv('LODY_TEST_NPM_ROOT', 'relative/path');
    expect(await install()).toBeNull();
  });

  it('rejects failed npm root even when its output names an installed package', async () => {
    vi.stubEnv('LODY_TEST_NPM_ROOT_EXIT_CODE', '1');
    expect(await install()).toBeNull();
  });

  it('propagates cancellation and consumes the intent without installing', async () => {
    await lifecycle.writeDaemonUpgradeIntent({
      action: 'upgrade',
      requestId: 'canceled',
      requesterUserId: 'synthetic-user',
      targetVersion: '1.2.3',
      requestedAtMs: 0,
    });
    await rm(argsFile, { force: true });
    await expect(
      lifecycle.runDaemonUpgradeFromIntent({
        logger: {},
        signal: AbortSignal.abort(),
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await lifecycle.readDaemonUpgradeIntent()).toBeNull();
    await expect(readFile(argsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not install without an intent', async () => {
    await lifecycle.clearDaemonUpgradeIntent();
    await rm(argsFile, { force: true });
    expect(await lifecycle.runDaemonUpgradeFromIntent({ logger: {} })).toBeNull();
    await expect(readFile(argsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
