import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import mdx from 'fumadocs-mdx/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeRequest, sendNodeResponse } from 'srvx/node';
import type { DevEnvironment, Plugin, RunnableDevEnvironment } from 'vite';
import { defineConfig } from 'vite';
import { collectSitePaths } from './scripts/site-paths.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const componentsSrc = path.resolve(dirname, '../packages/components/src');
const siteSrc = dirname;
const loroCrdtBrowserEntry = path.resolve(
  componentsSrc,
  '../node_modules/loro-crdt/browser/index.js'
);

/**
 * packages/components peers React 18 for the product app. Landing imports its
 * source via `@/*`; a normal resolve walk from that tree can load react@18 +
 * react-i18next(react18) while the SSR renderer is react@19 → invalid hooks.
 *
 * Force listed packages (and their subpaths) to resolve as if imported from
 * site-docs — keeps Vite's package/CJS interop intact (unlike hard-aliasing
 * to package roots, which breaks `module is not defined` on react/index.js).
 */
const SINGLETON_DEPS = [
  'react',
  'react-dom',
  'i18next',
  'react-i18next',
  'next-themes',
  'jotai',
] as const;

function forceSingletonDeps(): Plugin {
  const importer = path.join(dirname, 'package.json');
  return {
    name: 'site-docs-force-singleton-deps',
    enforce: 'pre',
    async resolveId(source, _importer, options) {
      const hit = SINGLETON_DEPS.some((dep) => source === dep || source.startsWith(`${dep}/`));
      if (!hit) return null;
      return this.resolve(source, importer, { ...options, skipSelf: true });
    },
  };
}

/**
 * `loro-crdt` exposes a bundler entry for development, but Vite's source
 * module graph can evaluate its Wasm glue twice. The browser entry owns a
 * single glue instance and loads the Wasm file explicitly. Keep SSR on its
 * normal entry because the browser build relies on XMLHttpRequest.
 */
function createBrowserLoroBuildForClientPlugin(): Plugin {
  return {
    name: 'site-docs-client-loro-browser-build',
    enforce: 'pre',
    resolveId(source, _importer, options) {
      if (source === 'loro-crdt' && !options?.ssr) return loroCrdtBrowserEntry;
      return null;
    },
  };
}

const isStructurallyRunnableEnvironment = (
  environment: DevEnvironment | undefined
): environment is RunnableDevEnvironment => environment !== undefined && 'runner' in environment;

/**
 * TanStack Start normally adds this handler itself. In this workspace pnpm
 * loads its Vite helper through a different module instance, so its
 * `isRunnableDevEnvironment` check fails and it never registers the handler.
 * Registering it against this app's Vite instance keeps dev SSR working; when
 * the upstream plugin does register first, this middleware is never reached.
 */
function installStartDevServerMiddleware(): Plugin {
  return {
    name: 'site-docs-start-dev-server-middleware',
    configureServer(viteDevServer) {
      return () => {
        const ssrEnvironment = viteDevServer.environments.ssr;
        if (!isStructurallyRunnableEnvironment(ssrEnvironment)) {
          throw new Error('TanStack Start SSR environment is unavailable.');
        }

        viteDevServer.middlewares.use((req, res, next) => {
          if (res.writableEnded) return;
          if (req.originalUrl) req.url = req.originalUrl;

          void (async () => {
            const serverEntry = await ssrEnvironment.runner.import(
              'virtual:tanstack-start-server-entry'
            );
            const response = await serverEntry.default.fetch(new NodeRequest({ req, res }));
            return sendNodeResponse(res, response);
          })().catch(next);
        });
      };
    },
  };
}

const alias = [
  {
    find: '@/components/chat/chat-landing-selectors',
    replacement: path.resolve(
      dirname,
      'components/app-preview-shims/chat-landing-selectors-shim.tsx'
    ),
  },
  {
    find: '@/components/mentions/combined-mention-textarea',
    replacement: path.resolve(
      dirname,
      'components/app-preview-shims/combined-mention-textarea-shim.tsx'
    ),
  },
  {
    find: '@/hooks/use-online-machines',
    replacement: path.resolve(dirname, 'components/app-preview-shims/use-online-machines-shim.ts'),
  },
  {
    find: '@/lib/native-platform',
    replacement: path.resolve(dirname, 'components/app-preview-shims/native-platform-shim.ts'),
  },
  {
    find: '@/ui/diff-viewer/diff-render-worker',
    replacement: path.resolve(dirname, 'components/app-preview-shims/diff-render-worker-shim.ts'),
  },
  {
    find: '@/lib/diff-parse-worker',
    replacement: path.resolve(dirname, 'components/app-preview-shims/diff-parse-worker-shim.ts'),
  },
  {
    find: '@/ui/diff-viewer/diff-viewer-lazy',
    replacement: path.resolve(dirname, 'components/app-preview-shims/diff-viewer-lazy-shim.tsx'),
  },
  {
    find: '@/lib/session-image-cache',
    replacement: path.resolve(dirname, 'components/app-preview-shims/session-image-cache-shim.ts'),
  },
  {
    find: '@/lib/session-file-download',
    replacement: path.resolve(
      dirname,
      'components/app-preview-shims/session-file-download-shim.ts'
    ),
  },
  {
    find: '@/lib/vscode-theme',
    replacement: path.resolve(dirname, 'components/app-preview-shims/vscode-theme-shim.ts'),
  },
  {
    find: /^use-sync-external-store\/shim(?:\/index\.js)?$/,
    replacement: path.resolve(
      dirname,
      'components/app-preview-shims/use-sync-external-store-shim.ts'
    ),
  },
  {
    find: /^use-sync-external-store\/shim\/with-selector(?:\.js)?$/,
    replacement: path.resolve(
      dirname,
      'components/app-preview-shims/use-sync-external-store-with-selector-shim.ts'
    ),
  },
  { find: '@site', replacement: siteSrc },
  { find: '@', replacement: componentsSrc },
];

export default defineConfig({
  server: {
    port: 3002,
    fs: {
      // The workspace's single pnpm store lives above `lody-oss`. Loro's Wasm
      // sidecar must be served from that store when the landing preview imports
      // product components.
      allow: [path.resolve(dirname, '../..')],
    },
  },
  resolve: {
    alias,
    dedupe: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'i18next',
      'react-i18next',
      'next-themes',
      'jotai',
    ],
    tsconfigPaths: true,
  },
  plugins: [
    forceSingletonDeps(),
    createBrowserLoroBuildForClientPlugin(),
    tanstackStart({
      prerender: {
        enabled: true,
        autoStaticPathsDiscovery: false,
        crawlLinks: false,
        failOnError: true,
      },
      pages: collectSitePaths(dirname).map((sitePath) => ({
        path: sitePath,
        prerender:
          sitePath === '/404'
            ? { enabled: true, outputPath: '/404.html', autoSubfolderIndex: false }
            : { enabled: true },
      })),
    }),
    installStartDevServerMiddleware(),
    mdx(),
    tailwindcss(),
    react(),
  ],
  ssr: {
    // Bundle packages that peer React so SSR never `require()`s the React 18
    // copies nested under packages/components (invalid hooks / dual dispatcher).
    noExternal: [
      '@tanstack/router-core',
      'next-themes',
      'react-i18next',
      'i18next',
      '@number-flow/react',
      /^@number-flow\//,
      /^@radix-ui\//,
      /^@floating-ui\//,
      'jotai',
    ],
    // CJS packages that appear on the landing preview graph. Keep named-export
    // failures from breaking TanStack Start's module runner during prerender.
    optimizeDeps: {
      include: ['debug'],
    },
  },
  optimizeDeps: {
    // Do not flatten loro-mirror ahead of resolution: its pre-bundle follows
    // its peer dependency directly to Loro's development bundler entry.
    exclude: ['loro-mirror', 'loro-crdt'],
    include: ['debug', 'next-themes', 'react-i18next', 'i18next', '@number-flow/react'],
  },
  build: {
    outDir: 'out',
    emptyOutDir: true,
  },
});
