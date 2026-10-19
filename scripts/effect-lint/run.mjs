import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const toolRoot = fileURLToPath(new URL('./', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const effectTsgo = path.join(
  path.dirname(require.resolve('@effect/tsgo/package.json')),
  'dist/effect-tsgo.cjs'
);

// Resolve and patch this package's binaries, leaving ordinary workspace lint intact.
const patch = spawnSync(process.execPath, [effectTsgo, 'patch', '--no-typescript', '--oxlint'], {
  cwd: toolRoot,
  stdio: ['ignore', 2, 2],
});
if (patch.error) throw patch.error;
if (patch.status !== 0) process.exit(patch.status ?? 1);
if (process.argv[2] === '--patch-only') process.exit(0);

const tsgolintRequire = createRequire(require.resolve('oxlint-tsgolint/package.json'));
const tsgolint = tsgolintRequire.resolve(
  `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${process.platform === 'win32' ? '.exe' : ''}`
);
const oxlint = path.join(path.dirname(require.resolve('oxlint/package.json')), 'bin/oxlint');
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const lint = spawnSync(
  process.execPath,
  [
    oxlint,
    '--config',
    path.join(root, '.oxlintrc.effect.json'),
    '--disable-nested-config',
    ...args,
  ],
  {
    cwd: root,
    env: { ...process.env, OXLINT_TSGOLINT_PATH: tsgolint },
    stdio: 'inherit',
  }
);
if (lint.error) throw lint.error;
process.exitCode = lint.status ?? 1;
