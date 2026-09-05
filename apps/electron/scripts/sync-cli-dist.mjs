import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  installEmbeddedNodePtyBinding,
  installEmbeddedRipgrepBinary,
  installEmbeddedSqliteBinding,
  stageCliRuntimePackages
} from './cli-native-deps.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const sourceDir = path.resolve(__dirname, '../../cli/dist')
const destDir = path.resolve(__dirname, '../resources/cli')

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function copyDir(fromDir, toDir) {
  ensureDir(toDir)
  const entries = fs.readdirSync(fromDir, { withFileTypes: true })
  for (const entry of entries) {
    const fromPath = path.join(fromDir, entry.name)
    const toPath = path.join(toDir, entry.name)
    if (entry.isDirectory()) {
      copyDir(fromPath, toPath)
      continue
    }
    if (entry.name.endsWith('.map')) {
      continue
    }
    fs.copyFileSync(fromPath, toPath)
  }
}

function writeCliPackageMetadata() {
  const metadata = {
    private: true,
    type: 'module',
    main: 'index.js'
  }
  fs.writeFileSync(path.join(destDir, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`)
}

if (!fs.existsSync(sourceDir)) {
  throw new Error(
    `CLI dist not found at ${sourceDir}. Run \`pnpm --dir apps/cli run build\` first.`
  )
}

fs.rmSync(destDir, { recursive: true, force: true })
copyDir(sourceDir, destDir)
writeCliPackageMetadata()

// The CLI bundle keeps native addons external, so the embedded copy needs
// resources/cli/node_modules plus the per-platform prebuilt bindings. The host
// platform/arch bindings staged here make local `electron-vite preview` and
// same-arch packaging work; electron-builder's beforePack hook re-stages bindings
// per packaging target (mac release builds both arm64 and x64).
stageCliRuntimePackages()
installEmbeddedSqliteBinding({ platform: process.platform, arch: process.arch })
installEmbeddedNodePtyBinding({ platform: process.platform, arch: process.arch })
installEmbeddedRipgrepBinary({ platform: process.platform, arch: process.arch })

console.log(`Synced CLI dist to ${destDir}`)
