import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildDataRuntime(output) {
  const result = await build({
    plugins: [
      {
        name: 'bundled-loro-wasm',
        setup(build) {
          build.onResolve({ filter: /^loro-crdt$/ }, () =>
            build.resolve('loro-crdt/base64', {
              resolveDir: root,
              kind: 'import-statement',
            }),
          );
        },
      },
    ],
    entryPoints: [root + 'src/runtime/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'safari17',
    write: false,
  });
  await mkdir(output, { recursive: true });
  await writeFile(
    output + '/DataRuntime.html',
    '<!doctype html><title>Lody Data Runtime</title><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src https:; script-src \'unsafe-inline\' \'wasm-unsafe-eval\'"><script type="module">' +
      result.outputFiles[0].text.replaceAll('</script', '<\\/script') +
      '</script>',
  );
  for (const [name, dependency] of Object.entries({
    Flock: '@loro-dev/flock-wasm',
    Loro: 'loro-crdt',
    StreamsCrdt: '@loro-dev/streams-crdt',
    StreamsClient: '@loro-dev/streams-client',
    Fzstd: 'fzstd',
  })) {
    await writeFile(
      output + '/' + name + '-LICENSE.txt',
      await readFile(root + '../../node_modules/' + dependency + '/LICENSE'),
    );
  }
}
