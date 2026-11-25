import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { sparkleEventToStatePatch } from './app-updater-sparkle-events.ts'
import {
  readSparkleFeedUrlFromInfoPlist,
  resolveSparkleAppcastUrl,
  shouldRefreshStaleSparkleDownload
} from './app-updater-sparkle-policy.ts'

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
      Buffer,
      Date,
      Promise,
      AbortSignal,
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
  windowState = { setAppQuitting() {} },
  fsStub,
  fetchStub,
  processOverrides = {}
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
  const dependencies = {
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
      readSparkleFeedUrlFromInfoPlist,
      shouldRefreshStaleSparkleDownload,
      shouldUseSparkleUpdater: () => sparkleBridge !== undefined,
      sparklePackageJsonPathFromModuleEntry: () => undefined,
      resolveSparkleAddonPath: () => '/synthetic/sparkle.node',
      resolveSparkleAppcastUrl: (input) =>
        fsStub || processOverrides.env?.SPARKLE_APPCAST_URL
          ? resolveSparkleAppcastUrl(input)
          : 'https://synthetic.invalid/appcast.xml'
    }
  }
  if (fsStub) {
    dependencies['node:fs'] = fsStub
  }
  const { AppUpdaterService } = await load('./app-updater-service.ts', dependencies, {
    process: { platform: 'linux', env: {}, resourcesPath: '/synthetic', ...processOverrides },
    globalThis: { fetch: fetchStub },
    setInterval: (callback) => {
      const handle = { callback }
      intervals.add(handle)
      return handle
    },
    clearInterval: (handle) => intervals.delete(handle)
  })
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

function sparkleAppcastXml(version) {
  return `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
  <channel>
    <item>
      <sparkle:version>${version}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <enclosure url="https://updates.lody.ai/production/arm64/Lody-${version}-arm64.zip" length="100" />
    </item>
  </channel>
</rss>`
}

void test('packaged Sparkle init reads SUFeedURL from Info.plist instead of overriding with the OSS default', async () => {
  const initOptions = []
  const plistPath = '/Applications/Lody.app/Contents/Info.plist'
  const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>SUFeedURL</key>
  <string>https://updates.lody.ai/production/arm64/appcast.xml</string>
</dict></plist>`
  const { service } = await loadUpdater({
    app: syntheticApp(),
    intervals: new Set(),
    processOverrides: {
      platform: 'darwin',
      resourcesPath: '/Applications/Lody.app/Contents/Resources'
    },
    fsStub: {
      appendFileSync() {},
      existsSync: (target) => target === plistPath,
      readFileSync: (target) => {
        if (target === plistPath) return plistXml
        throw new Error(`unexpected read: ${target}`)
      }
    },
    sparkleBridge: {
      init(options) {
        initOptions.push(options)
        return true
      },
      setEventHandler() {},
      setAutomaticChecks() {},
      checkForUpdates() {},
      discardDownloadedUpdate() {},
      installUpdateNow() {}
    }
  })

  service.start()

  assert.equal(initOptions.length, 1)
  assert.equal(initOptions[0].appcastUrl, 'https://updates.lody.ai/production/arm64/appcast.xml')
})

void test('stale downloaded Sparkle update stays intact on 304/same-version/network errors and supersedes when a newer release ships', async () => {
  const intervals = new Set()
  const actions = []
  const seenHeaders = []
  let emit = () => {}
  let responsePlan = 'same'

  const { service } = await loadUpdater({
    app: syntheticApp(),
    intervals,
    processOverrides: {
      platform: 'darwin',
      getSystemVersion: () => '15.6.1'
    },
    fetchStub: async (_url, init) => {
      seenHeaders.push(init?.headers)
      if (responsePlan === 'same') {
        return new Response(sparkleAppcastXml('0.115.1'), {
          status: 200,
          headers: { etag: '"etag-115"' }
        })
      }
      if (responsePlan === 'not-modified') {
        return new Response(null, { status: 304 })
      }
      if (responsePlan === 'offline') {
        throw new Error('network offline')
      }
      return new Response(sparkleAppcastXml('0.116.1'), {
        status: 200,
        headers: { etag: '"etag-116"' }
      })
    },
    sparkleBridge: {
      init: () => true,
      setEventHandler: (handler) => {
        emit = handler
      },
      setAutomaticChecks() {},
      discardDownloadedUpdate() {
        actions.push('discard')
      },
      checkForUpdates() {
        actions.push('check')
      },
      installUpdateNow() {}
    }
  })

  service.start()
  assert.equal(intervals.size, 0)

  emit({ type: 'update-downloaded', version: '0.115.1' })
  assert.equal(service.getState().phase, 'downloaded')
  assert.equal(intervals.size, 1)

  const sameResult = await service.checkForUpdates()
  assert.equal(sameResult.started, true)
  assert.equal(service.getState().phase, 'downloaded')
  assert.equal(service.getState().downloadedVersion, '0.115.1')
  assert.deepEqual(actions, [])

  responsePlan = 'not-modified'
  await service.checkForUpdates()
  assert.equal(seenHeaders[1]?.['If-None-Match'], '"etag-115"')
  assert.equal(service.getState().phase, 'downloaded')
  assert.deepEqual(actions, [])

  responsePlan = 'offline'
  const offlineResult = await service.checkForUpdates()
  assert.equal(offlineResult.started, false)
  assert.equal(service.getState().phase, 'downloaded')
  assert.equal(service.getState().downloadedVersion, '0.115.1')
  assert.deepEqual(actions, [])

  responsePlan = 'newer'
  const [timer] = intervals
  timer.callback()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(actions, ['discard', 'check'])
  assert.equal(service.getState().phase, 'checking')
  assert.equal(intervals.size, 0)

  emit({ type: 'update-downloaded', version: '0.116.1' })
  assert.equal(intervals.size, 1)
  service.stop()
  assert.equal(intervals.size, 0)
  service.start()
  assert.equal(intervals.size, 1)
})

void test('an in-flight Sparkle feed probe does not discard an update once quitAndInstall begins', async () => {
  const intervals = new Set()
  const actions = []
  let emit = () => {}
  let resolveFetch

  const { service } = await loadUpdater({
    app: syntheticApp(),
    intervals,
    processOverrides: {
      platform: 'darwin',
      getSystemVersion: () => '15.6.1'
    },
    fetchStub: () =>
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    sparkleBridge: {
      init: () => true,
      setEventHandler: (handler) => {
        emit = handler
      },
      setAutomaticChecks() {},
      discardDownloadedUpdate() {
        actions.push('discard')
      },
      checkForUpdates() {
        actions.push('check')
      },
      installUpdateNow() {
        actions.push('install')
      }
    }
  })

  service.start()
  emit({ type: 'update-downloaded', version: '0.115.1' })
  const pendingCheck = service.checkForUpdates()

  assert.equal((await service.quitAndInstall()).ok, true)
  assert.equal(intervals.size, 0)

  resolveFetch(new Response(sparkleAppcastXml('0.116.1'), { status: 200 }))
  await pendingCheck

  assert.deepEqual(actions, ['install'])
  assert.equal(service.getState().phase, 'downloaded')
})
