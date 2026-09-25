import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { formatLocalLogDate } from '@lody/shared/node/daily-log-file'
import {
  createDesktopLog,
  createMainThreadLagProbe,
  describePreviousDesktopRun,
  mirrorConsoleToDesktopLog,
  parseDesktopRunRecord
} from './desktop-log-core.ts'

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

void test('flushSync writes pending lines immediately for exit and crash paths', async (t) => {
  const logDir = await withLogDir(t)
  const { log } = manualLog(logDir)
  log.error('fatal', 'uncaughtException in main process')
  log.flushSync()
  const text = await readFile(
    path.join(logDir, `${formatLocalLogDate(new Date('2026-09-24T05:01:04.000Z'))}.log`),
    'utf8'
  )
  assert.equal(
    text,
    '2026-09-24T05:01:04.000Z [ERROR] [desktop:44570:fatal] uncaughtException in main process\n'
  )
})

void test('console mirroring keeps the original output and records the formatted arguments', async (t) => {
  const logDir = await withLogDir(t)
  const { log } = manualLog(logDir)
  const printed = []
  const fakeConsole = {
    log: (...args) => printed.push(['log', ...args]),
    info: (...args) => printed.push(['info', ...args]),
    warn: (...args) => printed.push(['warn', ...args]),
    error: (...args) => printed.push(['error', ...args]),
    debug: (...args) => printed.push(['debug', ...args])
  }
  const restore = mirrorConsoleToDesktopLog(fakeConsole, log)
  fakeConsole.error('[Electron] Quit blocked by the embedded CLI', new Error('timed out'))
  fakeConsole.info('[Auth] login transition', { phase: 'idle' })
  restore()
  fakeConsole.warn('after restore')
  log.flushSync()

  assert.equal(printed.length, 3)
  assert.equal(printed[0][0], 'error')
  const text = await readFile(
    path.join(logDir, `${formatLocalLogDate(new Date('2026-09-24T05:01:04.000Z'))}.log`),
    'utf8'
  )
  assert.match(
    text,
    /\[ERROR\] \[desktop:44570\] \[Electron\] Quit blocked by the embedded CLI Error: timed out\n\s+at /
  )
  assert.match(text, /\[INFO\] \[desktop:44570\] \[Auth\] login transition \{ phase: 'idle' \}\n/)
  assert.doesNotMatch(text, /after restore/)
})

void test('a run record left unclean names the previous desktop process', () => {
  assert.equal(
    describePreviousDesktopRun(
      parseDesktopRunRecord(
        '{"pid":44570,"startedAt":"2026-09-24T05:01:04.000Z","cleanExit":false}'
      )
    ),
    'previous desktop run pid=44570 startedAt=2026-09-24T05:01:04.000Z ended without a clean quit (crash, force quit, or OS kill); check DiagnosticReports for a matching crash report'
  )
  assert.equal(
    describePreviousDesktopRun(
      parseDesktopRunRecord('{"pid":44570,"startedAt":"2026-09-24T05:01:04.000Z","cleanExit":true}')
    ),
    null
  )
  assert.equal(parseDesktopRunRecord('not json'), null)
  assert.equal(parseDesktopRunRecord('{"pid":"44570"}'), null)
})

void test('the main-thread lag probe reports only stalls past the threshold', () => {
  const warnings = []
  const clock = { now: 0, cpuMs: 0 }
  const probe = createMainThreadLagProbe({
    log: { warn: (scope, message) => warnings.push(`${scope} ${message}`) },
    now: () => clock.now,
    cpuMs: () => clock.cpuMs,
    intervalMs: 1_000,
    warnThresholdMs: 2_000
  })
  clock.now = 1_500
  probe()
  clock.now = 6_500
  clock.cpuMs = 4_800
  probe()
  assert.deepEqual(warnings, [
    'event-loop main process timer fired 4000ms late (elapsed=5000ms cpu=4800ms cpuRatio=0.96)'
  ])
})

void test('a renderer console flood is rate-limited and the dropped count is reported', async (t) => {
  const logDir = await withLogDir(t)
  const { log } = manualLog(logDir)
  const clock = { now: 0 }
  const fakeConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} }
  mirrorConsoleToDesktopLog(fakeConsole, log, {
    now: () => clock.now,
    maxLinesPerWindow: 2,
    windowMs: 1_000
  })
  for (let index = 0; index < 5; index += 1) fakeConsole.warn(`renderer error ${index}`)
  clock.now = 1_000
  fakeConsole.warn('after the window')
  log.flushSync()

  const text = await readFile(
    path.join(logDir, `${formatLocalLogDate(new Date('2026-09-24T05:01:04.000Z'))}.log`),
    'utf8'
  )
  const messages = text
    .trimEnd()
    .split('\n')
    .map((line) => line.replace(/^\S+ /, ''))
  assert.deepEqual(messages, [
    '[WARN] [desktop:44570] renderer error 0',
    '[WARN] [desktop:44570] renderer error 1',
    '[WARN] [desktop:44570:console] suppressed 3 console line(s) over the 1000ms rate limit of 2',
    '[WARN] [desktop:44570] after the window'
  ])
})
