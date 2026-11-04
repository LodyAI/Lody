import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'

if (process.env.LODY_SKIP_ELECTRON_POSTINSTALL === '1') {
  process.exit(0)
}

const require = createRequire(import.meta.url)

/** @param {string} spec */
function canResolve(spec) {
  try {
    require.resolve(spec)
    return true
  } catch {
    return false
  }
}

if (!canResolve('electron')) {
  // Some CI/build environments install a subset of workspace deps (or use Bun workspaces),
  // so Electron isn't available. Don't fail installs that don't need the desktop app.
  process.exit(0)
}

// Electron 42+ no longer downloads its binary from its own postinstall, but
// electron-vite dev/preview and the Playwright E2E harness launch it through
// `electron/path.txt`. The package's installer is idempotent: it returns without
// downloading when `dist/version` and `path.txt` already match.
const electronInstaller = path.join(path.dirname(require.resolve('electron')), 'install.js')
const electronInstall = spawnSync(process.execPath, [electronInstaller], { stdio: 'inherit' })
if (electronInstall.status !== 0) {
  process.exit(electronInstall.status ?? 1)
}

// Match electron-builder.yml's npmRebuild: false. SQLite and the embedded CLI
// native dependencies use platform/architecture N-API prebuilds; install-app-deps
// ignores that setting and unnecessarily asks node-abi for an Electron ABI.
// Sparkle owns its separate macOS build, both here and in package-electron.mjs.
if (process.platform === 'darwin') {
  const sparkleBin = path.join(process.cwd(), 'node_modules', '.bin', 'electron-sparkle-updater')
  if (fs.existsSync(sparkleBin)) {
    const sparkleRebuild = spawnSync(sparkleBin, ['rebuild'], { stdio: 'inherit' })
    process.exit(sparkleRebuild.status ?? 1)
  }
}

process.exit(0)
