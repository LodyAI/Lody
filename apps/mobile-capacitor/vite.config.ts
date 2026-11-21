import { resolveSessionShareOrigin } from '../../scripts/session-share-origin.mjs';
import { defineConfig, loadEnv } from 'vite';
// Keep function/class declaration semantics when the TLA transform wraps the
// shared app chunk. The upstream transform can otherwise initialize exported
// functions after their first use (for example d3-color's color factory).
import topLevelAwait from '../../packages/components/vite-top-level-await-fixed';
import tsconfigPaths from 'vite-tsconfig-paths';
import wasm from 'vite-plugin-wasm';
import tailwindcss from '@tailwindcss/vite';
import stylex from '@stylexjs/unplugin';
import { stylexOptions } from '../../packages/ui/stylex-options';
import { execSync } from 'child_process';
import {
  loroCrdtBundlerAlias,
  loroCrdtWasmUrlWorkaround,
} from '../../packages/components/vite-wasm-workarounds';
import { emojibaseAssetsPlugin } from '../../packages/components/vite-emojibase-assets';
import { vibeloftTelemetryPlugin } from '../../packages/components/vite-vibeloft-telemetry';
import { mobileWorkerPolyfills } from './vite-worker-polyfills';
import { diffCssCompatPlugin } from './vite-diff-css-compat';
import { preservePdfWorkerExports } from '../../packages/components/vite-pdf-worker';
import { pdfAbortCompatPlugin } from './vite-pdf-abort-compat';

// Get git commit hash (first 8 hex characters = 4 bytes)
function getGitCommitHash(): string {
  try {
    return execSync('git rev-parse HEAD').toString().trim().slice(0, 8);
  } catch {
    return 'unknown';
  }
}

function getMobileRuntimeEnv(mode: string): Record<string, string | undefined> {
  const runtimeEnv = { ...loadEnv(mode, __dirname, ''), ...process.env };
  const requestedPlatform = runtimeEnv.VITE_LODY_PLATFORM?.trim();
  if (requestedPlatform && requestedPlatform !== 'cloud') {
    throw new Error(
      `Mobile cloud runtime cannot use VITE_LODY_PLATFORM=${JSON.stringify(requestedPlatform)}`
    );
  }
  runtimeEnv.VITE_LODY_PLATFORM = 'cloud';
  return runtimeEnv;
}

export default defineConfig(({ mode }) => {
  const runtimeEnv = getMobileRuntimeEnv(mode);

  return {
    root: './src',
    envDir: '..',
    // Absolute base so hashed asset URLs always resolve from capacitor://localhost/assets/
    // regardless of the current SPA route. Rejected: base './' (relative) — after a long
    // background iOS reloads the WebView at the deep route (capacitor://localhost/<workspace>/…),
    // and relative './assets/*' then resolves under that route's dir (/<workspace>/assets/*),
    // which has no files → "failed to load resource … doesn't exist" and a white screen.
    base: '/',
    define: {
      'import.meta.env.VITE_LODY_PLATFORM': JSON.stringify('cloud'),
      'import.meta.env.VITE_SESSION_SHARE_ORIGIN': JSON.stringify(
        resolveSessionShareOrigin(runtimeEnv)
      ),
      __DESKTOP_RELEASE_CHANNEL__: JSON.stringify(
        runtimeEnv.LODY_NIGHTLY_VERSION
          ? 'nightly'
          : runtimeEnv.LODY_ENV === 'staging'
            ? 'staging'
            : 'stable'
      ),
      __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
      __GIT_COMMIT__: JSON.stringify(getGitCommitHash()),
    },
    resolve: {
      alias: [
        ...loroCrdtBundlerAlias(),
        {
          find: /^@\/components\/settings\/account-setting$/,
          replacement: `${__dirname}/src/recovery/recovery-account-setting.tsx`,
        },
        ...(process.env.LODY_MOBILE_NIGHTLY_ICON === '1'
          ? [
              {
                find: './assets/app-icon-default.png',
                replacement: `${__dirname}/src/assets/app-icon-nightly.png`,
              },
            ]
          : []),
      ],
    },
    // Tailwind via Vite plugin so @fontsource url() assets emit.
    plugins: [
      mobileWorkerPolyfills(),
      diffCssCompatPlugin(),
      pdfAbortCompatPlugin(),
      tailwindcss(),
      stylex.vite(stylexOptions),
      tsconfigPaths(),
      // frimousse constructs these JSON URLs at runtime, so Capacitor builds
      // must ship the same bundled dataset as the other app hosts.
      emojibaseAssetsPlugin(),
      vibeloftTelemetryPlugin(),
      loroCrdtWasmUrlWorkaround(),
      wasm(),
      topLevelAwait(),
    ],
    worker: {
      format: 'es',
      // Worker builds have a separate plugin pipeline. Code Collab workers import
      // `loro-crdt`, so they need the same WASM handling as the app bundle.
      plugins: () => [
        preservePdfWorkerExports(),
        mobileWorkerPolyfills(true),
        pdfAbortCompatPlugin(),
        loroCrdtWasmUrlWorkaround(),
        wasm(),
        topLevelAwait(),
      ],
    },
    build: {
      outDir: '../dist',
      // iOS/iPadOS WKWebView floor; runtime APIs are handled by polyfills.ts.
      // Keep the existing Android/browser syntax targets independently.
      target: ['es2020', 'safari16.4', 'chrome80', 'firefox78', 'edge80'],
      cssTarget: ['safari16.4', 'chrome80'],
      // CSS lowering runs in Vite's CSS minifier. JS stays unminified, but
      // disabling CSS minification too would leave PDF/Monaco nesting intact.
      cssMinify: 'lightningcss',
      minify: false,
      emptyOutDir: true,
    },
  };
});
