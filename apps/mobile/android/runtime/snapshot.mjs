import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
export async function hashes(directory) {
  const entries = [];
  async function visit(relative) {
    for (const item of await readdir(path.join(directory, relative), {withFileTypes:true})) {
      const name = path.posix.join(relative, item.name);
      if (item.isSymbolicLink()) throw Error(`Snapshot must not contain symlinks: ${name}`);
      if (item.isDirectory()) await visit(name);
      else entries.push([name, createHash('sha256').update(await readFile(path.join(directory,name))).digest('hex')]);
    }
  }
  await visit('');
  return Object.fromEntries(entries.sort(([a],[b])=>a.localeCompare(b)));
}
export async function verifySnapshot(directory = path.join(root,'vendor/cloud-runtime'), manifestFile = path.join(root,'vendor/SHA256.json')) {
  const expected = JSON.parse(await readFile(manifestFile,'utf8'));
  const actual = await hashes(directory);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Cloud runtime snapshot drift; review source changes and provenance before updating SHA256.json');
  return Object.keys(actual).length;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Verified ${await verifySnapshot()} unchanged snapshot files.`);
}
