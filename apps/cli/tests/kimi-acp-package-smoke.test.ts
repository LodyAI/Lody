import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
} from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import {
  KIMI_CODE_MIN_NODE_VERSION,
  isNodeVersionAtLeast,
} from '../src/agent/managed-agent-runtime';

/**
 * Kimi ships as a Lody-maintained managed runtime, not an installed npm
 * dependency, so this smoke test runs against the submodule build output that
 * `scripts/package-kimi-runtime.mjs` packages. A checkout without that build
 * skips instead of failing.
 */
const KIMI_MAIN_PATH = resolve(
  process.cwd(),
  '../../packages/acp-extension-kimi/apps/kimi-code/dist/main.mjs'
);

describe('locked Kimi ACP package', () => {
  it.skipIf(
    !isNodeVersionAtLeast(process.versions.node, KIMI_CODE_MIN_NODE_VERSION) ||
      !existsSync(KIMI_MAIN_PATH)
  )(
    'advertises terminal login and rejects an empty home with auth_required',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'lody-kimi-empty-home-'));
      const child = spawn(process.execPath, [KIMI_MAIN_PATH, 'acp'], {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          KIMI_CODE_HOME: join(home, '.kimi-code'),
          KIMI_CODE_NO_AUTO_UPDATE: '1',
          KIMI_DISABLE_TELEMETRY: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = new Promise<void>((resolveClosed) => {
        child.once('close', () => resolveClosed());
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-8_192);
      });

      try {
        const connection = new ClientSideConnection(
          () => ({}) as Client,
          ndJsonStream(
            Writable.toWeb(child.stdin),
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
          )
        );
        const initialized = await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });

        expect(initialized.authMethods).toEqual(
          expect.arrayContaining([expect.objectContaining({ type: 'terminal', args: ['--login'] })])
        );

        const authError = await connection
          .newSession({ cwd: home, mcpServers: [] })
          .catch((error) => error);
        expect(authError).toMatchObject({ code: -32000 });
        expect(String((authError as Error).message)).toMatch(/authentication required/iu);
      } catch (error) {
        throw new Error(`Kimi ACP smoke failed. stderr: ${stderr}`, { cause: error });
      } finally {
        // Stop all writes before removing HOME; a timeout is not an exit barrier.
        child.kill('SIGKILL');
        await closed;
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000
  );
});
