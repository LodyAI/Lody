import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRequest, payloadRoots, writeReceipt } from './contract.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);
const [requestFile, target, destination] = process.argv.slice(2);
const request = await readRequest(resolve(requestFile));
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== request.sourceSha)
  throw new Error('Checkout differs from approved source');
if (!request.targets.includes(target)) throw new Error('Target is not requested');
const expected = {
  mac: ['darwin', 'arm64'],
  win: ['win32', 'x64'],
  linux: ['linux', 'x64'],
  'linux-arm64': ['linux', 'arm64'],
  cli: ['linux', 'x64'],
}[target];
if (process.platform !== expected[0] || process.arch !== expected[1])
  throw new Error('Build runner differs from target');
const env = {
  ...process.env,
  LODY_RELEASE_REQUEST: resolve(requestFile),
  LODY_RELEASE_TARGET: target,
  LODY_RELEASE_VERSION: target === 'cli' ? request.cliVersion : request.embeddedCliVersion,
  NODE_OPTIONS: '--max-old-space-size=2048',
};
function run(args, overrides = {}) {
  const result = spawnSync('corepack', ['pnpm', ...args], {
    cwd: root,
    env: { ...env, ...overrides },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build command failed: ${args.join(' ')}`);
}
await rm(resolve('apps/cli/dist'), { recursive: true, force: true });
run(['--dir', 'apps/cli', 'prepare:acp-adapters']);
run(['--dir', 'packages/code-review-viewer', 'build']);
for (const mode of ['cli-runtime', 'acp-adapters'])
  run([
    '--dir',
    'apps/cli',
    'exec',
    'vite',
    'build',
    '--config',
    'release.vite.config.mjs',
    '--mode',
    mode,
  ]);
for (const command of ['copy:dsh-presets', 'check:published-bundle-imports', 'copy:wasm'])
  run(['--dir', 'apps/cli', command]);
if (target !== 'cli')
  run(
    [
      '--dir',
      'apps/electron',
      'exec',
      'electron-vite',
      'build',
      '--config',
      'release.vite.config.mjs',
    ],
    { NODE_OPTIONS: '--max-old-space-size=8192' }
  );
const output = resolve(destination);
const relation = relative(root, output);
if (!relation || relation.startsWith('..') || isAbsolute(relation))
  throw new Error('Artifact destination must be inside the build workspace');
await mkdir(output, { recursive: false });
for (const path of payloadRoots(target))
  await cp(resolve(path), resolve(output, path), { recursive: true, dereference: false });
await writeReceipt({
  root: output,
  request,
  target,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  workflowSha: process.env.GITHUB_WORKFLOW_SHA,
});
