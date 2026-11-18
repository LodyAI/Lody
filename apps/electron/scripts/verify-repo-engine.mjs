import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'
import { createPackageWithOptions } from '@electron/asar'
import { startEngine } from '@loro-dev/loro-repo-engine'
import {
  connectEngine,
  ensureEngineHost,
  connectSocketTransport
} from '@loro-dev/loro-repo-client/node'
import { RepoClient } from '@loro-dev/loro-repo-client/browser'
import * as addon from '@loro-dev/loro-repo-engine'
import { stageRepoEnginePackage } from './cli-native-deps.mjs'
import { assertTestBuildOutput } from './test-output-boundary.mjs'
import { readCompactedFlock } from './repo-engine-lab/read-compacted-flock.mjs'

const electronDir = resolve(import.meta.dirname, '..')
const checkout = resolve(electronDir, '../..')
const source = join(import.meta.dirname, 'repo-engine-lab')
const output = join(checkout, '.test-build/repo-engine', randomUUID())
const runtime = join(output, 'runtime')
const archive = join(output, 'app.asar')
const require = createRequire(import.meta.url)
const e2eRequire = createRequire(join(checkout, 'e2e/package.json'))
const cliRequire = createRequire(join(checkout, 'apps/cli/package.json'))
const { _electron, expect } = e2eRequire('@playwright/test')
const root = await mkdtemp(join(tmpdir(), 'lody-repo-acceptance-'))
const dataDir = join(root, 'data')
const logs = []
const checks = []
const children = new Set()
let app
let host
let daemon
let inspector
let requestId = 0
let passed = false
let failure
let outputReady = false
const cleanupErrors = []

// Deadlines bound observers, not persistence or successful cleanup. The process
// owner below must still await exit before deleting the disposable directory.
function deadline(promise, label, ms = 30_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`deadline: ${label}`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function child(entry, args = []) {
  const handle = spawn(process.execPath, [join(runtime, entry), ...args], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  children.add(handle)
  handle.stdout.on('data', (chunk) => logs.push(`${entry}: ${chunk}`))
  handle.stderr.on('data', (chunk) => logs.push(`${entry}: ${chunk}`))
  return handle
}

function receive(handle, predicate) {
  return deadline(
    new Promise((resolve, reject) => {
      const cleanup = () => {
        handle.off('message', message)
        handle.off('exit', exited)
        handle.off('error', failed)
      }
      const message = (value) => {
        if (!predicate(value)) return
        cleanup()
        resolve(value)
      }
      const exited = (code, signal) => {
        cleanup()
        reject(new Error(`early child exit: ${code}/${signal}`))
      }
      const failed = (error) => {
        cleanup()
        reject(error)
      }
      handle.on('message', message)
      handle.once('exit', exited)
      handle.once('error', failed)
    }),
    'child response'
  )
}

async function startHost() {
  const handle = child('host.mjs', [dataDir])
  const ready = await receive(handle, (value) => value.type === 'ready')
  assert.equal(ready.version.package, '0.1.0')
  assert.equal(ready.version.protocol, 2)
  return { handle, endpoint: ready.endpoint }
}

async function command(handle, type, fields = {}) {
  const id = ++requestId
  const result = receive(handle, (value) => value.requestId === id)
  handle.send({ type, requestId: id, ...fields })
  const value = await result
  assert.equal(value.type, 'result', JSON.stringify(value))
  return value.result
}

async function stop(handle, force = false) {
  if (!handle || handle.exitCode !== null || handle.signalCode !== null) return
  const ended = once(handle, 'exit')
  if (force) handle.kill('SIGKILL')
  else handle.send({ type: 'stop' })
  await deadline(ended, 'owned child exit')
  children.delete(handle)
}

async function launch() {
  app = await _electron.launch({
    executablePath: require('electron'),
    args: [archive],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SystemRoot: process.env.SystemRoot,
      DISPLAY: process.env.DISPLAY,
      XAUTHORITY: process.env.XAUTHORITY,
      LODY_REPO_LAB_PROFILE: join(root, 'profile'),
      LODY_REPO_LAB_DATA: dataDir
    },
    timeout: 30_000
  })
  app.process().stderr?.on('data', (chunk) => logs.push(`electron: ${chunk}`))
  children.add(app.process())
  await expect.poll(() => app.windows().length).toBe(2)
  const native = await app.evaluate(({ app }) => ({
    version: globalThis.repoLabNativeVersion,
    appPath: app.getAppPath(),
    electron: process.versions.electron
  }))
  assert.deepEqual(native.version, { package: '0.1.0', protocol: 2 })
  assert.equal(native.appPath, archive)
  assert.ok(native.electron)
  const windows = app.windows()
  for (const page of windows) {
    page.on('pageerror', (error) => logs.push(`renderer: ${error.stack}`))
    await page.getByRole('button', { name: 'Connect repository' }).click()
    await expect(page.locator('#state')).toHaveText('connected')
    await expect(page.locator('#ready')).toHaveText('ready')
  }
  return windows
}

try {
  await assertTestBuildOutput(checkout, output)
  await mkdir(runtime, { recursive: true })
  outputReady = true
  for (const name of ['host', 'daemon', 'main']) {
    await build({
      entryPoints: [join(source, `${name}.mjs`)],
      outfile: join(runtime, `${name}.mjs`),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['electron', '@loro-dev/loro-repo-engine'],
      logLevel: 'silent'
    })
  }
  // Browser SDK deliberately bundled for a sandboxed renderer without Node globals.
  await build({
    entryPoints: [join(source, 'renderer.mjs')],
    outfile: join(runtime, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome140',
    logLevel: 'silent'
  })
  await cp(join(source, 'preload.cjs'), join(runtime, 'preload.cjs'))
  await cp(join(source, 'index.html'), join(runtime, 'index.html'))
  await writeFile(
    join(runtime, 'package.json'),
    JSON.stringify({ name: 'lody-repo-acceptance', version: '0.0.0', main: 'main.mjs' })
  )
  const staged = stageRepoEnginePackage(
    dirname(require.resolve('@loro-dev/loro-repo-engine/package.json')),
    join(runtime, 'node_modules'),
    { platform: process.platform, arch: process.arch }
  )
  await createPackageWithOptions(runtime, archive, { unpack: '*.node' })
  const unpacked = join(
    `${archive}.unpacked`,
    'node_modules/@loro-dev/loro-repo-engine',
    staged.binaryName
  )
  assert.ok((await readFile(unpacked)).byteLength > 0)
  checks.push({ name: 'staged-native-binary', version: staged.version, binary: staged.binaryName })
  host = await startHost()
  assert.throws(() => startEngine({ dataDir }), /ENGINE_BUSY/)
  const attached = await ensureEngineHost({ addon, dataDir })
  assert.equal(attached.role, 'client')
  await attached.close()
  inspector = await connectEngine(dataDir, { autoReconnect: false })
  checks.push({ name: 'one-owner-client-close-does-not-stop-host', runId: host.endpoint.runId })
  daemon = child('daemon.mjs', [dataDir])
  await receive(daemon, (value) => value.type === 'ready')
  let pages = await launch()
  for (const page of pages) {
    assert.deepEqual(await page.evaluate(() => window.repoAcceptance.directory()), [
      { docId: 'session-acceptance', exists: true, meta: { title: 'Native directory acceptance' } }
    ])
  }
  checks.push({ name: 'shared-directory-query-against-native-meta' })
  await pages[0].getByLabel('Message').fill('中文 renderer input')
  await pages[0].getByRole('button', { name: 'Send message' }).click()
  await expect(pages[0].locator('#ack')).toHaveText('中文 renderer input')
  for (const page of pages)
    await expect(page.locator('#history')).toContainText('中文 renderer input')
  assert.equal((await command(daemon, 'read')).value.history[0].text, '中文 renderer input')
  const reply = await command(daemon, 'append', { id: 'assistant-1', text: 'daemon reply' })
  for (const page of pages) {
    await expect(page.locator('#history')).toContainText('daemon reply')
    await page.evaluate((txId) => window.repoAcceptance.watermark(txId), reply.txId)
    assert.equal(await page.evaluate(() => window.repoAcceptance.closedWaiter()), 'rejected')
  }
  checks.push({ name: 'renderer-node-renderer-conversation-and-subscription-barriers' })
  const changed = await command(daemon, 'flock', { id: 'p1', text: 'project from daemon' })
  for (const page of pages) {
    await expect(page.locator('#projects')).toContainText('project from daemon')
    // This namespace watermark came from another room, not the history subtree.
    await page.evaluate((txId) => window.repoAcceptance.watermark(txId), changed.txId)
  }
  const ns = 'lody-native-acceptance'
  const fr = { kind: 'flock', id: `${ns}:wf:workspace` }
  const snapshot = await inspector.flockScan(ns, fr)
  await inspector.flockBatch(ns, fr, [{ op: 'delete', key: ['project', 'p1'] }])
  await assert.rejects(
    inspector.flockBatch(ns, fr, [{ op: 'put', key: ['stale'], value: true }], {
      precondition: { mode: 'cas', expected_room_tx_id: snapshot.roomTxId }
    }),
    (error) => error.code === 'precondition_failed'
  )
  for (const page of pages)
    await expect(page.locator('#projects')).not.toContainText('project from daemon')
  checks.push({ name: 'flock-prefix-delete-CAS-and-cross-room-watermark' })
  // Drop the response only AFTER the real engine has committed the mutation.
  // The caller must observe unknown outcome, then reconcile by stable identity.
  const socket = await connectSocketTransport(host.endpoint.socket)
  let responses = 0
  const uncertain = new RepoClient({
    send: (text) => socket.send(text),
    onMessage: () =>
      socket.onMessage(() => {
        responses++
        void socket.close()
      }),
    onClose: (callback) => socket.onClose(callback),
    close: () => socket.close()
  })
  try {
    await assert.rejects(
      uncertain.flockBatch(ns, fr, [
        { op: 'put', key: ['receipt', 'lost-ack'], value: { operationId: 'lost-ack', count: 1 } }
      ]),
      /disconnected/
    )
    assert.equal(responses, 1)
    const committed = await inspector.flockGet(ns, fr, ['receipt', 'lost-ack'])
    assert.deepEqual(committed.value, { operationId: 'lost-ack', count: 1 })
  } finally {
    await uncertain.close()
  }
  checks.push({ name: 'lost-ack-is-unknown-but-commit-is-reconcilable-without-replay' })
  // Real legacy codecs, no JSON reconstruction of CRDT state. This pins import
  // primitives only; full multi-source migration and Flock coverage remain open.
  const { LoroDoc, LoroMap, LoroText } = cliRequire('loro-crdt')
  const { Flock } = cliRequire('@loro-dev/flock-wasm')
  const legacyDoc = new LoroDoc()
  legacyDoc.getMap('session').set('id', 'imported')
  const item = legacyDoc.getList('history').insertContainer(0, new LoroMap())
  item.set('id', 'legacy-turn')
  item.set('role', 'assistant')
  item.setContainer('text', new LoroText()).insert(0, 'legacy snapshot')
  legacyDoc.commit()
  const importedDoc = { kind: 'loro_doc', id: 'session-imported' }
  await inspector.createRoom(ns, importedDoc)
  await inspector.importRoomState(ns, importedDoc, {
    snapshot: legacyDoc.export({ mode: 'snapshot' }),
    enqueueOutbox: false
  })
  assert.equal(
    (await inspector.readDoc(ns, importedDoc, ['history', 0, 'text'])).value,
    'legacy snapshot'
  )
  const exported = new LoroDoc()
  exported.import((await inspector.exportLoroRaw(ns, importedDoc)).bytes)
  assert.equal(exported.getMap('session').get('id'), 'imported')
  assert.equal(exported.getList('history').get(0).get('text').kind(), 'Text')
  const legacyFlock = new Flock()
  legacyFlock.put(['project', 'retained'], { title: 'legacy project' })
  legacyFlock.put(['project', 'deleted'], { title: 'removed' })
  legacyFlock.delete(['project', 'deleted'])
  const importedFlock = { kind: 'flock', id: `${ns}:wf:imported` }
  await inspector.createRoom(ns, importedFlock)
  await inspector.importRoomState(ns, importedFlock, {
    snapshot: legacyFlock.exportFile(),
    enqueueOutbox: false
  })
  assert.equal(
    (await inspector.flockGet(ns, importedFlock, ['project', 'retained'])).value.title,
    'legacy project'
  )
  assert.equal((await inspector.flockGet(ns, importedFlock, ['project', 'deleted'])).found, false)
  checks.push({ name: 'legacy-Loro-and-Flock-binary-import-with-Loro-container-round-trip' })
  // Probe a possible fixed-version compatibility reader instead of assuming
  // missing public export makes migration impossible. Compaction + a single
  // read transaction preserves native tombstones/clocks, unlike scan -> put.
  assert.throws(() => readCompactedFlock(dataDir, ns, importedFlock), /not fully compacted/)
  await inspector.compactRoom(ns, importedFlock)
  const oldState = readCompactedFlock(dataDir, ns, importedFlock)
  const restoredFlock = new Flock()
  restoredFlock.strictImportFile(oldState.bytes)
  for (const key of [
    ['project', 'retained'],
    ['project', 'deleted']
  ]) {
    assert.deepEqual(restoredFlock.getEntry(key), legacyFlock.getEntry(key))
  }
  await inspector.flockBatch(ns, importedFlock, [
    { op: 'put', key: ['project', 'native'], value: { title: 'native write' } },
    { op: 'delete', key: ['project', 'retained'] }
  ])
  assert.throws(() => readCompactedFlock(dataDir, ns, importedFlock), /not fully compacted/)
  await inspector.compactRoom(ns, importedFlock)
  const nativeState = readCompactedFlock(dataDir, ns, importedFlock)
  assert.ok(nativeState.roomTxId > oldState.roomTxId)
  const rollbackFlock = new Flock()
  rollbackFlock.strictImportFile(nativeState.bytes)
  // Merge the stale device AFTER rollback. Old values must not resurrect.
  rollbackFlock.merge(legacyFlock)
  assert.equal(rollbackFlock.get(['project', 'retained']), undefined)
  assert.equal(rollbackFlock.get(['project', 'deleted']), undefined)
  assert.equal(rollbackFlock.get(['project', 'native']).title, 'native write')
  assert.ok(rollbackFlock.getEntry(['project', 'retained']))
  const roundTripFlock = { kind: 'flock', id: `${ns}:wf:roundtrip` }
  await inspector.createRoom(ns, roundTripFlock)
  await inspector.importRoomState(ns, roundTripFlock, {
    snapshot: rollbackFlock.exportFile(),
    enqueueOutbox: false
  })
  assert.equal((await inspector.flockGet(ns, roundTripFlock, ['project', 'retained'])).found, false)
  assert.equal(
    (await inspector.flockGet(ns, roundTripFlock, ['project', 'native'])).value.title,
    'native write'
  )
  checks.push({ name: 'pinned-SQLite-compacted-Flock-round-trip-preserves-tombstones-and-clocks' })
  await stop(daemon)
  daemon = undefined
  await inspector.close()
  inspector = undefined
  const oldRunId = host.endpoint.runId
  await stop(host.handle, true)
  host = undefined
  for (const page of pages) await expect(page.locator('#state')).toHaveText('closed')
  assert.equal(await app.evaluate(({ app }) => app.isReady()), true)
  host = await startHost()
  assert.notEqual(host.endpoint.runId, oldRunId)
  for (const page of pages) {
    await page.getByRole('button', { name: 'Connect repository' }).click()
    await expect(page.locator('#state')).toHaveText('connected')
    await expect(page.locator('#ready')).toHaveText('ready')
    await expect(page.locator('#reset')).toHaveText('reconnect')
    await expect(page.locator('#history')).toContainText('daemon reply')
    await expect(page.locator('#projects')).not.toContainText('project from daemon')
  }
  checks.push({ name: 'host-SIGKILL-isolation-new-generation-and-subscription-reset' })
  await app.close()
  app = undefined
  await stop(host.handle)
  host = undefined
  host = await startHost()
  pages = await launch()
  for (const page of pages)
    await expect(page.locator('#history')).toContainText('中文 renderer input')
  checks.push({ name: 'cold-Electron-and-host-reopen-preserves-acknowledged-history' })
  await pages[0].screenshot({ path: join(output, 'acceptance.png') })
  passed = true
} catch (error) {
  failure = error
} finally {
  if (app) {
    try {
      for (const [index, page] of app.windows().entries()) {
        logs.push(`final-renderer: ${await page.locator('body').innerText()}`)
        if (!passed) await page.screenshot({ path: join(output, `failure-${index}.png`) })
      }
    } catch (error) {
      logs.push(`renderer evidence unavailable: ${String(error)}`)
    }
  }
  const cleanup = await Promise.allSettled([
    app && deadline(app.close(), 'Electron close'),
    inspector?.close(),
    stop(daemon),
    host && stop(host.handle)
  ])
  // Reap only processes created by this runner. Never attach to a user daemon.
  const remaining = [...children].filter(
    (handle) => handle.exitCode === null && handle.signalCode === null
  )
  const forced = await Promise.allSettled(remaining.map((handle) => stop(handle, true)))
  if (outputReady) await writeFile(join(output, 'console.log'), logs.join('\n'))
  cleanupErrors.push(
    ...[...cleanup, ...forced]
      .filter((value) => value.status === 'rejected')
      .map((value) => value.reason)
  )
  if ([...children].some((handle) => handle.exitCode === null && handle.signalCode === null)) {
    cleanupErrors.push(new Error(`repo_lab_cleanup_unconfirmed: retained ${root}`))
  } else {
    await rm(root, { recursive: true, force: true })
  }
  const result = {
    status: passed && cleanupErrors.length === 0 ? 'passed' : 'failed',
    artifacts: output,
    platform: process.platform,
    arch: process.arch,
    checks,
    error: failure?.stack,
    cleanupErrors: cleanupErrors.map((error) => String(error)),
    scope:
      'synthetic Electron ASAR / SDK clients; no product migration, cloud, or signing acceptance'
  }
  if (outputReady) await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
if (failure || cleanupErrors.length)
  throw new AggregateError(
    [failure, ...cleanupErrors].filter(Boolean),
    'Repo engine acceptance failed'
  )
