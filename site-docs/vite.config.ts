import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import mdx from 'fumadocs-mdx/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeRequest, sendNodeResponse } from 'srvx/node';
import type { DevEnvironment, Plugin, RunnableDevEnvironment } from 'vite';
import { defineConfig } from 'vite';
import { resolveModulePreloadDependencies } from './lib/module-preload';
import { collectSitePaths } from './scripts/site-paths.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const siteSrc = dirname;

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
  // Base UI and TanStack Router import the CJS `use-sync-external-store` shims;
  // serve React 19's built-in hook as ESM instead.
  {
    find: /^use-sync-external-store\/shim(?:\/index\.js)?$/,
    replacement: path.resolve(dirname, 'lib/use-sync-external-store-shim.ts'),
  },
  {
    find: /^use-sync-external-store\/shim\/with-selector(?:\.js)?$/,
    replacement: path.resolve(dirname, 'lib/use-sync-external-store-with-selector-shim.ts'),
  },
  { find: '@site', replacement: siteSrc },
];

export default defineConfig({
  server: {
    port: 3002,
  },
  resolve: {
    alias,
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'next-themes'],
    tsconfigPaths: true,
  },
  plugins: [
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
    // Bundle React-peer packages into the SSR build so they render with the
    // same React instance as the app.
    noExternal: [
      '@tanstack/router-core',
      'next-themes',
      '@number-flow/react',
      /^@number-flow\//,
      /^@radix-ui\//,
      /^@floating-ui\//,
    ],
  },
  optimizeDeps: {
    include: ['next-themes', '@number-flow/react'],
  },
  build: {
    outDir: 'out',
    emptyOutDir: true,
    // HTML hosts: do not modulepreload every route chunk. JS hosts keep
    // the lazy-import graph, including extracted route CSS, so client
    // navigation to /price or legal pages is not unstyled. Post-prerender
    // HTML finalize strips any leftover HTML preloads TanStack injects.
    modulePreload: {
      polyfill: false,
      resolveDependencies: resolveModulePreloadDependencies,
    },
  },
});
