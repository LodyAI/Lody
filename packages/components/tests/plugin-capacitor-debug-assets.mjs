// Only the debug APK receives these assets. The installed WebView loads them through Capacitor's HTTPS asset handler.
import { build } from 'vite';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = join(root, 'apps/mobile-capacitor/android/app/src/debug/assets/public/__plugin_ci');
const result = await build({
  configFile: false,
  build: {
    write: false,
    target: 'esnext',
    lib: {
      entry: join(root, 'packages/components/tests/browser/plugin-release-fixture.ts'),
      formats: ['es'],
    },
  },
});
const chunks = (Array.isArray(result) ? result[0] : result).output;
if (chunks.length !== 1 || chunks[0].type !== 'chunk')
  throw Error('Expected self-contained fixture');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'fixture.js'), chunks[0].code);
const archive = join(process.env.RUNNER_TEMP, 'plugin-webview.tgz');
const { stdout } = await promisify(execFile)(
  process.execPath,
  [
    join(root, 'apps/cli/dist/index.js'),
    'plugin',
    'pack',
    join(root, 'scripts/fixtures/plugin-sdk/examples/focus-sidebar'),
    '-o',
    archive,
  ],
  {
    env: {
      HOME: process.env.RUNNER_TEMP,
      PATH: process.env.PATH,
      LODY_DATA_DIR: join(process.env.RUNNER_TEMP, 'lody-pack'),
    },
  }
);
const { workspaceEntry: pin } = JSON.parse(stdout);
const name = pin.source.package_name;
const dest = join(out, name, '-');
await mkdir(dest, { recursive: true });
await rename(archive, join(dest, `${name.split('/').at(-1)}-${pin.source.exact_version}.tgz`));
await writeFile(join(out, 'pin.json'), JSON.stringify(pin));
