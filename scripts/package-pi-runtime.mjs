import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import * as tar from 'tar';
import { compressStream } from 'zstd-stream';

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'packages/acp-extension-pi');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--output' || args[2] !== '--native-dir') {
  throw new Error(
    'Usage: package-pi-runtime.mjs --output <directory> --native-dir <verified CI binaries>'
  );
}
const output = path.resolve(args[1]);
const nativeDir = path.resolve(args[3]);
const run = async (command, argv, cwd) => {
  const result = await execFile(command, argv, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return result.stdout.trim();
};
const sourceCommit = await run('git', ['rev-parse', 'HEAD'], source);
if (await run('git', ['status', '--porcelain'], source)) {
  throw new Error('Pi source must be clean before packaging.');
}
const scratch = await mkdtemp(path.join(tmpdir(), 'lody-pi-runtime-'));
try {
  const build = path.join(scratch, 'build');
  const archiveSource = path.join(scratch, 'source.tar');
  await run('git', ['archive', '--format=tar', `--output=${archiveSource}`, sourceCommit], source);
  await mkdir(build);
  await tar.x({ file: archiveSource, cwd: build });
  // Include the optional native dependencies for every supported host. The installed
  // closure must be self-contained, with no links into a developer's pnpm store.
  await writeFile(
    path.join(build, 'pnpm-workspace.yaml'),
    "packages: ['.']\nsupportedArchitectures:\n  os: [darwin, linux, win32]\n  cpu: [x64, arm64]\n  libc: [glibc, musl]\n"
  );
  await run(
    'corepack',
    [
      'pnpm@10.20.0',
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
    ],
    build
  );
  await run('corepack', ['pnpm@10.20.0', 'build'], build);
  await run(
    'corepack',
    ['pnpm@10.20.0', 'prune', '--prod', '--ignore-scripts', '--config.node-linker=hoisted'],
    build
  );
  const packageDir = path.join(scratch, 'package');
  await mkdir(packageDir);
  for (const entry of ['dist', 'node_modules', 'package.json', 'LICENSE']) {
    await cp(path.join(build, entry), path.join(packageDir, entry), { recursive: true });
  }
  // Install bookkeeping embeds the build home, temporary paths and timestamps.
  // It is not runtime input and must never enter the distributed archive.
  for (const entry of ['.modules.yaml', '.pnpm-workspace-state-v1.json']) {
    await rm(path.join(packageDir, 'node_modules', entry), { force: true });
  }
  await mkdir(path.join(packageDir, 'native'));
  for (const arch of ['x64', 'arm64']) {
    await cp(
      path.join(nativeDir, `win32-${arch}.node`),
      path.join(packageDir, 'native', `win32-${arch}.node`)
    );
  }
  await run(
    process.execPath,
    [path.join(build, 'scripts/smoke.mjs'), path.join(packageDir, 'dist/index.js')],
    scratch
  );
  const pkg = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const minNodeVersion = /^>=(\d+\.\d+\.\d+)$/.exec(pkg.engines.node)?.[1];
  if (!minNodeVersion) throw new Error('Pi must declare an exact minimum Node version.');
  const version = `${pkg.version}-lody.${sourceCommit.slice(0, 12)}`;
  const entries = [];
  async function walk(relative) {
    entries.push(relative);
    for (const entry of (await readdir(path.join(scratch, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, 'en')
    )) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else entries.push(child);
    }
  }
  await walk('package');
  async function archive(file) {
    const stream = tar.c(
      { cwd: scratch, portable: true, noDirRecurse: true, mtime: new Date(0) },
      entries
    );
    const compressed = await compressStream(Readable.toWeb(Readable.from(stream)), { level: 19 });
    await compressed.pipeTo(Writable.toWeb(createWriteStream(file)));
  }
  async function hash(file) {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    return digest.digest('hex');
  }
  const first = path.join(scratch, 'first.tar.zst');
  const second = path.join(scratch, 'second.tar.zst');
  await archive(first);
  await archive(second);
  const sha256 = await hash(first);
  if (sha256 !== (await hash(second))) throw new Error('Pi archive is not reproducible.');
  const fileName = `lody-pi-${version}-${sha256.slice(0, 16)}.tar.zst`;
  const manifest = {
    name: 'pi',
    version,
    sourceVersion: pkg.version,
    sourceCommit,
    publishable: true,
    kind: 'node-package',
    minNodeVersion,
    artifact: {
      fileName,
      sha256,
      size: (await stat(first)).size,
      compression: 'zstd',
      cmd: 'package/dist/index.js',
    },
  };
  await mkdir(output, { recursive: true });
  await cp(first, path.join(output, fileName));
  await writeFile(path.join(output, `${fileName}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
