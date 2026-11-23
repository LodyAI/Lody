import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** Actual loaded source/release identity. A WIP tree is represented by hashes,
 * never falsely assigned to its unmodified base commit. No transcripts/keys. */
export function labImplementationIdentity() {
  const lab = fileURLToPath(new URL('../../', import.meta.url));
  const core = dirname(dirname(require.resolve('@lody/e2ee-core/protocol')));
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string, root: string) => {
    for (const row of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, row.name);
      if (row.isDirectory()) walk(path, prefix, root);
      else if (row.isFile() && row.name.endsWith('.ts'))
        files[`${prefix}/${relative(root, path)}`] = hash(readFileSync(path));
    }
  };
  walk(join(lab, 'src'), 'lab', lab);
  walk(core, 'core', dirname(core));
  const releases: Record<string, string> = {};
  for (const name of [
    'effect',
    '@loro-dev/streams-client',
    '@loro-dev/streams-crdt',
    '@loro-dev/sqlite-riverrun',
    'loro-crdt',
    '@loro-dev/flock-wasm',
    'better-sqlite3',
  ]) {
    let directory = realpathSync(join(lab, 'node_modules', name));
    for (;;) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
          name: string;
          version: string;
        };
        if (manifest.name === name) {
          releases[name] = manifest.version;
          break;
        }
      } catch {}
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`missing release identity:${name}`);
      directory = parent;
    }
  }
  return {
    sourceSha256: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    releases,
    node: process.version,
  };
}
