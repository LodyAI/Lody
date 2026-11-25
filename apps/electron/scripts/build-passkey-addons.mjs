import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SUPPORTED_ARCHES = new Set(['arm64', 'x64'])
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'
const defaultElectronAppDir = fileURLToPath(new URL('..', import.meta.url))
const defaultNativeDir = path.join(defaultElectronAppDir, 'native', 'passkey')

/** Resolve the pinned Electron version for native header selection. */
export function resolveElectronVersion({ electronAppDir = defaultElectronAppDir } = {}) {
  const pkgJsonPath = path.join(electronAppDir, 'package.json')
  const requireFromApp = createRequire(pkgJsonPath)
  try {
    const electronPkg = requireFromApp('electron/package.json')
    if (typeof electronPkg?.version === 'string' && electronPkg.version.trim()) {
      return electronPkg.version.trim()
    }
  } catch {
    // Fall back to apps/electron/package.json when running outside a full install.
  }

  const appPkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  const raw = appPkg.devDependencies?.electron ?? appPkg.dependencies?.electron
  if (typeof raw === 'string') {
    const cleaned = raw.trim().replace(/^[^\d]*/, '')
    if (/^\d+\.\d+\.\d+/u.test(cleaned)) return cleaned
  }
  throw new Error(`Could not resolve Electron version from ${pkgJsonPath}`)
}

/** Resolve a local node-gyp CLI binary from workspace dependencies or global npm. */
export function resolveNodeGypBin({ electronAppDir = defaultElectronAppDir } = {}) {
  const requireFromApp = createRequire(path.join(electronAppDir, 'package.json'))
  try {
    const sparkleEntry = requireFromApp.resolve('electron-sparkle-updater')
    const requireFromSparkle = createRequire(sparkleEntry)
    const gypPkgPath = requireFromSparkle.resolve('node-gyp/package.json')
    const gypPkg = JSON.parse(readFileSync(gypPkgPath, 'utf8'))
    const binRel = typeof gypPkg.bin === 'string' ? gypPkg.bin : gypPkg.bin?.['node-gyp']
    if (binRel) {
      const candidate = path.resolve(path.dirname(gypPkgPath), binRel)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // Fall through to global npm lookup.
  }

  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const globalCandidate = path.join(
      npmRoot,
      'npm',
      'node_modules',
      'node-gyp',
      'bin',
      'node-gyp.js'
    )
    if (existsSync(globalCandidate)) return globalCandidate
  } catch {
    // Fall through to unified error below.
  }

  throw new Error('Could not locate node-gyp binary in workspace dependencies or global npm')
}

/** Parse `--out <dir>` and optional `--arches <csv>` CLI arguments. */
export function parseBuildArgs(argv) {
  let outDir
  let arches = ['arm64', 'x64']

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) {
        throw new Error('--out requires a directory path')
      }
      outDir = value
    } else if (arg === '--arches') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) {
        throw new Error('--arches requires a comma-separated list of arm64,x64')
      }
      arches = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!outDir) {
    throw new Error('--out <dir> is required')
  }
  validateArches(arches)
  return { outDir: path.resolve(outDir), arches }
}

function validateArches(arches) {
  if (!Array.isArray(arches) || arches.length === 0) {
    throw new Error('At least one target architecture (arm64 or x64) is required')
  }
  for (const arch of arches) {
    if (!SUPPORTED_ARCHES.has(arch)) {
      throw new Error(`Unsupported passkey addon architecture: ${arch}`)
    }
  }
  if (new Set(arches).size !== arches.length) {
    throw new Error(`Duplicate architecture in list: ${arches.join(', ')}`)
  }
}

/** Build and stage `passkey_bridge.node` per architecture under `<outDir>/<arch>/`. */
export function buildPasskeyAddons({
  outDir,
  arches = ['arm64', 'x64'],
  electronAppDir = defaultElectronAppDir,
  nativeDir = defaultNativeDir
}) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS Passkey native addon builds require darwin')
  }
  validateArches(arches)

  const resolvedOutDir = path.resolve(outDir)
  const electronVersion = resolveElectronVersion({ electronAppDir })
  const nodeGypBin = resolveNodeGypBin({ electronAppDir })
  const builtNodePath = path.join(nativeDir, 'build', 'Release', 'passkey_bridge.node')

  try {
    for (const arch of arches) {
      const result = spawnSync(
        process.execPath,
        [
          nodeGypBin,
          'rebuild',
          `--target=${electronVersion}`,
          `--arch=${arch}`,
          `--dist-url=${ELECTRON_HEADERS_URL}`
        ],
        { cwd: nativeDir, stdio: 'inherit' }
      )
      if (result.error) throw result.error
      if (result.status !== 0) {
        throw new Error(
          `node-gyp rebuild failed for ${arch} (exit ${String(result.status ?? 'unknown')})`
        )
      }
      if (!existsSync(builtNodePath)) {
        throw new Error(`Expected built addon at ${builtNodePath}`)
      }
      const destDir = path.join(resolvedOutDir, arch)
      const destPath = path.join(destDir, 'passkey_bridge.node')
      mkdirSync(destDir, { recursive: true })
      copyFileSync(builtNodePath, destPath)
      execFileSync('lipo', [destPath, '-verify_arch', arch === 'x64' ? 'x86_64' : arch])
    }
  } finally {
    // Keep the native source tree clean so intermediate build artifacts never enter app.asar.
    rmSync(path.join(nativeDir, 'build'), { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseBuildArgs(process.argv.slice(2))
  buildPasskeyAddons(options)
}
