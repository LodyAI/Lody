import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { sparkleEventToStatePatch } from './app-updater-sparkle-events.ts'

const require = createRequire(import.meta.url)

/** Evaluate a main-process module with synthetic Electron and updater dependencies. */
async function load(relative, dependencies, context = {}) {
  const source = await readFile(new URL(relative, import.meta.url), 'utf8')
  const exports = {}
  runInNewContext(
    ts.transpileModule(
      source
        .replaceAll('import.meta.env', '{}')
        .replaceAll('import.meta.url', "'file:///synthetic.js'"),
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
      }
    ).outputText,
    {
      exports,
      console: { log() {}, info() {}, error() {} },
      Date,
      Promise,
      require: (id) => (Object.hasOwn(dependencies, id) ? dependencies[id] : require(id)),
      ...context
    }
  )
  return exports
}

function syntheticApp() {
  const listeners = new Map()
  return {
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
    isPackaged: true,
    getVersion: () => '1.0.0',
    getPath: () => '/synthetic-user-data',
    quits: 0,
    relaunches: 0,
    quit() {
      this.quits++
    },
    relaunch() {
      this.relaunches++
    }
  }
}

async function loadUpdater({
  app,
  relaunchIntent,
  linuxInstall,
  intervals,
  sparkleBridge,
  windowState = { setAppQuitting() {} }
}) {
  const autoUpdater = {
    checks: 0,
    on() {},
    setFeedURL() {},
    checkForUpdates() {
      this.checks++
      return Promise.resolve()
    }
  }
  const { AppUpdaterService } = await load(
    './app-updater-service.ts',
    {
      electron: { app, BrowserWindow: { getAllWindows: () => [] } },
      'electron-updater': { autoUpdater },
      'electron-sparkle-updater': { loadSparkleBridge: () => sparkleBridge ?? null },
      '@lody/shared/node/process': { startProcessLegacy: () => ({ child: {} }) },
      '@lody/shared/electron-ipc': { IPC_PUSH_CHANNELS: { updaterState: 'updater-state' } },
      '../utils': { formatUnknownError: String },
      '../window-state': windowState,
      '../relaunch-intent': relaunchIntent ?? {},
      './app-updater-linux-install': linuxInstall ?? {},
      './app-updater-metadata': { readUpdaterReleaseMetadata: () => ({}) },
      './app-updater-sparkle-events': { sparkleEventToStatePatch },
      './app-updater-sparkle-policy': {
        shouldUseSparkleUpdater: () => sparkleBridge !== undefined,
        sparklePackageJsonPathFromModuleEntry: () => undefined,
        resolveSparkleAddonPath: () => '/synthetic/sparkle.node',
        resolveSparkleAppcastUrl: () => 'https://synthetic.invalid/appcast.xml'
      }
    },
    {
      process: { platform: 'linux', env: {}, resourcesPath: '/synthetic' },
      setInterval: (callback) => {
        const handle = { callback }
        intervals.add(handle)
        return handle
      },
      clearInterval: (handle) => intervals.delete(handle)
    }
  )
  return { service: new AppUpdaterService({ enabled: true }), autoUpdater }
}

void test('restarting after a recovered quit resumes periodic update checks', async () => {
  const intervals = new Set()
  const { service, autoUpdater } = await loadUpdater({ app: syntheticApp(), intervals })

  const settle = () => new Promise((resolve) => setImmediate(resolve))

  service.start()
  await settle()
  assert.equal(intervals.size, 1)
  service.stop()
  assert.equal(intervals.size, 0)

  service.start()
  await settle()
  assert.equal(intervals.size, 1)
  for (const interval of intervals) interval.callback()
  await settle()
  assert.equal(autoUpdater.checks, 3)
})

void test('a Linux package install whose quit is cancelled does not relaunch a later quit', async () => {
  const app = syntheticApp()
  const relaunchIntent = await load('../relaunch-intent.ts', { electron: { app } })
  const { service } = await loadUpdater({
    app,
    relaunchIntent,
    intervals: new Set(),
    linuxInstall: {
      resolveLinuxDebInstallPlan: () => ({ debPath: '/synthetic/update.deb' }),
      runLinuxDebInstall: async () => ({ ok: true })
    }
  })
  service.state = { ...service.getState(), phase: 'downloaded' }

  assert.equal((await service.quitAndInstall()).ok, true)
  assert.equal(app.quits, 1)
  assert.equal(app.relaunches, 0)

  // A renderer Stay answer keeps the app running.
  relaunchIntent.cancelRequestedRelaunch()
  // The next ordinary quit reaches `will-quit` without a relaunch request.
  relaunchIntent.relaunchIfRequested()
  assert.equal(app.relaunches, 0)

  assert.equal((await service.quitAndInstall()).ok, true)
  relaunchIntent.relaunchIfRequested()
  assert.equal(app.relaunches, 1)
})

void test('a Sparkle install that fails asynchronously restores hide-on-close windows', async () => {
  let quitting = false
  let emit = () => {}
  const sparkleBridge = {
    init: () => true,
    setEventHandler: (handler) => {
      emit = handler
    },
    setAutomaticChecks() {},
    installUpdateNow() {}
  }
  const { service } = await loadUpdater({
    app: syntheticApp(),
    intervals: new Set(),
    sparkleBridge,
    windowState: {
      setAppQuitting: (next) => {
        quitting = next
      }
    }
  })
  service.start()

  assert.equal((await service.quitAndInstall()).ok, true)
  assert.equal(quitting, true)
  // Sparkle reports install failures only through its asynchronous event channel.
  emit({ type: 'error', message: 'synthetic install failure' })

  assert.equal(service.getState().phase, 'error')
  assert.equal(quitting, false)
})

void test('a Sparkle error during a quit already owned by the barrier keeps windows closing', async () => {
  const app = syntheticApp()
  let quitting = false
  let emit = () => {}
  const { service } = await loadUpdater({
    app,
    intervals: new Set(),
    sparkleBridge: {
      init: () => true,
      setEventHandler: (handler) => {
        emit = handler
      },
      setAutomaticChecks() {},
      installUpdateNow() {}
    },
    windowState: {
      setAppQuitting: (next) => {
        quitting = next
      }
    }
  })
  service.start()
  await service.quitAndInstall()

  // The quit barrier now owns the flag while it closes product windows.
  app.emit('before-quit')
  emit({ type: 'error', message: 'synthetic background check failure' })

  assert.equal(quitting, true)
})
