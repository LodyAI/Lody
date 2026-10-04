#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as tar from 'tar';

const runtimeDir = fileURLToPath(new URL('../apps/cli/src/ios-simulator/', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Explicit sorted entries, modes and timestamps make packaging independent of
// checkout mtimes/umask. Swift builds themselves are not claimed byte-reproducible.
async function normalizeTree(root, relative = '') {
  const entries = [];
  const names = (await readdir(path.join(root, relative))).sort();
  for (const name of names) {
    const entry = path.posix.join(relative, name);
    const absolute = path.join(root, entry);
    const stat = await lstat(absolute);
    if (!stat.isFile() && !stat.isDirectory())
      throw new Error(`Unsupported artifact entry: ${entry}`);
    await chmod(absolute, stat.isDirectory() || entry.endsWith('/Baguette') ? 0o755 : 0o644);
    entries.push(entry);
    if (stat.isDirectory()) entries.push(...(await normalizeTree(root, entry)));
  }
  return entries;
}

export async function packageBaguetteRuntime({
  buildDir,
  outputDir,
  manifest,
  patch,
  notices,
  printPins = false,
}) {
  if (hash(patch) !== manifest.build.patchSha256) throw new Error('Baguette patch digest mismatch');
  const binary = await readFile(path.join(buildDir, 'Baguette'));
  if (hash(binary) !== manifest.executableSha256)
    throw new Error('Baguette executable digest mismatch');
  const bundle = path.join(buildDir, 'Baguette_Baguette.bundle');
  if (!(await lstat(bundle)).isDirectory()) throw new Error('Missing Baguette resource bundle');
  const scratch = await mkdtemp(path.join(tmpdir(), 'lody-baguette-package-'));
  try {
    const folder = `baguette-v${manifest.version}-${manifest.platform}`;
    const root = path.join(scratch, folder);
    await mkdir(root);
    await writeFile(path.join(root, 'Baguette'), binary);
    await cp(bundle, path.join(root, 'Baguette_Baguette.bundle'), {
      recursive: true,
      dereference: false,
    });
    await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), notices);
    await writeFile(path.join(root, 'swift-websocket-continuous-clock.patch'), patch);
    await writeFile(
      path.join(root, 'BUILD_PROVENANCE.json'),
      `${JSON.stringify(manifest.build, null, 2)}\n`
    );
    const entries = await normalizeTree(scratch);
    const archives = [path.join(scratch, 'first.tar.gz'), path.join(scratch, 'second.tar.gz')];
    for (const file of archives) {
      await tar.c(
        { cwd: scratch, file, gzip: true, portable: true, mtime: new Date(0), noDirRecurse: true },
        entries
      );
    }
    const first = await readFile(archives[0]);
    const second = await readFile(archives[1]);
    if (!first.equals(second)) throw new Error('Baguette archive packaging is not reproducible');
    const pins = { size: first.length, sha256: hash(first), executableSha256: hash(binary) };
    if (!printPins && (pins.size !== manifest.size || pins.sha256 !== manifest.sha256)) {
      throw new Error(
        'Baguette archive digest mismatch; a changed build needs a new runtime revision and verified pins'
      );
    }
    await mkdir(outputDir, { recursive: true });
    const file = path.join(outputDir, manifest.fileName);
    await writeFile(file, first);
    return { file, ...pins };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        'build-dir': { type: 'string' },
        'output-dir': { type: 'string' },
        'print-pins': { type: 'boolean', default: false },
      },
    });
    if (!values['build-dir'] || !values['output-dir'])
      throw new Error(
        'Usage: package-baguette-runtime.mjs --build-dir <release-directory> --output-dir <directory> [--print-pins]'
      );
    const manifest = JSON.parse(
      await readFile(path.join(runtimeDir, 'baguette-manifest.json'), 'utf8')
    );
    const notices = JSON.parse(
      await readFile(path.join(runtimeDir, 'baguette-notices.json'), 'utf8')
    );
    console.log(
      JSON.stringify(
        await packageBaguetteRuntime({
          buildDir: path.resolve(values['build-dir']),
          outputDir: path.resolve(values['output-dir']),
          manifest,
          patch: await readFile(path.join(runtimeDir, manifest.build.patch)),
          notices: notices.text,
          printPins: values['print-pins'],
        }),
        null,
        2
      )
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
