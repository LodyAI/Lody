import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

/** Freeze built SDK bytes into uniquely named, development-only npm archives.
 * Neither the SDK checkout nor any installed/registry package is modified. */
export function prepareLocalRepoSdk({ sourceRoot, nativeBinary, outputDir }) {
  const git = (...args) =>
    execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim();
  const sourceHead = git('rev-parse', 'HEAD');
  const sources = git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0')
    .filter(Boolean)
    .sort();
  const fingerprint = createHash('sha256');
  for (const file of sources) {
    const absolute = path.join(sourceRoot, file);
    if (fs.lstatSync(absolute).isFile())
      fingerprint
        .update(file)
        .update('\0')
        .update(sha(fs.readFileSync(absolute)));
  }
  const sourceFingerprint = fingerprint.digest('hex');
  const packages = [
    ['@loro-dev/json-patch', 'rust/packages/json-patch', ['dist']],
    ['@loro-dev/loro-repo-client', 'rust/packages/client', ['dist']],
    ['@loro-dev/loro-repo-engine', 'rust/npm/engine', ['index.js', 'index.d.ts', 'bin']],
  ];
  const collected = new Map();
  const collect = (absolute, relative, entries) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`SDK build must contain regular files: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort())
        collect(path.join(absolute, entry), `${relative}/${entry}`, entries);
    } else if (stat.isFile()) entries.set(relative, fs.readFileSync(absolute));
    else throw new Error(`Unsupported SDK build entry: ${relative}`);
  };
  for (const [name, directory, files] of packages) {
    const entries = new Map();
    for (const file of files) collect(path.join(sourceRoot, directory, file), file, entries);
    collected.set(name, {
      metadata: json(path.join(sourceRoot, directory, 'package.json')),
      entries,
    });
  }
  const addon = fs.readFileSync(nativeBinary);
  const digest = createHash('sha256')
    .update('lody-local-sdk-v1')
    .update(sourceHead)
    .update(sourceFingerprint)
    .update(addon);
  for (const [name, pkg] of collected) {
    for (const [file, bytes] of pkg.entries)
      digest.update(name).update('\0').update(file).update('\0').update(sha(bytes));
  }
  const artifactId = digest.digest('hex');
  const version = `0.1.0-lody-local.${artifactId.slice(0, 16)}`;
  // mkdir without recursive prevents overwriting an immutable prior artifact set.
  fs.mkdirSync(outputDir);
  const common = {
    schemaVersion: 1,
    artifactId,
    sourceHead,
    sourceFingerprint,
    capabilities: {
      literalSet: true,
      rawFlockExport: true,
      losslessWireI64: true,
      ...(typeof createRequire(path.join(sourceRoot, 'rust/packages/client/package.json'))(
        './dist/index.cjs'
      ).RepoClient.prototype.flockScanEntries === 'function'
        ? { flockStateEntries: true }
        : {}),
    },
    developmentOnly: true,
  };
  const receipts = {};
  for (const [name, pkg] of collected) {
    const directory = path.join(outputDir, name.split('/')[1]);
    fs.mkdirSync(directory);
    const metadata = { ...pkg.metadata, version, private: true, lodyLocalSdk: common };
    delete metadata.devDependencies;
    delete metadata.scripts;
    delete metadata.publishConfig;
    if (name.endsWith('loro-repo-client'))
      metadata.dependencies = { '@loro-dev/json-patch': version };
    if (name.endsWith('loro-repo-engine')) {
      if (process.platform !== 'darwin' || process.arch !== 'arm64')
        throw new Error('This build input currently supports darwin-arm64 only');
      delete metadata.optionalDependencies;
      metadata.os = [process.platform];
      metadata.cpu = [process.arch];
      const binaryName = 'loro-repo-engine.darwin-arm64.node';
      pkg.entries.set(binaryName, addon);
      metadata.files = [...metadata.files, binaryName];
      metadata.lodyLocalSdk = {
        ...common,
        platform: process.platform,
        arch: process.arch,
        binaryName,
        binarySha256: sha(addon),
      };
      const loader = pkg.entries.get('index.js').toString();
      pkg.entries.set(
        'index.js',
        Buffer.from(
          `if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Local Repo SDK artifact target mismatch');\n${loader}`
        )
      );
    }
    for (const [file, bytes] of pkg.entries) {
      const target = path.join(directory, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    writeJson(path.join(directory, 'package.json'), metadata);
    const result = JSON.parse(
      execFileSync(
        'npm',
        [
          'pack',
          '--json',
          '--ignore-scripts',
          '--workspaces=false',
          '--pack-destination',
          outputDir,
          '--cache',
          path.join(outputDir, '.npm-cache'),
        ],
        { cwd: directory, encoding: 'utf8' }
      )
    )[0];
    receipts[name] = {
      file: result.filename,
      sha256: sha(fs.readFileSync(path.join(outputDir, result.filename))),
    };
  }
  const manifest = {
    ...common,
    version,
    platform: process.platform,
    arch: process.arch,
    packages: receipts,
  };
  writeJson(path.join(outputDir, 'manifest.json'), manifest);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourceRoot, nativeBinary, outputDir] = process.argv.slice(2);
  if (!sourceRoot || !nativeBinary || !outputDir)
    throw new Error(
      'Usage: node prepare-local-loro-repo-sdk.mjs <sdk-source> <built-addon> <new-output-directory>'
    );
  console.log(
    JSON.stringify(prepareLocalRepoSdk({ sourceRoot, nativeBinary, outputDir }), null, 2)
  );
}
