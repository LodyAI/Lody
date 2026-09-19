import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sorbetRoot = path.resolve(cliRoot, '../../packages/sorbet');
const manifest = JSON.parse(
  readFileSync(path.join(cliRoot, 'src/agent/sorbet-runtime-manifest.json'), 'utf8')
);

if (!existsSync(path.join(sorbetRoot, 'package.json'))) {
  throw new Error(
    'Sorbet source is missing. Initialize submodules with `git submodule update --init packages/sorbet`.'
  );
}

const sorbetPackage = JSON.parse(readFileSync(path.join(sorbetRoot, 'package.json'), 'utf8'));
if (
  typeof sorbetPackage.packageManager !== 'string' ||
  !/^pnpm@\d/u.test(sorbetPackage.packageManager)
) {
  throw new Error('Sorbet package.json must pin an exact pnpm packageManager version.');
}

const revision = capture('git', ['-C', sorbetRoot, 'rev-parse', 'HEAD']).trim();
if (revision !== manifest.revision) {
  throw new Error(
    `Sorbet source revision ${revision} does not match the pinned manifest ${manifest.revision}.`
  );
}

run(corepackCommand(), [
  sorbetPackage.packageManager,
  '--dir',
  sorbetRoot,
  'install',
  '--frozen-lockfile',
]);

run(corepackCommand(), [
  sorbetPackage.packageManager,
  '--dir',
  sorbetRoot,
  '--filter',
  '@sorbetai/acp...',
  'build',
]);

function corepackCommand() {
  return process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: cliRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: cliRoot, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} exited with status ${result.status}`);
  }
  return result.stdout;
}
