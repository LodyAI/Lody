import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  stagedNodePtyBindingPath,
  stagedNodePtySpawnHelperPath,
  stagedNodeModulesDir,
  stagedRipgrepBinaryPath,
  stagedSqliteBindingPath
} from './cli-native-deps.mjs'

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }
const SMOKE_TIMEOUT_MS = 120_000
const DEEPSEEK_PACKAGED_ASSETS = [
  'deepseek-acp.js',
  ...['standard', 'code', 'minimal', 'cordis'].map((preset) =>
    path.join('deepseek-agent-presets', preset, 'agent.cordis.yml')
  )
]

function assertPackagedDeepSeekAssets(packedCliDir) {
  const missing = DEEPSEEK_PACKAGED_ASSETS.filter(
    (relativePath) => !fs.existsSync(path.join(packedCliDir, relativePath))
  )
  if (missing.length > 0) {
    throw new Error(
      `[embedded-cli] missing DeepSeek Harness assets after pack: ${missing.join(', ')}`
    )
  }
  console.log('[embedded-cli] DeepSeek Harness adapter and presets are packaged')
}

/**
 * Two jobs, in order, before code signing:
 *
 * 1. Copy the staged resources/cli/node_modules into the packed app next to
 *    the embedded CLI. electron-builder's file collector ignores arbitrary
 *    nested node_modules directories (it only collects node_modules via the
 *    app's dependency graph), so the staging cannot ride along with `files`.
 * 2. Assert provider assets, then launch the packaged CLI runtime in
 *    ELECTRON_RUN_AS_NODE mode against app.asar.unpacked/resources/cli/index.js
 *    exactly like production autostart does, so missing assets or externals and
 *    ABI-mismatched bindings fail the build instead of crash-looping on user
 *    machines. The runtime probe runs only when the target matches the build host.
 */
export default async function afterPack(context) {
  const archName = ARCH_NAMES[context.arch]
  const platform = context.electronPlatformName

  const productFilename = context.packager.appInfo.productFilename
  let binaryPath
  let resourcesDir
  if (platform === 'darwin' || platform === 'mas') {
    const appDir = path.join(context.appOutDir, `${productFilename}.app`)
    binaryPath = path.join(appDir, 'Contents', 'MacOS', productFilename)
    resourcesDir = path.join(appDir, 'Contents', 'Resources')
  } else {
    const executableName =
      context.packager.platformSpecificBuildOptions?.executableName ?? productFilename
    binaryPath = path.join(
      context.appOutDir,
      platform === 'win32' ? `${executableName}.exe` : executableName
    )
    resourcesDir = path.join(context.appOutDir, 'resources')
  }
  const cliRuntimePath = resolvePackedCliRuntimePath({
    binaryPath,
    productFilename,
    resourcesDir,
    platform
  })

  const packedCliDir = path.join(resourcesDir, 'app.asar.unpacked', 'resources', 'cli')
  const cliEntry = path.join(packedCliDir, 'index.js')
  if (!fs.existsSync(cliEntry)) {
    throw new Error(`[embedded-cli] missing expected path: ${cliEntry}`)
  }
  assertPackagedDeepSeekAssets(packedCliDir)
  // beforePack staged both native bindings for this exact target, so mirror their
  // staged-relative locations rather than guessing the per-platform file names here.
  const nativeTarget = { platform: platform === 'mas' ? 'darwin' : platform, arch: archName }
  const packedNodeModulesDir = path.join(packedCliDir, 'node_modules')
  const packedFromStaged = (stagedPath) =>
    path.join(packedNodeModulesDir, path.relative(stagedNodeModulesDir, stagedPath))
  const packedBindingPath = packedFromStaged(stagedSqliteBindingPath(nativeTarget))
  const packedNodePtyBindingPath = packedFromStaged(stagedNodePtyBindingPath(nativeTarget))
  fs.cpSync(stagedNodeModulesDir, packedNodeModulesDir, {
    recursive: true,
    force: true
  })
  if (!fs.existsSync(packedBindingPath)) {
    throw new Error(`[embedded-cli] sqlite binding missing after copy: ${packedBindingPath}`)
  }
  if (!fs.existsSync(packedNodePtyBindingPath)) {
    throw new Error(
      `[embedded-cli] node-pty binding missing after copy: ${packedNodePtyBindingPath}`
    )
  }
  if (platform === 'darwin' || platform === 'mas') {
    const packedSpawnHelperPath = packedFromStaged(stagedNodePtySpawnHelperPath(nativeTarget))
    if (!fs.existsSync(packedSpawnHelperPath)) {
      throw new Error(
        `[embedded-cli] node-pty spawn-helper missing after copy: ${packedSpawnHelperPath}`
      )
    }
  }
  const packedRipgrepPath = packedFromStaged(stagedRipgrepBinaryPath(nativeTarget))
  if (!fs.existsSync(packedRipgrepPath)) {
    throw new Error(`[embedded-cli] ripgrep binary missing after copy: ${packedRipgrepPath}`)
  }
  if (platform !== 'win32') {
    // fs.cpSync preserves the mode, but the staged copy is the only thing that
    // ever set it. A non-executable rg surfaces as an empty `@` menu at runtime,
    // long after packaging, so assert rather than hope.
    const mode = fs.statSync(packedRipgrepPath).mode
    if (!(mode & 0o111)) {
      throw new Error(
        `[embedded-cli] ripgrep binary is not executable after copy: ${packedRipgrepPath}`
      )
    }
  }
  console.log(`[embedded-cli] copied runtime node_modules into ${packedCliDir}`)

  // Locale gate (Windows): Chromium loads every UI string from
  // locales/<lang>.pak. If the `electronLanguages` filter leaves the Windows
  // package without the locale the OS resolves to, the renderer fatally crashes
  // (exit -36861) the first time it renders localized UI — e.g. the "Choose
  // File" button of an `<input type=file>` (Electron #45251). Windows .pak files
  // use hyphenated names (en-US.pak), not the macOS underscore form (en_US), so
  // fail the build here instead of shipping a guaranteed crash. Pure fs check,
  // so it runs even for cross-host Windows builds (unlike the CLI smoke test).
  if (platform === 'win32') {
    const localesDir = path.join(context.appOutDir, 'locales')
    const paks = fs.existsSync(localesDir)
      ? fs.readdirSync(localesDir).filter((name) => name.endsWith('.pak'))
      : []
    if (!paks.includes('en-US.pak')) {
      throw new Error(
        `[locales] Windows package is missing locales/en-US.pak (found: ${paks.join(', ') || 'none'}). ` +
          `Chromium would crash the renderer (-36861) on localized UI. Check ` +
          `electronLanguages in electron-builder.yml — Windows .pak files use ` +
          `hyphenated names (en-US), not the macOS underscore form (en_US).`
      )
    }
    console.log(`[locales] Windows package includes ${paks.length} locale .pak file(s)`)
  }

  if (platform === 'mas') return
  if (platform !== process.platform || archName !== process.arch) {
    console.log(
      `[embedded-cli-smoke] skipped for ${platform}-${archName} (build host is ` +
        `${process.platform}-${process.arch})`
    )
    return
  }

  if (!fs.existsSync(cliRuntimePath)) {
    throw new Error(`[embedded-cli-smoke] missing expected runtime path: ${cliRuntimePath}`)
  }

  const result = spawnSync(cliRuntimePath, [cliEntry, '--help'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: SMOKE_TIMEOUT_MS,
    windowsHide: true
  })

  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n')
      .slice(-4000)
    throw new Error(
      `[embedded-cli-smoke] embedded CLI failed to start (exit ${String(result.status)}) — ` +
        `the packaged app would crash-loop on CLI autostart.\n${detail}`
    )
  }

  const nodePtyProbe = [
    `const { createRequire } = require('node:module');`,
    `const os = require('node:os');`,
    `const req = createRequire(${JSON.stringify(path.resolve(cliEntry))});`,
    `const pty = req('@lydell/node-pty');`,
    `if (typeof pty.spawn !== 'function') throw new Error('node-pty spawn export missing');`,
    `const marker = 'node-pty-spawn-ok';`,
    `const isWindows = process.platform === 'win32';`,
    `const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';`,
    `const args = isWindows ? ['/d', '/s', '/c', 'echo ' + marker] : ['-lc', 'echo ' + marker];`,
    `let output = '';`,
    `const env = { ...process.env, TERM: 'xterm-256color' };`,
    `if (!env.PATH) env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';`,
    `const term = pty.spawn(shell, args, { cwd: os.tmpdir(), env, cols: 80, rows: 24, name: 'xterm-256color' });`,
    `const timeout = setTimeout(() => { try { term.kill(); } catch {} console.error('node-pty spawn timed out'); process.exit(1); }, 15000);`,
    `term.onData((data) => { output += data; process.stdout.write(data); });`,
    `term.onExit(({ exitCode, signal }) => { clearTimeout(timeout); if (exitCode !== 0 || !output.includes(marker)) { console.error('node-pty spawn probe failed', { exitCode, signal, output }); process.exit(1); } console.log('node-pty-ok'); process.exit(0); });`
  ].join('')
  const nodePtyProbeResult = spawnSync(cliRuntimePath, ['-e', nodePtyProbe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: SMOKE_TIMEOUT_MS,
    windowsHide: true
  })
  if (
    nodePtyProbeResult.error ||
    nodePtyProbeResult.status !== 0 ||
    !nodePtyProbeResult.stdout.includes('node-pty-ok')
  ) {
    const detail = [
      nodePtyProbeResult.error?.message,
      nodePtyProbeResult.stderr,
      nodePtyProbeResult.stdout
    ]
      .filter(Boolean)
      .join('\n')
      .slice(-4000)
    throw new Error(
      `[embedded-cli-smoke] node-pty failed to spawn a pty in the packed app ` +
        `(exit ${String(nodePtyProbeResult.status)}).\n${detail}`
    )
  }

  // better-sqlite3 dlopens its binding lazily inside the Database constructor, so
  // the --help boot above proves module resolution but not the binding. Open a real
  // in-memory database through the packed binary to catch a missing or corrupt
  // prebuild — and, since 13.0.2 has no install script, there is no build/Release
  // fallback that could quietly paper over a mis-staged prebuilds/ directory.
  const bindingProbe = [
    `const { createRequire } = require('node:module');`,
    `const req = createRequire(${JSON.stringify(path.resolve(cliEntry))});`,
    `const Database = req('better-sqlite3');`,
    `const db = new Database(':memory:');`,
    `db.exec('CREATE TABLE t(a)');`,
    `db.prepare('INSERT INTO t VALUES (?)').run(1);`,
    `if (db.prepare('SELECT COUNT(*) AS c FROM t').get().c !== 1) throw new Error('probe query failed');`,
    `db.close();`,
    `console.log('sqlite-binding-ok');`
  ].join('')
  const probeResult = spawnSync(cliRuntimePath, ['-e', bindingProbe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: SMOKE_TIMEOUT_MS,
    windowsHide: true
  })
  if (
    probeResult.error ||
    probeResult.status !== 0 ||
    !probeResult.stdout.includes('sqlite-binding-ok')
  ) {
    const detail = [probeResult.error?.message, probeResult.stderr, probeResult.stdout]
      .filter(Boolean)
      .join('\n')
      .slice(-4000)
    throw new Error(
      `[embedded-cli-smoke] better-sqlite3 binding failed to load in the packed app ` +
        `(exit ${String(probeResult.status)}).\n${detail}`
    )
  }

  console.log(`[embedded-cli-smoke] OK for ${platform}-${archName} (boot + native bindings)`)
}

function resolvePackedCliRuntimePath({ binaryPath, productFilename, resourcesDir, platform }) {
  if (platform !== 'darwin' && platform !== 'mas') {
    return binaryPath
  }

  const helperExecutable = `${productFilename} Helper`
  const helperPath = path.resolve(
    resourcesDir,
    '..',
    'Frameworks',
    `${helperExecutable}.app`,
    'Contents',
    'MacOS',
    helperExecutable
  )
  if (!fs.existsSync(helperPath)) {
    throw new Error(`[embedded-cli-smoke] missing expected macOS helper path: ${helperPath}`)
  }

  return helperPath
}
