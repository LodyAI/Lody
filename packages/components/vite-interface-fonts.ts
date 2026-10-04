import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const exec = promisify(execFile);
const recipe = fileURLToPath(new URL('./scripts/prepare-interface-fonts.py', import.meta.url));

/** Build-time only: font bytes are bundled locally, never downloaded by the app. */
export function interfaceFontsPlugin(): Plugin {
  return {
    name: 'lody-interface-fonts',
    async configResolved() {
      try {
        await exec(
          'uv',
          [
            'run',
            '--no-project',
            '--with',
            'fonttools[woff]==4.61.1',
            '--with',
            'brotli==1.2.0',
            'python',
            recipe,
          ],
          { maxBuffer: 2 ** 22 }
        );
      } catch (cause) {
        throw new Error(
          'Interface font preparation failed. Install uv and see src/tailwind/interface-fonts/README.md; do not ship a missing-font build.',
          { cause }
        );
      }
    },
    async generateBundle() {
      for (const file of ['Geist-LICENSE.txt', 'vivo-LICENSE.txt']) {
        this.emitFile({
          type: 'asset',
          fileName: `font-licenses/${file}`,
          source: await readFile(
            new URL(`./src/tailwind/interface-fonts/${file}`, import.meta.url)
          ),
        });
      }
    },
  };
}
