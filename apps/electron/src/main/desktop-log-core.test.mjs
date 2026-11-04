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
