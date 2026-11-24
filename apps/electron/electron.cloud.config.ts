import { isLoroStreamsWebSocketEnabled } from '../../packages/shared/src/loro-streams-websocket'
import { resolveSessionShareOrigin } from '../../scripts/session-share-origin.mjs'
import { preservePdfWorkerExports } from '../../packages/components/vite-pdf-worker'

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { resolve } from 'node:path'
import { searchForWorkspaceRoot } from 'vite'
import type { UserConfig } from 'electron-vite'
import { bootShellPlugin } from '../../packages/components/vite-boot-shell'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import stylex from '@stylexjs/unplugin'
import { componentsStylexOptions } from '../../packages/components/stylex-options'
import {
  loroCrdtBundlerAlias,
  loroCrdtWasmUrlWorkaround
} from '../../packages/components/vite-wasm-workarounds'
import { mermaidLazyBoundaryGuardPlugin } from '../../packages/components/vite-mermaid-lazy-boundary-guard'
import {
  isMermaidRuntimeDependency,
  rendererBundleAliases
} from '../../packages/components/vite-renderer-bundle-aliases'
import { emojibaseAssetsPlugin } from '../../packages/components/vite-emojibase-assets'
import { cloudRendererCspHtmlPlugin } from './renderer-csp'
import { resolveCloudElectronUpdateConfig } from './sparkle-packaging.mjs'
import { resolveElectronReleaseProfile } from './release-profile.mjs'

const electronDir = __dirname
const electronWorkspaceDeps = Object.keys(
  (
    JSON.parse(fs.readFileSync(resolve(electronDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
  ).dependencies ?? {}
).filter((dep) => dep.startsWith('@lody/'))
const componentsDir = resolve(__dirname, '../../packages/components')
const repoRoot = resolve(__dirname, '../..')

function getGitCommitHash(): string {
  try {
    return execSync('git rev-parse HEAD').toString().trim().slice(0, 8)
  } catch {
    return 'unknown'
  }
}

function getAppVersion(): string {
  return JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version
}

function loadBuildEnv(buildMode: string): Record<string, string> {
  if (!['production', 'staging'].includes(buildMode))
    throw new Error('Cloud Electron requires production or staging mode')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith('VITE_') && typeof entry[1] === 'string'
    )
  )
  for (const key of [
    'VITE_CONVEX_DEPLOY_URL',
    'VITE_CONVEX_SITE_URL',
    'VITE_SERVER_URL',
    'VITE_SITE_URL'
  ]) {
    if (!env[key]?.trim()) throw new Error(`Cloud Electron requires ${key}`)
  }
  env.VITE_LODY_PLATFORM = 'cloud'
  const streamsWebSocket =
    process.env.LODY_LORO_STREAMS_WS_ENABLED ?? env.VITE_LORO_STREAMS_WS_ENABLED
  env.VITE_LORO_STREAMS_WS_ENABLED = isLoroStreamsWebSocketEnabled(undefined, streamsWebSocket)
    ? '1'
    : '0'
  return env
}

function applyEnvToProcess(env: Record<string, string>): void {
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

export default function cloudConfig({ mode }: { command: string; mode: string }): UserConfig {
  const envDir = false
  const envPrefix = '__LodyBuildOnlyPrefix__'
  const buildMode = mode === 'oss' || !mode ? process.env.LODY_ENV || 'production' : mode
  const buildEnv = loadBuildEnv(buildMode)
  const releaseProfile = resolveElectronReleaseProfile({
    environment: buildMode === 'staging' ? 'staging' : 'production',
    baseVersion: getAppVersion()
  })
  const buildDate = releaseProfile.builtAt ?? new Date().toISOString()
  const gitCommit = releaseProfile.sourceSha ?? getGitCommitHash()
  const declaredEnvironment = (buildEnv.VITE_LODY_ENV || process.env.LODY_ENV)?.trim()
  if (declaredEnvironment && declaredEnvironment !== buildMode) {
    throw new Error(
      `Electron Vite mode selects ${buildMode} but the environment selects ${declaredEnvironment}`
    )
  }
  const electronUpdateConfig = resolveCloudElectronUpdateConfig({
    environment: buildMode,
    releaseChannel: releaseProfile.channel,
    updateBaseUrl: buildEnv.VITE_ELECTRON_UPDATE_URL,
    configuredChannel: buildEnv.VITE_ELECTRON_UPDATE_CHANNEL
  })
  buildEnv.VITE_ELECTRON_UPDATE_URL = electronUpdateConfig.url
  buildEnv.VITE_ELECTRON_UPDATE_CHANNEL = electronUpdateConfig.channel
  const runtimeEnv = buildEnv
  const requestedPlatform = runtimeEnv.VITE_LODY_PLATFORM?.trim()
  if (requestedPlatform && requestedPlatform !== 'cloud') {
    throw new Error(
      `Electron cloud runtime cannot use VITE_LODY_PLATFORM=${JSON.stringify(requestedPlatform)}`
    )
  }
  runtimeEnv.VITE_LODY_PLATFORM = 'cloud'
  const viteEnvDefine = {
    __LODY_E2E_CLOCK_BUILD__: 'false',
    ...buildViteEnvDefine(buildEnv),
    'import.meta.env.VITE_SESSION_SHARE_ORIGIN': JSON.stringify(
      resolveSessionShareOrigin(runtimeEnv)
    ),
    'import.meta.env.VITE_LODY_PLATFORM': JSON.stringify('cloud'),
    'import.meta.env.VITE_LODY_RELEASE_CHANNEL': JSON.stringify(releaseProfile.channel)
  }

  {
    applyEnvToProcess(buildEnv)
  }

  return {
    main: {
      root: electronDir,
      resolve: {
        alias:
          releaseProfile.channel === 'nightly'
            ? ['../../resources/icon.png?asset', '../../build/icon-mac.padded.png?asset'].map(
                (find) => ({
                  find,
                  replacement: `${resolve(electronDir, 'resources/icon-nightly.png')}?asset`
                })
              )
            : []
      },
      envDir,
      envPrefix,
      define: {
        ...viteEnvDefine,
        __LODY_DESKTOP_BUILD_JSON__: JSON.stringify(JSON.stringify(releaseProfile))
      },
      plugins: electronUpdateConfig
        ? [
            {
              name: 'lody-electron-update-config-manifest',
              writeBundle() {
                fs.writeFileSync(
                  resolve(electronDir, 'out/main/electron-update-config.json'),
                  `${JSON.stringify({ ...electronUpdateConfig, releaseProfile }, null, 2)}\n`,
                  'utf8'
                )
              }
            }
          ]
        : undefined,
      build: {
        outDir: resolve(electronDir, 'out/main'),
        lib: {
          entry: fs.existsSync(resolve(electronDir, 'src/main/native-storage-smoke.mts'))
            ? {
                index: resolve(electronDir, 'src/main/index.ts'),
                'native-storage-smoke': resolve(electronDir, 'src/main/native-storage-smoke.mts')
              }
            : resolve(electronDir, 'src/main/index.ts'),
          formats: ['cjs']
        },
        externalizeDeps: {
          exclude: [
            ...new Set([
              '@devframes/agentic',
              '@devframes/hub',
              '@devframes/json-render',
              '@lody/cli-supervisor',
              '@lody/shared',
              'devframe',
              'effect',
              ...electronWorkspaceDeps
            ])
          ],
          include: [
            'better-sqlite3',
            '@devframes/hub-ui',
            '@devframes/json-render-ui',
            '@devframes/plugin-a11y',
            '@devframes/plugin-inspect',
            '@devframes/plugin-terminals'
          ]
        }
      }
    },
    preload: {
      root: electronDir,
      envDir,
      envPrefix,
      define: viteEnvDefine,
      build: {
        outDir: resolve(electronDir, 'out/preload'),
        lib: {
          entry: resolve(electronDir, 'src/preload/index.ts'),
          formats: ['cjs']
        },
        externalizeDeps: {
          exclude: [...new Set(['@lody/shared', ...electronWorkspaceDeps])]
        }
      }
    },
    renderer: {
      root: resolve(electronDir, 'src/renderer'),
      envDir,
      envPrefix,
      define: {
        ...viteEnvDefine,
        __BUILD_DATE__: JSON.stringify(buildDate),
        __GIT_COMMIT__: JSON.stringify(gitCommit),
        __APP_VERSION__: JSON.stringify(releaseProfile.version),
        __DESKTOP_RELEASE_CHANNEL__: JSON.stringify(releaseProfile.channel),
        __OSS_GIT_COMMIT__: JSON.stringify(releaseProfile.sourceSha ?? null)
      },
      resolve: {
        dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'convex'],
        alias: [
          ...loroCrdtBundlerAlias(),
          ...rendererBundleAliases(),
          {
            find: '@renderer',
            replacement: resolve(electronDir, 'src/renderer/src')
          },
          {
            find: '@lody/components',
            replacement: resolve(componentsDir, 'src')
          },
          {
            find: '@/',
            replacement: `${resolve(componentsDir, 'src')}/`
          }
        ]
      },
      worker: {
        format: 'es',
        plugins: () => [preservePdfWorkerExports(), loroCrdtWasmUrlWorkaround(), wasm()]
      },
      optimizeDeps: {
        exclude: ['@loro-dev/streams-crdt', '@loro-dev/streams-crdt/zstd']
      },
      server: {
        host: process.env.LODY_ELECTRON_RENDERER_HOST || '127.0.0.1',
        port: Number(process.env.LODY_ELECTRON_RENDERER_PORT) || undefined,
        strictPort: Boolean(process.env.LODY_ELECTRON_RENDERER_PORT),
        fs: {
          allow: [searchForWorkspaceRoot(electronDir), resolve(repoRoot, 'node_modules')]
        }
      },
      build: {
        outDir: resolve(electronDir, 'out/renderer'),
        emptyOutDir: true,
        minify: 'esbuild',
        sourcemap: false,
        rollupOptions: {
          input: {
            index: resolve(electronDir, 'src/renderer/index.html'),
            devbar: resolve(electronDir, 'src/renderer/devbar.html'),
            recovery: resolve(electronDir, 'src/renderer/recovery.html'),
            prImage: resolve(electronDir, 'src/renderer/pr-image.html')
          },
          output: {
            onlyExplicitManualChunks: true,
            manualChunks(id) {
              if (isMermaidRuntimeDependency(id)) {
                return 'mermaid-deps'
              }
              return undefined
            }
          }
        }
      },
      plugins: [
        cloudRendererCspHtmlPlugin({
          env: runtimeEnv
        }),
        stylex.vite(componentsStylexOptions),
        loroCrdtWasmUrlWorkaround(),
        react(),
        wasm(),
        emojibaseAssetsPlugin(),
        mermaidLazyBoundaryGuardPlugin(),
        bootShellPlugin()
      ]
    }
  }
}
