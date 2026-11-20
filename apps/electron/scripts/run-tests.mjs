#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const nativeFlags = [
  '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
  '--experimental-strip-types',
  '--import',
  './scripts/node-test-ts-resolve.mjs'
]

// Each group shares transforms and module state. The two large runtime suites
// retain separate processes so their actual test work can still overlap.
export const ELECTRON_TEST_GROUPS = [
  {
    id: 'desktop',
    flags: [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--experimental-strip-types',
      '--import',
      './scripts/node-test-ts-resolve.mjs'
    ],
    files: [
      'src/devbar.test.mjs',
      'src/main/auth-storage.test.mjs',
      'src/main/renderer-process-gone.test.mjs',
      'src/main/desktop-log-core.test.mjs',
      'src/main/renderer-hang-watchdog.test.mjs',
      'src/main/close-focused-tab-or-window.test.mjs',
      'src/main/context-menu-template.test.mjs',
      'src/main/window-theme.test.mjs',
      'src/main/desktop-channel.test.mjs',
      'src/main/desktop-startup.test.mjs',
      'src/main/services/desktop-exclusion.test.mjs',
      'src/main/ipc/ipc-channel-list.test.mjs',
      'src/main/services/local-file-resource.test.mjs',
      'src/main/services/local-html-preview.test.mjs',
      'src/main/services/local-path-launcher-core.test.mjs',
      'src/main/services/notification-delivery.test.mjs',
      'src/main/services/public-browser-state.test.mjs',
      'src/main/services/app-updater-linux-install.test.mjs',
      'src/main/services/app-updater-sparkle-policy.test.mjs',
      'src/main/services/app-updater-service.test.mjs',
      'src/main/services/loro-data-plane-relay.test.mjs',
      'src/main/services/storage-guard.test.mjs',
      'src/main/services/workspace-bundle-service.test.mjs',
      'src/renderer/renderer-csp.test.mjs',
      'src/renderer/src/auth-callback-transaction.test.mjs',
      'src/renderer/src/renderer-error-reporting.test.mjs'
    ]
  },
  {
    id: 'native-packaging',
    flags: [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--experimental-strip-types',
      '--import',
      './scripts/node-test-ts-resolve.mjs'
    ],
    files: ['scripts/cli-native-deps.test.mjs']
  },
  ...['e2ee-runtime', 'e2ee-account-runtime'].flatMap((name) =>
    ['', '-part-2', '-part-3'].map((suffix) => ({
      id: `${name}${suffix}`,
      flags: nativeFlags,
      files: [`src/main/services/${name}${suffix}.test.mjs`]
    }))
  ),
  {
    id: 'e2ee-adapters',
    flags: nativeFlags,
    files: [
      'src/main/e2ee-custody.test.mjs',
      'src/main/services/e2ee-bootstrap.test.mjs',
      'src/main/services/e2ee-cloud-client.test.mjs',
      'src/main/services/e2ee-account-pairing.test.mjs',
      'src/main/services/e2ee-recovery-vault.test.mjs',
      'src/main/services/e2ee-passkey-macos.test.mjs'
    ]
  },
  {
    id: 'vite-config',
    flags: [],
    files: ['scripts/electron.vite.test.config.test.mjs']
  }
]

export function isolationFlag(nodeVersion = process.versions.node) {
  return Number(nodeVersion.split('.')[0]) === 22
    ? '--experimental-test-isolation=none'
    : '--test-isolation=none'
}

export async function runElectronTests({
  run = runGroup,
  concurrency = Number(process.env.LODY_ELECTRON_TEST_CONCURRENCY) || 4
} = {}) {
  const pending = [...ELECTRON_TEST_GROUPS]
  const results = []
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (pending.length) {
        const group = pending.shift()
        results.push(await run(group))
      }
    })
  )
  return results.every(Boolean)
}

function runGroup(group) {
  const started = performance.now()
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...group.flags, isolationFlag(), '--test', ...group.files],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: 'inherit'
      }
    )
    child.on('error', (error) => {
      console.error(error)
      resolve(false)
    })
    child.on('close', (code, signal) => {
      console.log(`[electron:${group.id}] ${(performance.now() - started).toFixed(0)}ms`)
      resolve(code === 0 && signal === null)
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = (await runElectronTests()) ? 0 : 1
}
