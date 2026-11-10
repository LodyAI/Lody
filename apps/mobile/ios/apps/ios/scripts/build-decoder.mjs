import { loadBackendConfig } from '../../../../backend-config.mjs';
import { buildDataRuntime } from '../../../packages/cloud-runtime/scripts/build.mjs';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  entryPoints: [root + 'runtime/decoder/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'safari17',
  write: false,
});
const output = root + '.generated/Resources';
await mkdir(output, { recursive: true });
const markdownRepair = await build({
  // Shared with Android; see shared/markdown-repair/README.md.
  stdin: {
    contents: await readFile(
      root + '../../../shared/markdown-repair/entry.js',
      'utf8',
    ),
    resolveDir: root,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'safari17',
  write: false,
});
await writeFile(
  output + '/MarkdownRepair.js',
  markdownRepair.outputFiles[0].text,
);
await copyFile(
  root + '../../node_modules/remend/LICENSE',
  output + '/Remend-LICENSE.txt',
);
await writeFile(
  output + '/FlockDecoder.html',
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'wasm-unsafe-eval\'"><script type="module">' +
    result.outputFiles[0].text.replaceAll('</script', '<\\/script') +
    '</script>',
);
const license = await readFile(
  root + '../../node_modules/@loro-dev/flock-wasm/LICENSE',
  'utf8',
);
await writeFile(output + '/Flock-LICENSE.txt', license);
console.log('Built isolated Flock decoder');

const backends = loadBackendConfig();
await buildDataRuntime(output, backends.CF_WORKER_URL);
await writeFile(
  root + '.generated/backend-config.json',
  JSON.stringify(backends),
);
