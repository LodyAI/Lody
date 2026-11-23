import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inputs are reviewed `go-licenses/v2@v2.0.1 save ./cmd/cloudflared` outputs
// for every shipped OS/architecture. See apps/cli/src/preview/README.md.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const preview = join(repo, 'apps/cli/src/preview');

async function collectFiles(root, include = () => true, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collectFiles(root, include, name)));
    else if (entry.isFile()) {
      if (include(name)) files.push([name, await readFile(join(root, name), 'utf8')]);
    } else throw new Error(`Unsupported notice entry: ${name}`);
  }
  return files;
}

export async function collectCloudflaredNotices({
  version,
  source,
  sourceDir,
  goRoots,
  licenseDirs,
}) {
  if (!licenseDirs.length) throw new Error('Expected collected platform license directories');
  if (!goRoots.length) throw new Error('Expected Go source directories');
  const files = new Map();
  const addFile = (name, text) => {
    if (files.has(name) && files.get(name) !== text) {
      throw new Error(`Conflicting notices: ${name}`);
    }
    files.set(name, text);
  };
  for (const root of licenseDirs) {
    for (const [name, text] of await collectFiles(root)) {
      addFile(name, text);
    }
  }
  const ownLicense = await readFile(join(sourceDir, 'LICENSE'), 'utf8');
  if (files.get('github.com/cloudflare/cloudflared/LICENSE') !== ownLicense) {
    throw new Error('Collected cloudflared license does not match the source checkout');
  }
  const goVersions = new Set();
  const isNotice = (name) => /(?:^|\/)(?:LICENSE|COPYING|NOTICE|PATENTS)(?:\.[^/]*)?$/i.test(name);
  for (const goRoot of goRoots) {
    const goVersion = (await readFile(join(goRoot, 'VERSION'), 'utf8')).split('\n')[0];
    goVersions.add(goVersion);
    addFile(`Go/${goVersion}/LICENSE`, await readFile(join(goRoot, 'LICENSE'), 'utf8'));
    for (const [name, text] of await collectFiles(join(goRoot, 'src/vendor'), isNotice)) {
      addFile(`Go/${goVersion}/vendor/${name}`, text);
    }
  }
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const entries = [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    version,
    source,
    sourceGoModSha256: sha256(await readFile(join(sourceDir, 'go.mod'))),
    sourceGoSumSha256: sha256(await readFile(join(sourceDir, 'go.sum'))),
    goVersions: [...goVersions].sort(),
    files: entries.map(([name, content]) => ({ name, content })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceDir, ...inputs] = process.argv.slice(2);
  const separator = inputs.indexOf('--');
  const goRoots = inputs.slice(0, separator);
  const licenseDirs = inputs.slice(separator + 1);
  if (!sourceDir || separator < 1 || !licenseDirs.length) {
    throw new Error(
      'Usage: node scripts/generate-cloudflared-notices.mjs <source-dir> <go-source-dir>... -- <platform-license-dir>...'
    );
  }
  const { version, source } = JSON.parse(
    await readFile(join(preview, 'cloudflared-manifest.json'), 'utf8')
  );
  const notices = await collectCloudflaredNotices({
    version,
    source,
    sourceDir,
    goRoots,
    licenseDirs,
  });
  await writeFile(
    join(preview, 'cloudflared-notices.generated.json'),
    `${JSON.stringify(notices, null, 2)}\n`
  );
  console.log(
    `Collected ${notices.files.length} notices for cloudflared ${version} (${notices.goVersions.join(', ')})`
  );
}
