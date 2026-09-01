import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import wasm from 'vite-plugin-wasm'
import tailwindcss from '@tailwindcss/vite'
import {
  loroCrdtBundlerAlias,
  loroCrdtWasmUrlWorkaround
} from '../../packages/components/vite-wasm-workarounds'
import { injectPreviewPublicBaseDomain } from '../../scripts/preview-public-base-domain.mjs'
import { mermaidLazyBoundaryGuardPlugin } from '../../packages/components/vite-mermaid-lazy-boundary-guard'
import {
  isMermaidRuntimeDependency,
  rendererBundleAliasPlugin,
  rendererBundleAliases
} from '../../packages/components/vite-renderer-bundle-aliases'
import { emojibaseAssetsPlugin } from '../../packages/components/vite-emojibase-assets'

function getGitCommitHash(): string {
  try {
    return execSync('git rev-parse HEAD').toString().trim().slice(0, 8)
  } catch {
    return 'unknown'
  }
}

function getAppVersion(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
      version?: string
    }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const OSS_BUILD_MODE = 'oss'
const OSS_BUILD_ENV: Record<string, string> = {
  VITE_LODY_PLATFORM: 'local',
  VITE_PREVIEW_PUBLIC_BASE_DOMAIN: 'local.invalid'
}

function applyEnvToProcess(env: Record<string, string>): void {
  // Bun may pre-inject local .env values into process.env. Reset VITE_* first.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VITE_')) {
      delete process.env[key]
    }
  }

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
}

function buildViteEnvDefine(env: Record<string, string>): Record<string, string> {
  const define: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('VITE_')) continue
    define[`import.meta.env.${key}`] = JSON.stringify(value)
  }
  return define
}

function previewPublicBaseDomainHtmlPlugin(baseDomain: string): Plugin {
  return {
    name: 'lody-preview-public-base-domain-html',
    enforce: 'pre',
    transformIndexHtml(html) {
      return injectPreviewPublicBaseDomain(html, baseDomain)
    }
  }
}

/**
 * Test-only observability for the real Electron renderer Rollup graph. The
 * artifact is written outside the output directory so production builds never
 * ship graph metadata.
 */
function routeBundleGraphPlugin(outputPath: string): Plugin {
  return {
    name: 'lody-route-bundle-graph',
    apply: 'build',
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk')
      const graph = {
        chunks: chunks.map((chunk) => ({
          fileName: chunk.fileName,
          facadeModuleId: chunk.facadeModuleId,
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          moduleIds: chunk.moduleIds,
          rawBytes: Buffer.byteLength(chunk.code),
          gzipBytes: gzipSync(chunk.code).byteLength
        }))
      }
      fs.writeFileSync(outputPath, JSON.stringify(graph, null, 2))
    }
  }
}

export default defineConfig(({ mode }) => {
  const buildMode = mode || OSS_BUILD_MODE
  if (buildMode !== OSS_BUILD_MODE) {
    throw new Error(`The public Electron workspace only supports --mode ${OSS_BUILD_MODE}`)
  }

  const buildEnv = { ...OSS_BUILD_ENV }
  const previewPublicBaseDomain = buildEnv.VITE_PREVIEW_PUBLIC_BASE_DOMAIN
  const routeBundleGraphOutputPath = process.env.LODY_ROUTE_BUNDLE_GRAPH_PATH
  const viteEnvDefine = {
    ...buildViteEnvDefine(buildEnv),
    'import.meta.env.VITE_PREVIEW_PUBLIC_BASE_DOMAIN': JSON.stringify(previewPublicBaseDomain)
  }

  // Build and preview are deterministic: do not inherit cloud or telemetry
  // VITE_* values from a developer shell or an untracked environment file.
  applyEnvToProcess(buildEnv)

  return {
    main: {
      envDir: false,
      envPrefix: '__LodyPublicBuildOnlyPrefix__',
      define: viteEnvDefine,
      build: {
        externalizeDeps: {
          exclude: ['@lody/cli-supervisor', '@lody/shared', 'effect']
        }
      }
    },
    preload: {
      envDir: false,
      envPrefix: '__LodyPublicBuildOnlyPrefix__',
      define: viteEnvDefine,
      build: {
        externalizeDeps: {
          exclude: ['@lody/shared']
        }
      }
    },
    renderer: {
      envDir: false,
      envPrefix: '__LodyPublicBuildOnlyPrefix__',
      define: {
        ...viteEnvDefine,
        __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
        __GIT_COMMIT__: JSON.stringify(getGitCommitHash()),
        __APP_VERSION__: JSON.stringify(getAppVersion())
      },
      resolve: {
        // Monorepo + source-aliasing can cause multiple React copies (invalid hook call).
        // Force all React imports (including from workspace packages) to resolve to the renderer's React.
        // Also dedupe `convex` to ensure hooks (useQuery/useMutation/etc.) see the same provider context.
        dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'convex'],
        alias: [
          // Production browser-conditioned resolution would pick loro-crdt's
          // browser entry, which sync-compiles WASM (and trips the guard in
          // loroCrdtWasmUrlWorkaround). Force the bundler entry like web/mobile.
          ...loroCrdtBundlerAlias(),
          ...rendererBundleAliases(),
          {
            find: '@renderer',
            replacement: resolve(__dirname, 'src/renderer/src')
          },
          {
            find: '@lody/components',
            replacement: resolve(__dirname, '../../packages/components/src')
          },
          {
            find: '@/',
            replacement: `${resolve(__dirname, '../../packages/components/src')}/`
          }
        ]
      },
      worker: {
        format: 'es',
        plugins: () => [loroCrdtWasmUrlWorkaround(), wasm()]
      },
      optimizeDeps: {
        exclude: ['@loro-dev/streams-crdt', '@loro-dev/streams-crdt/zstd']
      },
      build: {
        minify: true,
        cssMinify: true,
        sourcemap: false,
        rollupOptions: {
          // Build both the main app (`index.html`) and the standalone recovery
          // page (`recovery.html`). The recovery page is loaded by the main
          // process when the main renderer fails (did-fail-load,
          // render-process-gone, preload-error) so it cannot share a bundle
          // with code paths that might themselves crash on boot.
          input: {
            index: resolve(__dirname, 'src/renderer/index.html'),
            recovery: resolve(__dirname, 'src/renderer/recovery.html')
          },
          output: {
            onlyExplicitManualChunks: true,
            manualChunks(id) {
              // Keep beautiful-mermaid (and elkjs) in the same guarded chunk.
              // Rejected: letting Rollup freely hoist these deps can mix
              // diagram-only runtime into ordinary renderer chunks.
              if (isMermaidRuntimeDependency(id)) {
                return 'mermaid-deps'
              }
              return undefined
            }
          }
        }
      },
      // Tailwind via Vite plugin so @fontsource url() assets are emitted by Vite.
      plugins: [
        previewPublicBaseDomainHtmlPlugin(previewPublicBaseDomain),
        tailwindcss(),
        loroCrdtWasmUrlWorkaround(),
        // The router is consumed from @lody/components source, so this host
        // (not the package's own Vite config) must transform route modules.
        // Keep this before React, as required by TanStack Router.
        tanstackRouter({
          target: 'react',
          autoCodeSplitting: true,
          routesDirectory: resolve(__dirname, '../../packages/components/src/routes'),
          generatedRouteTree: resolve(__dirname, '../../packages/components/src/routeTree.gen.ts')
        }),
        react(),
        wasm(),
        // The desktop app must work with no network, so the emoji picker's
        // dataset ships in the bundle instead of being fetched from a CDN.
        emojibaseAssetsPlugin(),
        rendererBundleAliasPlugin(),
        mermaidLazyBoundaryGuardPlugin(),
        ...(routeBundleGraphOutputPath ? [routeBundleGraphPlugin(routeBundleGraphOutputPath)] : [])
      ]
    }
  }
})
