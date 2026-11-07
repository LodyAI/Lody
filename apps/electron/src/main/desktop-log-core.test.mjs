import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { formatLocalLogDate } from '@lody/shared/node/daily-log-file'
import { createCliProbeTrace, createDesktopLog } from './desktop-log-core.ts'

async function withLogDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lody-desktop-log-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function manualLog(logDir, now = () => new Date('2026-09-24T05:01:04.000Z')) {
  let flush = null
  const log = createDesktopLog({
    logDir,
    scopePrefix: 'desktop:44570',
    now,
    scheduleFlush: (callback) => {
      flush = callback
    }
  })
  return { log, runScheduledFlush: () => flush?.() }
}

void test('distinguishes probe error types without persisting payloads, causes or machine ids', async (t) => {
  const logDir = await withLogDir(t)
  const { log } = manualLog(logDir)
  const trace = createCliProbeTrace({
    getLog: () => log,
    getChildPid: () => undefined,
    now: () => 0
  })
  trace.failure({ _tag: 'IpcConnectError', cause: new Error('fixture-private-cause') }, 800, 1)
  trace.failure(
    { _tag: 'IpcProtocolError', status: 500, responseBody: { secret: 'fixture-private-body' } },
    800,
    2
  )
  trace.success({ pid: 502, machineId: '   ' }, 3)
  log.flushSync()

  const text = await readFile(
    path.join(logDir, `${formatLocalLogDate(new Date('2026-09-24T05:01:04.000Z'))}.log`),
    'utf8'
  )
  assert.doesNotMatch(text, /fixture-private|responseBody|secret/)
  assert.match(text, /IpcConnectError/)
  assert.match(text, /IpcProtocolError/)
})

void test('appends batched, redacted lines to the live rotation of the CLI daily log', async (t) => {
  const logDir = await withLogDir(t)
  const at = new Date('2026-09-24T05:01:04.000Z')
  const live = path.join(logDir, `${formatLocalLogDate(at)}.log.1`)
  await writeFile(live, 'cli line\n')
  const { log, runScheduledFlush } = manualLog(logDir, () => at)

  log.info('lifecycle', 'main process started')
  log.warn(
    '',
    'callback https://lody.ai/auth?code=abc123&state=xyz9 with Bearer eyJhbGciOiJIUzI1NiJ9.x'
  )
  assert.equal(await readFile(live, 'utf8'), 'cli line\n', 'nothing is written before the flush')

  runScheduledFlush()
  const lines = (await readFile(live, 'utf8')).trimEnd().split('\n')
  assert.equal(lines[0], 'cli line')
  assert.equal(
    lines[1],
    '2026-09-24T05:01:04.000Z [INFO] [desktop:44570:lifecycle] main process started'
  )
  assert.match(
    lines[2],
    /\[WARN\] \[desktop:44570\] callback https:\/\/lody\.ai\/auth\?code=\[redacted\]&state=\[redacted\] with Bearer \[redacted\]$/
  )
})

void test('daily desktop logs normalize pairing display forms in strings and formatted objects', async (t) => {
  const logDir = await withLogDir(t)
  const { log } = manualLog(logDir)
  // Synthetic display forms; the logger does not validate protocol checksums.
  const code = '0123456789ABCDEFGHJKMNPQRSTV'
  const forms = [
    code,
    code.toLowerCase(),
    code.match(/.{4}/g).join('--  '),
    code.match(/.{4}/g).join('\n'),
    code.match(/.{4}/g).join('\t'),
    code.match(/.{4}/g).join('\f'),
    code.match(/.{4}/g).join('\v'),
    `lody://pair/${code}`
  ]
  for (const form of forms) log.info('display', form)
  const { formatConsoleArgs } = await import('./desktop-log-core.ts')
  for (const form of forms) log.info('display', formatConsoleArgs([{ value: form }]))
  log.flushSync()
  const text = await readFile(path.join(logDir, '2026-09-24.log'), 'utf8')
  for (const form of forms) assert.equal(text.includes(form), false)
  assert.equal((text.match(/\[redacted\]/g) ?? []).length, forms.length * 2)
})

void test('Host and Core source copies share logging and one run record across partial initialization', () => {
  execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module'], {
    input: `
      import assert from 'node:assert/strict'
      import { readFileSync } from 'node:fs'
      import { stripTypeScriptTypes } from 'node:module'
      import { SourceTextModule, SyntheticModule, createContext } from 'node:vm'
      import { EventEmitter } from 'node:events'
      const source = stripTypeScriptTypes(readFileSync(new URL(${JSON.stringify(new URL('./desktop-log.ts', import.meta.url).href)}), 'utf8'))
      for (const fail of [false, true]) {
        const sink = []
        const records = []
        const app = Object.assign(new EventEmitter(), {
          getVersion: () => 'fixture', getPath: () => '/fixture',
          whenReady: () => new Promise(() => {})
        })
        const owner = Object.assign(new EventEmitter(), {
          pid: 42, versions: {}, platform: 'fixture'
        })
        const context = createContext({ process: owner, console: { error() {} },
          setInterval: () => ({ unref() {} }) })
        const log = Object.fromEntries(['info', 'warn', 'error', 'debug', 'flushSync']
          .map(name => [name, (...args) => sink.push([name, ...args])]))
        const dependencies = {
          electron: { app, powerMonitor: new EventEmitter() },
          'node:fs': { readFileSync: () => { throw new Error('absent') },
            writeFileSync: (path, text) => records.push(JSON.parse(text)) },
          'node:path': { join: (...parts) => parts.join('/') },
          '@lody/shared/node/installation-profile': { getLodyDataDir: () => '/fixture' },
          './platform': { mainPlatformKind: 'local', desktopInstallationProfile: {} },
          './desktop-log-core': {
            createDesktopLog: () => log,
            mirrorConsoleToDesktopLog: () => { if (fail) throw new Error('partial install') },
            createMainThreadLagProbe: () => () => {},
            describePreviousDesktopRun: () => null, parseDesktopRunRecord: () => null
          }
        }
        async function load(identifier) {
          const module = new SourceTextModule(source, { context, identifier })
          await module.link(specifier => {
            const values = dependencies[specifier]
            return new SyntheticModule(Object.keys(values), function () {
              for (const [key, value] of Object.entries(values)) this.setExport(key, value)
            }, { context })
          })
          await module.evaluate()
          return module.namespace
        }
        const host = await load('host/desktop-log')
        host.installDesktopLog()
        host.beginDesktopRunRecord()
        const core = await load('core/desktop-log')
        assert.equal(core.getDesktopLog(), host.getDesktopLog())
        assert.equal(core.installDesktopLog(), host.getDesktopLog())
        core.beginDesktopRunRecord()
        assert.equal(records.length, 1)
        assert.equal(records[0].pid, 42)
        assert.equal(sink.filter(entry => String(entry[2]).includes('main process started')).length, 1)
        sink.length = 0
        core.getDesktopLog().warn('cli', 'Core stderr')
        assert.deepEqual(sink, fail ? [] : [['warn', 'cli', 'Core stderr']])
        if (!fail) {
          app.emit('will-quit')
          assert.equal(records.length, 2)
          assert.equal(records[1].cleanExit, true)
        }
      }
    `,
    stdio: ['pipe', 'pipe', 'pipe']
  })
})
