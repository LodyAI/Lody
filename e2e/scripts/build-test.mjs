import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function testDesktopBuild({ root, env = process.env, run = runCommand }) {
  const cliEnv = {
    ...env,
    LODY_PLATFORM: 'local',
    NODE_OPTIONS:
      `${(env.NODE_OPTIONS ?? '').replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/gu, '')} --max-old-space-size=2048`.trim(),
  };
  // Original CLI build phases except the independent typecheck. Keep native
  // preparation, source maps, flat worker/ACP entries and import validation.
  for (const step of [
    'clean',
    'prepare:acp-adapters',
    'build:bundle',
    'copy:dsh-presets',
    'check:published-bundle-imports',
    'copy:wasm',
  ]) {
    run(['--dir', 'apps/cli', 'run', step], { root, env: cliEnv });
  }
  run(['--dir', 'apps/electron', 'sync:cli'], { root, env });
  run(['--dir', 'apps/electron', 'build:app:test'], { root, env });
}

function runCommand(args, { root, env }) {
  const child = spawnSync('corepack', ['pnpm', ...args], {
    cwd: root,
    env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`E2E test build exited ${child.status ?? child.signal}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  testDesktopBuild({ root: fileURLToPath(new URL('../../', import.meta.url)) });
}
