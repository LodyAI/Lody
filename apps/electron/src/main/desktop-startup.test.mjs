import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createConnection, createServer, Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { acquireDesktopLease } from './services/desktop-exclusion.ts'

const electronRoot = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
let root
let entryCode
let applicationImport
let CliSupervisor
const hostApi = require('@lody/shared/node/local-cli-host-lease')

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'lody-desktop-startup-'))
  // Use the real Electron bundler: an eager/inline import of application or
  // credentials must fail these tests, even if unbundled source looks lazy.
  const resolved = await resolveConfig(
    {
      root: electronRoot,
      configFile: join(electronRoot, 'electron.vite.config.ts'),
      mode: 'oss'
    },
    'build',
    'oss'
  )
  const config = resolved.config.main
  const result = await build({
    ...config,
    configFile: false,
    logLevel: 'silent',
    define: {
      ...config.define,
      'import.meta.env.VITE_LODY_PLATFORM': JSON.stringify('cloud'),
      'import.meta.env.VITE_LODY_RELEASE_CHANNEL': JSON.stringify('nightly')
    },
    build: { ...config.build, write: false, outDir: root }
  })
  const output = (Array.isArray(result) ? result[0] : result).output
  entryCode = output.find((item) => item.type === 'chunk' && item.isEntry).code
  const application = output.find(
    (item) =>
      item.type === 'chunk' && item.facadeModuleId === join(electronRoot, 'src/main/application.ts')
  )
  assert.ok(application, 'business application must remain a separate, lazy module')
  applicationImport = `./${application.fileName}`
  const supervisorBuild = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      outDir: root,
      minify: false,
      lib: {
        entry: join(electronRoot, '../../packages/cli-supervisor/src/supervisor.ts'),
        formats: ['cjs']
      }
    }
  })
  const supervisorExports = {}
  runInNewContext(
    (Array.isArray(supervisorBuild) ? supervisorBuild[0] : supervisorBuild).output.find(
      (item) => item.type === 'chunk'
    ).code,
    {
      exports: supervisorExports,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      AbortController,
      DOMException,
      console
    }
  )
  CliSupervisor = supervisorExports.CliSupervisor
})
after(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

function launch(
  t,
  { port = 0, hostPort, sameAppPrimary = true, packaged = true, e2e = false } = {}
) {
  const ready = Promise.withResolvers()
  const completed = Promise.withResolvers()
  const events = []
  const paths = new Map([['appData', root]])
  const sockets = []
  const timers = new Set()
  let executionHost
  let reservedHostPort = hostPort
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged,
    commandLine: { getSwitchValue: () => '', appendSwitch() {} },
    getPath: (key) => paths.get(key),
    setPath: (key, value) => paths.set(key, value),
    setName: (name) => events.push(['name', name]),
    setDesktopName() {},
    requestSingleInstanceLock() {
      // macOS may deliver the callback before ready and while acquiring a lease.
      const event = { preventDefault() {} }
      app.emit('open-url', event, 'ai.lody.nightly://auth/callback#synthetic-attempt')
      return sameAppPrimary
    },
    whenReady: () => ready.promise,
    quit() {
      app.emit('will-quit')
      events.push(['quit'])
      completed.resolve()
    },
    exit(code) {
      app.emit('will-quit')
      events.push(['exit', code])
      completed.resolve()
    }
  })
  const electron = {
    app,
    protocol: { registerSchemesAsPrivileged: () => events.push(['scheme']) },
    dialog: {
      showMessageBox: async (options) => {
        events.push(['conflict', options.message, options.detail])
      },
      showErrorBox: () => {
        events.push(['fatal'])
      }
    }
  }
  t.after(async () => {
    for (const timer of timers) clearInterval(timer)
    await Promise.all(sockets.map((server) => new Promise((resolve) => server.close(resolve))))
  })
  const net = {
    createConnection() {
      // No fixture may touch the user's fixed Host port or named pipe.
      if (reservedHostPort) return createConnection({ host: '127.0.0.1', port: reservedHostPort })
      const socket = new Socket()
      queueMicrotask(() =>
        socket.emit('error', Object.assign(new Error('not listening'), { code: 'ECONNREFUSED' }))
      )
      return socket
    },
    createServer(handler) {
      const server = createServer(handler)
      const listen = server.listen.bind(server)
      server.listen = (options, callback) => {
        if (typeof options === 'object') return listen({ ...options, port }, callback)
        return listen({ host: '127.0.0.1', port: reservedHostPort ?? 0 }, () => {
          reservedHostPort = server.address().port
        })
      }
      sockets.push(server)
      return server
    }
  }
  const application = {
    startApplication(host) {
      executionHost = host
    },
    handleDesktopLaunch(event) {
      events.push(['launch', JSON.parse(JSON.stringify(event))])
    }
  }
  runInNewContext(entryCode, {
    exports: {},
    console: {
      ...console,
      error: (...args) => {
        events.push(['error', ...args.map(String)])
      }
    },
    process: { ...process, env: { LODY_E2E: e2e ? '1' : '0' }, argv: ['electron'] },
    URL,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval(callback, delay, ...args) {
      const timer = setInterval(() => callback(...args), delay)
      timers.add(timer)
      return timer
    },
    clearInterval,
    require(id) {
      if (id === 'electron') return electron
      if (id === 'node:net') return net
      if (id === 'node:os') return { ...require(id), tmpdir: () => root }
      if (id === applicationImport) {
        events.push(['application'])
        // Resolve after launch replay, without timing sleeps.
        queueMicrotask(() => queueMicrotask(() => completed.resolve()))
        return application
      }
      if (id.startsWith('node:') || id === 'zod' || id === 'image-dimensions') return require(id)
      throw new Error(`Forbidden pre-ownership dependency: ${id}`)
    },
    __dirname: root
  })
  ready.resolve()
  return {
    done: completed.promise,
    events,
    paths,
    getExecutionHost: () => executionHost,
    getHostPort: () => reservedHostPort
  }
}

void test('bundled entry refuses another channel before loading credential/application modules', async (t) => {
  const owner = await acquireDesktopLease({ host: '127.0.0.1', port: 0 })
  t.after(() => owner.close())
  const run = launch(t, { port: owner.port, e2e: true })
  await run.done
  assert.deepEqual(
    run.events.filter(([name]) => !['scheme', 'name'].includes(name)).map(([name]) => name),
    ['conflict', 'quit']
  )
  assert.equal(run.paths.get('userData'), join(root, 'Lody Nightly'))
  assert.equal(run.paths.get('sessionData'), join(root, 'Lody Nightly'))
})

void test('bundled entry imports application after ownership and replays the early login', async (t) => {
  const run = launch(t)
  await run.done
  assert.ok(!run.events.some(([name]) => name === 'fatal'), JSON.stringify(run.events))
  assert.deepEqual(
    run.events.filter(([name]) => name === 'application' || name === 'launch'),
    [['application'], ['launch', { url: 'ai.lody.nightly://auth/callback#synthetic-attempt' }]]
  )
})

void test('same-app secondary exits without starting a second application', async (t) => {
  const run = launch(t, { sameAppPrimary: false })
  await run.done
  assert.ok(run.events.some(([name]) => name === 'quit'))
  assert.ok(!run.events.some(([name]) => name === 'application' || name === 'conflict'))
})

async function listeningHost(t, record) {
  const server = createServer((socket) => {
    socket.on('error', () => socket.destroy())
    socket.end(`${JSON.stringify(record)}\n`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { server, port: server.address().port }
}

for (const mode of ['daemon', 'electron', 'foreground']) {
  void test(`Nightly refuses the existing ${mode} Host before authentication and leaves it running`, async (t) => {
    const record = {
      version: 1,
      instanceId: `external-${mode}`,
      pid: process.pid,
      mode,
      startedAtMs: 1
    }
    const owner = await listeningHost(t, record)
    const run = launch(t, { hostPort: owner.port })
    await run.done
    assert.ok(
      !run.events.some(([name]) => ['application', 'fatal'].includes(name)),
      JSON.stringify(run.events)
    )
    const conflict = run.events.find(([name]) => name === 'conflict')
    assert.ok(conflict)
    if (mode === 'daemon') assert.match(conflict[2], /lody daemon stop/)
    assert.equal(owner.server.listening, true)
    const endpoint = { kind: 'tcp', host: '127.0.0.1', port: owner.port }
    assert.deepEqual(await hostApi.inspectLocalCliHost(endpoint), record)
    assert.equal(run.getExecutionHost(), undefined)
    assert.ok(run.events.some(([name]) => name === 'quit'))
  })
}

void test('an occupied Host with an invalid record cannot pass the startup gate', async (t) => {
  const owner = await listeningHost(t, { invalid: true })
  const run = launch(t, { hostPort: owner.port })
  await run.done
  assert.ok(
    run.events.some(([name]) => name === 'conflict'),
    JSON.stringify(run.events)
  )
  assert.ok(!run.events.some(([name]) => name === 'application'))
  assert.equal(owner.server.listening, true)
})

void test('after the external Host stops, the next launch reserves its own execution identity', async (t) => {
  const owner = await listeningHost(t, {
    version: 1,
    instanceId: 'daemon',
    pid: process.pid,
    mode: 'daemon',
    startedAtMs: 1
  })
  const blocked = launch(t, { hostPort: owner.port })
  await blocked.done
  assert.equal(blocked.getExecutionHost(), undefined)
  await new Promise((resolve) => owner.server.close(resolve))
  const next = launch(t, { hostPort: owner.port })
  await next.done
  const host = next.getExecutionHost()
  assert.ok(host, JSON.stringify(next.events))
  assert.notEqual(host.instanceId, 'daemon')
  const record = await hostApi.inspectLocalCliHost({
    kind: 'tcp',
    host: '127.0.0.1',
    port: owner.port
  })
  assert.equal(record.instanceId, host.instanceId)
  assert.equal(record.mode, 'electron')
  assert.equal(record.pid, process.pid)
})

void test('stopping and restarting a borrowed Supervisor never releases Nightly Host ownership', async (t) => {
  const run = launch(t)
  await run.done
  const host = run.getExecutionHost()
  assert.ok(host, JSON.stringify(run.events))
  const endpoint = { kind: 'tcp', host: '127.0.0.1', port: run.getHostPort() }
  let started = 0
  const supervisor = new CliSupervisor({
    ownership: host.ownership,
    existingRuntimePolicy: 'reject',
    fetchRuntimeState: async () => null,
    decideExit: () => ({ action: 'stop' }),
    prepareLaunch: async () => ({
      spawn() {
        started++
        const result = Promise.withResolvers()
        const child = Object.assign(new EventEmitter(), {
          pid: 100 + started,
          exitCode: null,
          signalCode: null,
          killed: false,
          kill() {
            throw new Error('Test child exits through private IPC only')
          }
        })
        return {
          child,
          result: result.promise,
          requestShutdown() {
            child.exitCode = 0
            result.resolve({ code: 0, stdout: '', stderr: '' })
            child.emit('close', 0, null)
          }
        }
      }
    })
  })
  t.after(() => supervisor.stop())
  await supervisor.start()
  assert.equal(started, 1)
  await supervisor.stop()
  assert.equal(supervisor.getState().desiredState, 'stopped')
  const contender = await hostApi.acquireLocalCliHostLease({
    endpoint,
    mode: 'daemon',
    instanceId: 'competitor'
  })
  if (contender.status === 'acquired') t.after(() => contender.lease.close())
  assert.equal(contender.status, 'occupied')
  assert.equal(contender.record.instanceId, host.instanceId)
  await supervisor.start()
  assert.equal(started, 2)
  await supervisor.restart()
  assert.equal(started, 3)
  assert.equal((await hostApi.inspectLocalCliHost(endpoint)).instanceId, host.instanceId)
})
