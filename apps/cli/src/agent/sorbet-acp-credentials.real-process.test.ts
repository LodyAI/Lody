import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { startProcessLegacy } from '@lody/shared/node/process';
import { describe, expect, it } from 'vitest';
import { createStdinWritableStream, createStdoutReadableStream } from '@/utils/stream';
import type { Logger } from '@/utils/logger';
import { initializeAndRunSorbetCredentials, terminateAcpProcessTree } from './acp-runner';

const packageRoot = process.env.LODY_TEST_SORBET_ACP_PACKAGE;
const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => logger,
  close: async () => {},
};

// Install the exact package separately and opt in with its package directory.
// No user home, environment, provider config or credentials are inherited.
describe.skipIf(!packageRoot)('Sorbet alpha.6 credentials real process', () => {
  it('lists synthetic credentials and removes only the selected provider', async () => {
    if (!packageRoot) throw new Error('Missing Sorbet test package');
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    expect(manifest).toMatchObject({ name: '@sorbetai/acp', version: '0.1.0-alpha.6' });
    const entryPath = path.join(packageRoot, 'dist/stdio-cli.js');
    const root = await mkdtemp(path.join(os.tmpdir(), 'lody-sorbet-real-'));
    const data = path.join(root, 'data');
    const home = path.join(root, 'home');
    await mkdir(data);
    await mkdir(home);
    const credentialsPath = path.join(data, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({
        'fixture-api': { type: 'api_key', key: 'fixture-not-a-secret' },
        'fixture-oauth': {
          type: 'oauth',
          access: 'fixture-access',
          refresh: 'fixture-refresh',
          expires: 1,
        },
      }),
      { mode: 0o600 }
    );
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'appdata'),
      LOCALAPPDATA: path.join(home, 'localappdata'),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_DATA_HOME: path.join(home, 'data'),
      SORBET_DATA_DIR: data,
      SORBET_OBSERVABILITY_RECORDING: 'false',
      SORBET_OBSERVABILITY_CONFIG: '',
      PATH: path.dirname(process.execPath),
      ...(process.env.ELECTRON_RUN_AS_NODE
        ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }
        : {}),
      ...(process.platform === 'win32' && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    };
    async function execute(operation: { type: 'list' } | { type: 'logout'; providerId: string }) {
      const { child } = startProcessLegacy({
        command: process.execPath,
        args: [entryPath, '--no-session-title'],
        options: { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] },
        processGroup: true,
      });
      const signal = AbortSignal.timeout(15_000);
      try {
        if (!child.stdin || !child.stdout) throw new Error('Missing ACP streams');
        child.stderr?.resume();
        const stream = ndJsonStream(
          createStdinWritableStream(child.stdin),
          createStdoutReadableStream(child.stdout)
        );
        const abort = new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Sorbet ACP timed out')), {
            once: true,
          });
        });
        return await Promise.race([
          initializeAndRunSorbetCredentials(stream, signal, operation),
          abort,
        ]);
      } finally {
        await terminateAcpProcessTree(child, {
          logger,
          sessionLabel: 'sorbet-real-test',
          exitTimeoutMs: 3000,
        });
      }
    }
    try {
      expect(await execute({ type: 'list' })).toEqual([
        { providerId: 'fixture-api', type: 'api_key' },
        { providerId: 'fixture-oauth', type: 'oauth' },
      ]);
      await execute({ type: 'logout', providerId: 'fixture-api' });
      expect(await execute({ type: 'list' })).toEqual([
        { providerId: 'fixture-oauth', type: 'oauth' },
      ]);
      expect(JSON.parse(await readFile(credentialsPath, 'utf8'))).toEqual({
        'fixture-oauth': {
          type: 'oauth',
          access: 'fixture-access',
          refresh: 'fixture-refresh',
          expires: 1,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
