import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ command: '', supported: true }));
vi.mock('../src/agent/managed-agent-runtime', () => ({
  get PI_EXTENSIONS_SUPPORTED() {
    return runtime.supported;
  },
  getManagedAgentRuntimeManager: () => ({
    ensureCurrentRuntime: async () => ({ command: runtime.command }),
  }),
}));
import { discoverManagedPiExtensions } from '../src/agent/pi-extensions';

let directory: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  runtime.supported = true;
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('runs only the fixed discovery command with profile environment, not arbitrary provider code', async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-discovery-test-'));
  runtime.command = join(directory, 'scanner.mjs');
  await writeFile(
    runtime.command,
    `
    if (process.argv[2] !== '--list-extensions' || process.env.NODE_OPTIONS || process.env.PRIVATE_TOKEN || process.env.LODY_PI_EXTENSIONS) process.exit(2);
    process.stdout.write(JSON.stringify({version:1,agentDir:process.env.PI_CODING_AGENT_DIR,extensions:[{path:'/fixture/plugin.ts',name:process.env.ELECTRON_RUN_AS_NODE,source:'settings'}],warnings:[]}));
  `
  );
  vi.stubEnv('NODE_OPTIONS', '--require /nonexistent/preload.js');
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
  vi.stubEnv('LODY_PI_EXTENSIONS', '["unselected"]');
  expect(
    await discoverManagedPiExtensions({
      PI_CODING_AGENT_DIR: '/saved/profile',
      PRIVATE_TOKEN: 'synthetic',
      NODE_OPTIONS: '--require /untrusted',
    })
  ).toEqual({
    version: 1,
    agentDir: '/saved/profile',
    extensions: [{ path: '/fixture/plugin.ts', name: '1', source: 'settings' }],
    warnings: [],
  });
  await writeFile(runtime.command, `process.stdout.write('not a discovery response');`);
  await expect(discoverManagedPiExtensions()).rejects.toThrow('Pi extension scan failed');
  runtime.supported = false;
  await expect(discoverManagedPiExtensions()).rejects.toThrow('does not support extension listing');
});
