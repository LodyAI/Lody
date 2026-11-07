// Bundles shared/markdown-repair/entry.js (remend) into a classic script for QuickJS.
// The same entry feeds iOS (JavaScriptCore); see shared/markdown-repair/README.md.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const markdownRepairEntry = path.resolve(root, '../../shared/markdown-repair/entry.js');

export async function buildMarkdownRepair() {
  const result = await build({
    stdin: { contents: await readFile(markdownRepairEntry, 'utf8'), resolveDir: root },
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    // QuickJS implements ES2023; keep output conservative and dependency-free.
    target: 'es2020',
    write: false,
  });
  return result.outputFiles[0].text;
}
