import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The embedded CLI bundle (resources/cli/index.js) keeps native addons external
// so the packaged app must ship those packages plus their runtime require-chain
// under resources/cli/node_modules, where Node resolution from index.js finds
// them. Both bindings are N-API addons, so one prebuilt binary per platform/arch
// loads under Node and under Electron alike (the CLI runs via
// ELECTRON_RUN_AS_NODE inside the app binary) — no ABI-specific rebuild.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const electronAppRoot = path.resolve(__dirname, '..')
const cliAppRoot = path.resolve(electronAppRoot, '../cli')
const require = createRequire(import.meta.url)

// Mirror of the published CLI's runtime dependencies (enforced by
// apps/cli/scripts/check-published-bundle-imports.js): the bundle keeps
// better-sqlite3 and node-pty external, and worker_threads pools
// require.resolve('loro-crdt') at module scope to hand workers a real on-disk
// package (workers cannot share the wasm module inlined into the bundle).
// better-sqlite3 >=13 has no runtime require-chain of its own (node-addon-api is
// build-time only); its prebuilt binaries live in `prebuilds/<platform>-<arch>.node`
// inside the package and are staged per packaging target by
// installEmbeddedSqliteBinding, so the whole 8-platform set never ships.
// @lydell/node-pty's own binding lives in a sibling per-platform package
// (@lydell/node-pty-<platform>-<arch>) that it pulls in through optionalDependencies,
// so a package manager only installs the host's. It is staged per packaging target by
// installEmbeddedNodePtyBinding instead of being listed here.
// Each entry resolves from its dependent's real directory because pnpm's
// strict layout exposes transitive deps only next to the package that
// declares them (.pnpm/<pkg>/node_modules/<dep>), not under apps/cli.
const CLI_RUNTIME_PACKAGE_CHAIN = [
  { name: 'better-sqlite3', from: 'cli' },
  { name: 'loro-crdt', from: 'cli' },
  { name: '@lydell/node-pty', from: 'cli' },
  // tinypool drives the diff line-count worker pool; it stays external because it
  // resolves its own entry/worker.js relative to its package dir. Pure JS, no deps.
  { name: 'tinypool', from: 'cli' },
  // @vscode/ripgrep is a 4 KB shim whose lib/index.js `require.resolve`s the
  // binary out of a sibling per-platform package. Only the shim is listed here;
  // the binary is staged per packaging target by installEmbeddedRipgrepBinary,
  // exactly like @lydell/node-pty above.
  { name: '@vscode/ripgrep', from: 'cli' }
]

// Top-level package dirs that are never needed at runtime (C++ sources, the
// sqlite amalgamation, node-gyp output). `prebuilds/` is excluded here on
// purpose: better-sqlite3 ships every platform's binary (~17 MB) and
// installEmbeddedSqliteBinding copies back only the packaging target's.
const EXCLUDED_PACKAGE_DIRS = new Set([
  'build',
  'deps',
  'src',
  'prebuilds',
  'bin',
  'docs',
  'benchmark',
  'test',
  'node_modules'
])
export const stagedCliDir = path.join(electronAppRoot, 'resources', 'cli')
export const stagedNodeModulesDir = path.join(stagedCliDir, 'node_modules')
export const stagedSqliteDir = path.join(stagedNodeModulesDir, 'better-sqlite3')
export const stagedNodePtyDir = path.join(stagedNodeModulesDir, '@lydell', 'node-pty')

/**
 * better-sqlite3 >=13 resolves `prebuilds/<target>.node` from process.platform/arch
 * (lib/binding.js). Electron only ships glibc Linux builds, so the `linuxmusl-*`
 * variants that package also carries are never the right target here.
 */
export function sqlitePrebuildFileName({ platform, arch }) {
  return `${platform}-${arch}.node`
}

export function stagedSqliteBindingPath(target) {
  return path.join(stagedSqliteDir, 'prebuilds', sqlitePrebuildFileName(target))
}

/** Sibling package @lydell/node-pty requires the binding from, keyed by target. */
export function nodePtyBinaryPackageName({ platform, arch }) {
  return `@lydell/node-pty-${platform}-${arch}`
}

export function stagedNodePtyBinaryDir({ platform, arch }) {
  return path.join(stagedNodeModulesDir, '@lydell', `node-pty-${platform}-${arch}`)
}

/**
 * Windows drives the pty through ConPTY (`windowsPtyAgent.js` requires `conpty.node`);
 * every other platform forks a pty directly (`unixTerminal.js` requires `pty.node`).
 * There is no `pty.node` in the win32 packages at all.
 */
export function nodePtyBindingFileName({ platform }) {
  return platform === 'win32' ? 'conpty.node' : 'pty.node'
}

export function stagedNodePtyBindingPath({ platform, arch }) {
  return path.join(
    stagedNodePtyBinaryDir({ platform, arch }),
    'prebuilds',
    `${platform}-${arch}`,
    nodePtyBindingFileName({ platform })
  )
}

/** macOS forks the pty through this helper binary; other platforms never read it. */
export function stagedNodePtySpawnHelperPath({ platform, arch }) {
  return path.join(
    stagedNodePtyBinaryDir({ platform, arch }),
    'prebuilds',
    `${platform}-${arch}`,
    'spawn-helper'
  )
}

function resolvePackageDir(packageName, fromDir) {
  const resolveOptions = { paths: [fromDir] }
  try {
    // Packages with no `exports` map expose package.json directly.
    return path.dirname(require.resolve(`${packageName}/package.json`, resolveOptions))
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
    // @lydell/node-pty restricts `exports` to ".", so walk up from its entry point to
    // the directory that owns package.json.
    let dir = path.dirname(require.resolve(packageName, resolveOptions))
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
      const parent = path.dirname(dir)
      if (parent === dir) {
        throw new Error(`Cannot resolve the package root of ${packageName} from ${fromDir}.`)
      }
      dir = parent
    }
    return dir
  }
}

function copyPackageDir(fromDir, toDir, { isTopLevel }) {
  fs.mkdirSync(toDir, { recursive: true })
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const fromPath = path.join(fromDir, entry.name)
    const toPath = path.join(toDir, entry.name)
    if (entry.isDirectory()) {
      if (isTopLevel && EXCLUDED_PACKAGE_DIRS.has(entry.name)) {
        continue
      }
      copyPackageDir(fromPath, toPath, { isTopLevel: false })
      continue
    }
    if (!entry.isFile()) continue
    if (/\.(md|markdown|map)$/i.test(entry.name)) continue
    fs.copyFileSync(fromPath, toPath)
  }
}

export function stageCliRuntimePackages() {
  fs.rmSync(stagedNodeModulesDir, { recursive: true, force: true })
  const resolvedDirs = { cli: cliAppRoot }
  for (const { name, from } of CLI_RUNTIME_PACKAGE_CHAIN) {
    const fromDir = resolvePackageDir(name, resolvedDirs[from])
    resolvedDirs[name] = fromDir
    copyPackageDir(fromDir, path.join(stagedNodeModulesDir, name), { isTopLevel: true })
  }
}

/**
 * Stages the prebuilt sqlite binding matching the packaging target.
 *
 * better-sqlite3 >=13 is an N-API addon whose prebuilt binaries ship inside the npm
 * package, so this is a plain copy out of the workspace install: no node-gyp, no
 * GitHub download, and no Electron-ABI variant to fetch. Must still run once per
 * packaging target — `--arm64 --x64` mac builds share one resources/ dir, so each
 * beforePack swaps the binary.
 */
export function installEmbeddedSqliteBinding({ platform, arch }) {
  if (!fs.existsSync(path.join(stagedSqliteDir, 'package.json'))) {
    throw new Error(
      `Staged better-sqlite3 not found at ${stagedSqliteDir}. Run \`pnpm run sync:cli\` first.`
    )
  }

  const workspaceSqliteDir = resolvePackageDir('better-sqlite3', cliAppRoot)
  const fileName = sqlitePrebuildFileName({ platform, arch })
  const sourcePath = path.join(workspaceSqliteDir, 'prebuilds', fileName)
  if (!fs.existsSync(sourcePath)) {
    const available = fs.existsSync(path.join(workspaceSqliteDir, 'prebuilds'))
      ? fs.readdirSync(path.join(workspaceSqliteDir, 'prebuilds')).join(', ')
      : 'none'
    throw new Error(
      `better-sqlite3 ships no prebuilt binary for ${platform}-${arch} (has: ${available}). ` +
        `Since 13.0.2 the package has no install script, so there is no source build to ` +
        `fall back on — that platform cannot ship an embedded CLI.`
    )
  }

  // Drop previously staged binaries first: one resources/ dir is reused across the
  // arches of a `--arm64 --x64` run, and a stale wrong-arch binary left next to the
  // right one would still be picked by the loader on that other arch.
  const stagedPrebuildsDir = path.join(stagedSqliteDir, 'prebuilds')
  fs.rmSync(stagedPrebuildsDir, { recursive: true, force: true })
  fs.mkdirSync(stagedPrebuildsDir, { recursive: true })
  const bindingPath = stagedSqliteBindingPath({ platform, arch })
  fs.copyFileSync(sourcePath, bindingPath)

  console.log(`Staged embedded better-sqlite3 binding (${platform}-${arch})`)
  return bindingPath
}

/** Exact version @lydell/node-pty pins its binary packages to (they move in lockstep). */
function resolveNodePtyBinaryVersion(packageName) {
  const wrapperPackageJson = JSON.parse(
    fs.readFileSync(path.join(stagedNodePtyDir, 'package.json'), 'utf8')
  )
  const version = wrapperPackageJson.optionalDependencies?.[packageName]
  if (!version) {
    throw new Error(
      `@lydell/node-pty@${wrapperPackageJson.version} has no binary package ${packageName}. ` +
        `That platform/arch has no prebuilt pty binding, so the embedded CLI cannot ship a terminal for it.`
    )
  }
  return version
}

/**
 * The host's own binary package is already installed; foreign targets are not.
 *
 * The binary packages restrict `exports` to "." and expose no resolvable subpath, so
 * find them by layout instead: they are always siblings of the wrapper inside the
 * `@lydell` scope directory, under both pnpm's store and npm's flat tree.
 */
function resolveInstalledNodePtyBinaryDir(packageName) {
  const scopeDir = path.dirname(resolvePackageDir('@lydell/node-pty', cliAppRoot))
  const candidate = path.join(scopeDir, packageName.slice('@lydell/'.length))
  return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : undefined
}

/**
 * Fetches a binary package for a platform/arch the build host is not. npm refuses to
 * install across its `os`/`cpu` fields without `--force`; the download itself is
 * platform-agnostic. Installed into a throwaway prefix so the workspace tree is untouched.
 */
function fetchNodePtyBinaryPackage(packageName, version) {
  return fetchBinaryPackage(packageName, version, 'pty binding')
}

/**
 * Downloads one per-platform binary package for a packaging target the build host
 * is not. Shared by the pty binding and the ripgrep binary: both publish their
 * binary as a sibling optionalDependency, so a cross-arch package job has to
 * fetch the target's copy rather than reuse whatever this host installed.
 */
function fetchBinaryPackage(packageName, version, label) {
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-embedded-binary-'))
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'install',
      `${packageName}@${version}`,
      '--prefix',
      downloadDir,
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--force'
    ],
    { stdio: 'inherit' }
  )

  const packageDir = path.join(downloadDir, 'node_modules', ...packageName.split('/'))
  if (result.status !== 0 || !fs.existsSync(path.join(packageDir, 'package.json'))) {
    fs.rmSync(downloadDir, { recursive: true, force: true })
    throw new Error(
      `Failed to download ${packageName}@${version} for the embedded CLI ${label}. ` +
        `It is fetched from the npm registry because the build host is ` +
        `${process.platform}-${process.arch}; set a registry mirror on restricted networks.`
    )
  }
  return { packageDir, cleanup: () => fs.rmSync(downloadDir, { recursive: true, force: true }) }
}

/**
 * Stages the prebuilt pty binary package matching the packaging target.
 *
 * @lydell/node-pty repackages node-pty's own prebuilt bindings as per-platform npm
 * packages and never runs node-gyp. The binding is an N-API addon
 * (napi_register_module_v1), so a single build loads under both Node and Electron —
 * no ABI-specific rebuild, same as better-sqlite3 since 13.0.0.
 */
export function installEmbeddedNodePtyBinding({ platform, arch }) {
  if (!fs.existsSync(path.join(stagedNodePtyDir, 'package.json'))) {
    throw new Error(
      `Staged @lydell/node-pty not found at ${stagedNodePtyDir}. Run \`pnpm run sync:cli\` first.`
    )
  }

  const packageName = nodePtyBinaryPackageName({ platform, arch })
  const version = resolveNodePtyBinaryVersion(packageName)

  // Drop previously staged binary packages first: one resources/ dir is reused across
  // the arches of a `--arm64 --x64` run, and a failed fetch must not leave a stale
  // binary that the afterPack assertions would then happily accept.
  removeStagedNodePtyBinaryPackages()

  const installedDir = resolveInstalledNodePtyBinaryDir(packageName)
  const downloaded = installedDir ? undefined : fetchNodePtyBinaryPackage(packageName, version)
  const targetDir = stagedNodePtyBinaryDir({ platform, arch })
  try {
    // Copied as a non-top-level dir so the `prebuilds/` exclusion does not apply: in this
    // layout the binary lives there, and the package holds nothing else worth pruning.
    copyPackageDir(installedDir ?? downloaded.packageDir, targetDir, { isTopLevel: false })
  } finally {
    downloaded?.cleanup()
  }

  const bindingPath = stagedNodePtyBindingPath({ platform, arch })
  if (!fs.existsSync(bindingPath)) {
    throw new Error(
      `${packageName} staged without its ${nodePtyBindingFileName({ platform })} binding at ${bindingPath}.`
    )
  }
  if (platform === 'darwin') {
    // macOS execs spawn-helper to fork the pty. It is copied rather than produced by a
    // build here, so re-assert the executable bit — a non-executable helper fails only
    // at terminal-open time, long after packaging.
    const spawnHelperPath = stagedNodePtySpawnHelperPath({ platform, arch })
    if (!fs.existsSync(spawnHelperPath)) {
      throw new Error(`${packageName} staged without spawn-helper at ${spawnHelperPath}.`)
    }
    fs.chmodSync(spawnHelperPath, 0o755)
    repairStagedSpawnHelperAsarPath(targetDir, packageName)
  }

  console.log(
    `Staged embedded pty binding ${packageName}@${version} (${platform}-${arch}` +
      `${installedDir ? '' : ', downloaded'})`
  )
  return bindingPath
}

export function ripgrepBinaryPackageName({ platform, arch }) {
  return `@vscode/ripgrep-${platform}-${arch}`
}

export function ripgrepBinaryFileName({ platform }) {
  return platform === 'win32' ? 'rg.exe' : 'rg'
}

export const stagedRipgrepDir = path.join(stagedNodeModulesDir, '@vscode', 'ripgrep')

export function stagedRipgrepBinaryDir({ platform, arch }) {
  return path.join(stagedNodeModulesDir, '@vscode', `ripgrep-${platform}-${arch}`)
}

export function stagedRipgrepBinaryPath({ platform, arch }) {
  return path.join(
    stagedRipgrepBinaryDir({ platform, arch }),
    'bin',
    ripgrepBinaryFileName({ platform })
  )
}

/**
 * @vscode/ripgrep pins each per-platform package to its own exact version, so the
 * staged shim is the source of truth for which binary belongs to it. Reading the
 * pin (rather than assuming the shim's own version) keeps a future shape change
 * from silently staging a mismatched binary.
 */
function resolveRipgrepBinaryVersion(packageName) {
  const manifestPath = path.join(stagedRipgrepDir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Staged @vscode/ripgrep not found at ${stagedRipgrepDir}. Run \`pnpm run sync:cli\` first.`
    )
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const version = manifest.optionalDependencies?.[packageName]
  if (typeof version !== 'string' || !version) {
    throw new Error(
      `@vscode/ripgrep does not publish ${packageName}; this platform/arch has no ripgrep binary.`
    )
  }
  return version
}

/**
 * pnpm's strict layout exposes a transitive dep only next to the package that
 * DECLARES it, so `@vscode/ripgrep-<platform>-<arch>` is not resolvable from
 * apps/cli — resolving from there downloads a copy of the host's own binary on
 * every packaging run. Find it as a sibling of the wrapper inside the `@vscode`
 * scope dir instead, which holds under both pnpm's store and npm's flat tree.
 * Mirrors resolveInstalledNodePtyBinaryDir.
 */
function resolveInstalledRipgrepBinaryDir(packageName) {
  const scopeDir = path.dirname(resolvePackageDir('@vscode/ripgrep', cliAppRoot))
  const candidate = path.join(scopeDir, packageName.slice('@vscode/'.length))
  return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : undefined
}

function removeStagedRipgrepBinaryPackages() {
  const scopeDir = path.join(stagedNodeModulesDir, '@vscode')
  if (!fs.existsSync(scopeDir)) return
  for (const entry of fs.readdirSync(scopeDir)) {
    if (entry.startsWith('ripgrep-')) {
      fs.rmSync(path.join(scopeDir, entry), { recursive: true, force: true })
    }
  }
}

/**
 * Stages the packaging target's ripgrep binary next to the staged shim, which
 * resolves it by plain `require.resolve`.
 */
export function installEmbeddedRipgrepBinary({ platform, arch }) {
  const packageName = ripgrepBinaryPackageName({ platform, arch })
  const version = resolveRipgrepBinaryVersion(packageName)

  // One resources/ dir is reused across the arches of a `--arm64 --x64` run, so a
  // stale binary must not survive into a target the afterPack probe would accept.
  removeStagedRipgrepBinaryPackages()

  const installedDir = resolveInstalledRipgrepBinaryDir(packageName)
  const downloaded = installedDir
    ? undefined
    : fetchBinaryPackage(packageName, version, 'ripgrep binary')
  const targetDir = stagedRipgrepBinaryDir({ platform, arch })
  try {
    // isTopLevel: false is load-bearing — EXCLUDED_PACKAGE_DIRS drops `bin/`, which
    // in this package is the only thing worth copying.
    copyPackageDir(installedDir ?? downloaded.packageDir, targetDir, { isTopLevel: false })
  } finally {
    downloaded?.cleanup()
  }

  const binaryPath = stagedRipgrepBinaryPath({ platform, arch })
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`${packageName} staged without its ripgrep binary at ${binaryPath}.`)
  }
  // The binary is copied, not built, so the executable bit has to be re-asserted;
  // a non-executable rg fails only when someone opens an `@` menu.
  if (platform !== 'win32') {
    fs.chmodSync(binaryPath, 0o755)
  }

  console.log(
    `Staged embedded ripgrep ${packageName}@${version} (${platform}-${arch}` +
      `${installedDir ? '' : ', downloaded'})`
  )
  return binaryPath
}

const SPAWN_HELPER_ASAR_REWRITES = [
  {
    from: "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
    to: "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked');"
  },
  {
    from: "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
    to: "helperPath = helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked');"
  }
]

/**
 * Fixes node-pty's asar path rewrite in the staged copy (originally #2492).
 *
 * The embedded CLI is packed into `app.asar.unpacked/resources/cli`, so the resolved
 * spawn-helper path already contains `app.asar.unpacked`. node-pty's unconditional
 * `.replace('app.asar', 'app.asar.unpacked')` then rewrites that first substring and
 * yields `app.asar.unpacked.unpacked`, i.e. a helper macOS cannot exec.
 *
 * Applied here rather than through pnpm `patchedDependencies` because the affected file
 * ships inside the per-platform binary package, and the foreign-arch package is fetched
 * straight from the registry by fetchNodePtyBinaryPackage — a pnpm patch would never
 * reach it, silently leaving the `--x64` slice of a mac release broken.
 */
function repairStagedSpawnHelperAsarPath(targetDir, packageName) {
  const unixTerminalPath = path.join(targetDir, 'lib', 'unixTerminal.js')
  const source = fs.readFileSync(unixTerminalPath, 'utf8')
  let patched = source
  for (const { from, to } of SPAWN_HELPER_ASAR_REWRITES) {
    if (!patched.includes(from)) {
      throw new Error(
        `Cannot apply the spawn-helper asar fix to ${packageName}: expected to find ` +
          `${JSON.stringify(from)} in ${unixTerminalPath}. node-pty likely reworked the ` +
          `helper path; re-check it against app.asar.unpacked before shipping macOS.`
      )
    }
    patched = patched.replace(from, to)
  }
  fs.writeFileSync(unixTerminalPath, patched)
}

function removeStagedNodePtyBinaryPackages() {
  const scopeDir = path.join(stagedNodeModulesDir, '@lydell')
  if (!fs.existsSync(scopeDir)) return
  for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('node-pty-')) continue
    fs.rmSync(path.join(scopeDir, entry.name), { recursive: true, force: true })
  }
}
