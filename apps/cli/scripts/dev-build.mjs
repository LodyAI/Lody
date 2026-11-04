/**
 * Fast dev bundler for the CLI.
 *
 * `pnpm dev` used to transpile every TypeScript file on demand through a source loader.
 * Two costs came out of that:
 *
 * 1. ~3-4s of startup per process — and the daemon is far from the only process. Each
 *    ACP adapter launch, each per-session MCP server, and every watch-worker respawn
 *    paid it again.
 * 2. The Tinypool worker entries could not be resolved at all. `file-index-scan-pool.ts`
 *    and friends look for a sibling `*-worker.js`, and only `.ts` sources sit next to
 *    them in `src/`, so scans, diff counts, and turn-diff storage ran inline on the
 *    daemon's main thread (`reason=worker_missing`).
 *
 * This script bundles the same entries as the production Vite build, so the dev layout
 * matches production, but keeps every npm package external. That is what makes it fast:
 * esbuild only has to parse our own sources, and nothing has to inline wasm. Node then
 * runs plain JavaScript with no loader hook.
 *
 * Workspace packages (`@lody/shared` etc.) publish raw `.ts` entries, so they MUST be
 * bundled rather than externalized — that is what `bundleTypeScriptWorkspaceSources`
 * decides, by extension of the resolved path rather than a hand-maintained package list.
 *
 * NOT fixed by this: the watch worker's ~690MB RSS, which trips its own 256MB recycle
 * budget every ~30s. That growth is `fs.watch(root, {recursive: true})` over trees that
 * include `node_modules` — a single root takes a freshly spawned worker from 62MB to
 * 415MB in 20s regardless of how it was loaded. The fix there is excluding
 * `node_modules`/`.git` from the watch, not the module loader.
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import { copyDeepSeekPresets } from './copy-deepseek-presets.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, '..');
const sourceDirectory = path.join(packageDirectory, 'src');

export const DEV_BUILD_DIR_NAME = 'dist-dev';
export const devBuildDirectory = path.join(packageDirectory, DEV_BUILD_DIR_NAME);

/**
 * Mirrors `vite.config.ts`'s `rollupOptions.input`. `index.js` is the CLI entry;
 * the sibling `*-acp.js` / `*-worker.js` files are resolved by filename next to
 * the running entry (`agent/setting.ts`, the Tinypool pools, and
 * `workspace-watch-coordinator.ts`), so they have to stay flat siblings here too.
 */
const entryPoints = {
  index: path.join(sourceDirectory, 'index.ts'),
  'cloudflared-worker': path.join(sourceDirectory, 'preview/cloudflared-worker.ts'),
  'baguette-worker': path.join(sourceDirectory, 'ios-simulator/baguette-worker.ts'),
  'codex-acp': path.join(sourceDirectory, 'codex-acp-entry.ts'),
  'claude-acp': path.join(sourceDirectory, 'claude-acp-entry.ts'),
  'deepseek-acp': path.join(sourceDirectory, 'deepseek-acp-entry.ts'),
  'devin-acp': path.join(sourceDirectory, 'devin-acp-entry.ts'),
  'grok-acp': path.join(sourceDirectory, 'grok-acp-entry.ts'),
  'diff-worker': path.join(sourceDirectory, 'lib/code-collab/diff-worker.ts'),
  'file-index-scan-worker': path.join(sourceDirectory, 'lib/code-collab/file-index-scan-worker.ts'),
  'turn-diff-store-worker': path.join(sourceDirectory, 'lib/code-collab/turn-diff-store-worker.ts'),
  'code-collab-watch-worker': path.join(
    sourceDirectory,
    'lib/code-collab/workspace-watch-worker.ts'
  ),
};

const isBareSpecifier = (specifier) =>
  !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('\0');

/**
 * The tsconfig path mappings, resolved here rather than through esbuild's `alias`
 * option: `alias` also matches on path prefix, so a bare `@` entry swallows
 * `@/pkg` and silently resolves it to `src/pkg`. Longest-prefix-first ordering is
 * the whole point, so it has to be explicit.
 */
const resolveTsconfigPathMapping = (specifier) => {
  if (specifier === '@/pkg') {
    return path.join(packageDirectory, 'package.json');
  }
  if (specifier.startsWith('@/')) {
    return path.join(sourceDirectory, specifier.slice('@/'.length));
  }
  if (specifier === 'src' || specifier.startsWith('src/')) {
    return path.join(sourceDirectory, specifier.slice('src'.length));
  }
  return null;
};

/**
 * Externalize real npm packages, bundle workspace packages that ship TypeScript.
 *
 * Deciding by resolved extension keeps this correct as workspace packages come
 * and go: anything Node could not `import` on its own (a `.ts`/`.tsx` entry) has
 * to be inlined, everything else is cheaper left on disk.
 */
const bundleTypeScriptWorkspaceSources = (deferredSpecifiers) => ({
  name: 'bundle-typescript-workspace-sources',
  setup(pluginBuild) {
    // Every `pluginBuild.resolve` is an IPC round-trip to the esbuild binary, and the
    // same handful of packages is imported from hundreds of files. Caching per
    // (specifier, resolveDir) is what keeps this plugin from dominating build time.
    const resolutionCache = new Map();
    pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.resolvedByDevBuild || !isBareSpecifier(args.path)) {
        return null;
      }
      const cacheKey = `${args.path}\0${args.resolveDir}`;
      const cached = resolutionCache.get(cacheKey);
      if (cached) {
        return await cached;
      }
      const pending = resolveBareSpecifier(pluginBuild, args, deferredSpecifiers);
      resolutionCache.set(cacheKey, pending);
      return await pending;
    });
  },
});

async function resolveBareSpecifier(pluginBuild, args, deferredSpecifiers) {
  if (args.path.endsWith('.node')) {
    return { path: args.path, external: true };
  }
  const mapped = resolveTsconfigPathMapping(args.path);
  if (mapped) {
    // Route back through esbuild so extensionless mappings still pick up
    // `.ts` / `.tsx` / `/index.ts`.
    return await pluginBuild.resolve(`./${path.basename(mapped)}`, {
      importer: args.importer,
      kind: args.kind,
      resolveDir: path.dirname(mapped),
      pluginData: { resolvedByDevBuild: true },
    });
  }
  const resolved = await pluginBuild.resolve(args.path, {
    importer: args.importer,
    kind: args.kind,
    resolveDir: args.resolveDir,
    pluginData: { resolvedByDevBuild: true },
  });
  if (resolved.errors.length > 0 || !resolved.path) {
    // Some specifiers only exist after a sibling package's own build (the generated
    // `lody-code-review-viewer/manifest` and `@lody/code-review-helper/prompt-text`,
    // plus adapter `dist/` output in a fresh checkout). jiti resolved those lazily at
    // first use, so a dev build must not turn them into a hard startup failure. Defer
    // to Node: it reports the real error at the point of use, exactly as before.
    deferredSpecifiers.add(args.path);
    return { path: args.path, external: true };
  }
  if (/\.[cm]?tsx?$/.test(resolved.path)) {
    return resolved;
  }
  // Externalize by ABSOLUTE path, not by the bare specifier. Bundling a workspace
  // package's TypeScript source moves its imports into this bundle, and under pnpm's
  // strict layout `apps/cli/node_modules` has no entry for that package's own
  // transitive dependencies — a bare `@loro-dev/streams-client` resolves at build time
  // and then fails at runtime. Node imports absolute paths fine, and dist-dev is
  // per-machine dev output, so this costs nothing.
  return { path: resolved.path, external: true };
}

/** @returns {import('esbuild').BuildOptions} */
export function createDevBuildOptions(deferredSpecifiers = new Set()) {
  return {
    entryPoints,
    outdir: devBuildDirectory,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Without splitting, esbuild inlines `await import(...)` targets into the
    // importing bundle, which hoists their static imports to load time. `lody
    // review` depends on that laziness: `review-viewer.ts` statically imports the
    // generated `lody-code-review-viewer/manifest`, which does not exist until that
    // package is built. Real chunks keep the lazy boundary jiti had.
    splitting: true,
    // Shared application modules still resolve child entries beside themselves.
    chunkNames: '[name]-[hash]',
    // Cheap to produce and Node reads them with `--enable-source-maps`, which the
    // dev runner turns on — a dev build with unmapped stack traces is a downgrade.
    sourcemap: true,
    logLevel: 'warning',
    logOverride: {
      // The CLI legitimately has top-level awaits in ESM entries.
      'empty-import-meta': 'silent',
    },
    // Keep the two `ws` opt-outs the production build inlines so dev and prod
    // agree on which optional native ws addons are skipped.
    define: {
      'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('true'),
      'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('true'),
    },
    plugins: [
      {
        name: 'raw-text',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
            namespace: 'raw-text',
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
            contents: await readFile(args.path, 'utf8'),
            loader: 'text',
            watchFiles: [args.path],
          }));
        },
      },
      bundleTypeScriptWorkspaceSources(deferredSpecifiers),
    ],
  };
}

/**
 * The pools and the watch coordinator locate their child entry as a filename next
 * to `import.meta.url`. With code splitting on, that only holds while the module
 * doing the lookup is emitted at the output root — if esbuild ever hoists one into
 * `chunks/`, its `MODULE_DIR` becomes `chunks/` and the child silently disappears
 * into the main-thread fallback (`reason=worker_missing`) or make a mandatory worker
 * unavailable. That failure mode is invisible at build time and costs a lot at runtime,
 * so assert the layout instead of trusting it.
 */
async function assertChildEntriesResolveFromTheirLookupSite() {
  const childEntryFileNames = Object.keys(entryPoints)
    .filter((name) => name !== 'index')
    .map((name) => `${name}.js`);
  const chunkDirectory = path.join(devBuildDirectory, 'chunks');
  let chunkFileNames = [];
  try {
    chunkFileNames = (await readdir(chunkDirectory)).filter((name) => name.endsWith('.js'));
  } catch {
    return;
  }
  const offenders = [];
  for (const chunkFileName of chunkFileNames) {
    const contents = await readFile(path.join(chunkDirectory, chunkFileName), 'utf8');
    for (const childEntryFileName of childEntryFileNames) {
      if (
        contents.includes(`"${childEntryFileName}"`) ||
        contents.includes(`'${childEntryFileName}'`)
      ) {
        offenders.push(`chunks/${chunkFileName} -> ${childEntryFileName}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `[lody dev] child-entry lookup moved into a split chunk, so it would resolve against ` +
        `chunks/ instead of ${DEV_BUILD_DIR_NAME}/:\n  ${offenders.join('\n  ')}\n` +
        `Give the offending module its own entry point, or resolve the child relative to the ` +
        `CLI entry rather than the calling module.`
    );
  }
}

export async function runDevBuild({ clean = false, watch = false } = {}) {
  if (clean) {
    await rm(devBuildDirectory, { recursive: true, force: true });
  }
  const deferredSpecifiers = new Set();
  const options = createDevBuildOptions(deferredSpecifiers);
  const startedAtMs = Date.now();
  let buildContext;
  if (watch) {
    buildContext = await context(options);
    await buildContext.rebuild();
    await buildContext.watch();
  } else {
    await build(options);
  }
  await copyDeepSeekPresets(devBuildDirectory);
  await assertChildEntriesResolveFromTheirLookupSite();
  return { durationMs: Date.now() - startedAtMs, deferredSpecifiers, context: buildContext };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const clean = process.argv.includes('--clean');
  const watch = process.argv.includes('--watch');
  const { durationMs, deferredSpecifiers } = await runDevBuild({ clean, watch });
  console.error(`[lody dev] built ${DEV_BUILD_DIR_NAME} in ${durationMs}ms`);
  if (deferredSpecifiers.size > 0) {
    console.error(
      `[lody dev] left unresolved for Node to load at first use: ${[...deferredSpecifiers]
        .sort()
        .join(', ')}`
    );
  }
  if (!watch) {
    process.exit(0);
  }
  console.error('[lody dev] watching for changes');
}
