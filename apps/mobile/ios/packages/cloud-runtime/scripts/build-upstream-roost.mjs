import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(packageRoot, 'vendor/upstream-roost');
const output = path.join(packageRoot, 'src/runtime/upstream-roost.js');
export async function buildUpstreamRoost(check = true) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['entry.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'safari17',
    minifyWhitespace: true,
    write: false,
    metafile: true,
    external: ['zod', 'i18next', 'acp-extension-core'],
    plugins: [
      {
        name: 'upstream-browser-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^@lody\/shared$/ }, () => ({
            path: path.join(root, 'shared-entry.ts'),
          }));
          builder.onResolve(
            { filter: /^@lody\/shared\/session-data$/ },
            () => ({ path: path.join(root, 'session-data.ts') }),
          );
          builder.onResolve(
            { filter: /^acp-extension-dsh\/capabilities$/ },
            () => ({
              path: path.join(
                root,
                'packages/acp-extension-dsh/src/capabilities.ts',
              ),
            }),
          );
          builder.onResolve(
            { filter: /^\.\.\/(schema|session-pull-requests)$/ },
            (args) => {
              if (!args.importer.endsWith('/notifications/presentation.ts'))
                return;
              return {
                path: path.resolve(
                  path.dirname(args.importer),
                  `${args.path}.ts`,
                ),
                sideEffects: false,
              };
            },
          );
          // Only the remote factory is exported. The unused Electron entry has no
          // side effects and must disappear from the browser bundle entirely.
          builder.onResolve({ filter: /^\.\/electron-ipc-client$/ }, () => ({
            path: 'electron-ipc-client',
            external: true,
            sideEffects: false,
          }));
        },
      },
    ],
  });
  const code = `// Generated from the pinned upstream snapshot; see vendor/upstream-roost/README.md.\n${result.outputFiles[0].text}`;
  if (
    code.includes('from "electron-ipc-client"') ||
    code.includes('from "loro-mirror"')
  )
    throw new Error('Electron entry leaked into the browser bundle');
  if (check) {
    if ((await readFile(output, 'utf8')) !== code)
      throw new Error('Upstream Roost bundle differs from its pinned source');
  } else await writeFile(output, code);
  return result.metafile;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildUpstreamRoost(process.argv.includes('--check'));
}
