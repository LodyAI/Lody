// Bundles src/mermaid-entry.js (Pele) into a classic script for QuickJS, like markdown-repair.mjs.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildMermaidRender() {
  const result = await build({
    entryPoints: [path.join(root, 'src/mermaid-entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    // QuickJS implements ES2023; keep output conservative and dependency-free.
    target: 'es2020',
    write: false,
  });
  return result.outputFiles[0].text;
}
