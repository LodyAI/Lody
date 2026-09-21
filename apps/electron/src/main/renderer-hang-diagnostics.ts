import { app, type BrowserWindow, type Session } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRendererHangLog, withDiagnosticTimeout } from './renderer-hang-log'
import type { HangIncident } from './renderer-hang-watchdog'

const STACK_LIMIT = 64 * 1024
const SAMPLE_LIMIT = 2 * 1024 * 1024
const registeredSessions = new WeakSet<Session>()
const productContents = new Map<number, (url: string) => boolean>()
const pendingStacks = new WeakSet<Electron.WebContents>()
let writeLog: ReturnType<typeof createRendererHangLog> | undefined
let sampleRunning = false
let lastSampleAt = -Infinity

export function enableRendererHangStacks(): void {
  const features = app.commandLine.getSwitchValue('enable-features').split(',').filter(Boolean)
  features.push('DocumentPolicyIncludeJSCallStacksInCrashReports')
  app.commandLine.appendSwitch('enable-features', [...new Set(features)].join(','))
}

/** Opt in only trusted product main documents, never embedded or external pages. */
export function registerRendererHangDocument(
  window: BrowserWindow,
  isTrusted: (url: string) => boolean
): void {
  const { webContents } = window
  const id = webContents.id
  productContents.set(id, isTrusted)
  webContents.once('destroyed', () => productContents.delete(id))
  const session = webContents.session
  if (registeredSessions.has(session)) return
  registeredSessions.add(session)
  session.webRequest.onHeadersReceived((details, callback) => {
    if (
      details.resourceType !== 'mainFrame' ||
      !productContents.get(details.webContentsId ?? -1)?.(details.url)
    ) {
      callback({})
      return
    }
    const headers = { ...details.responseHeaders }
    const key = Object.keys(headers).find((name) => name.toLowerCase() === 'document-policy')
    const existing = key ? headers[key].join(', ') : ''
    if (key) delete headers[key]
    headers['Document-Policy'] = [
      [existing, 'include-js-call-stacks-in-crash-reports'].filter(Boolean).join(', ')
    ]
    callback({ responseHeaders: headers })
  })
}

function persist(entry: Record<string, unknown>): void {
  writeLog ??= createRendererHangLog(path.join(app.getPath('logs'), 'renderer-hang.jsonl'))
  void writeLog({ time: new Date().toISOString(), ...entry }).catch((error) => {
    console.error('[Electron] Failed to persist renderer hang diagnostics', error)
  })
}

function routeOnly(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname}${url.hash.split('?')[0]}`
  } catch {
    return '<unavailable>'
  }
}

async function captureNativeSample(pid: number, entry: Record<string, unknown>): Promise<void> {
  if (process.platform !== 'darwin') {
    persist({ ...entry, event: 'native-sample', status: 'unsupported-platform' })
    return
  }
  if (sampleRunning || Date.now() - lastSampleAt < 60_000) {
    persist({ ...entry, event: 'native-sample', status: 'rate-limited' })
    return
  }
  sampleRunning = true
  lastSampleAt = Date.now()
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Renderer PID unavailable')
    const output = await new Promise<string>((resolve, reject) => {
      // -file /dev/stdout avoids sample's own unbounded temporary output files.
      execFile(
        '/usr/bin/sample',
        [String(pid), '2', '10', '-file', '/dev/stdout'],
        {
          timeout: 8000,
          maxBuffer: SAMPLE_LIMIT,
          killSignal: 'SIGKILL'
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      )
    })
    const directory = path.join(app.getPath('logs'), 'renderer-hang-samples')
    await fs.mkdir(directory, { recursive: true })
    const file = `${entry.incidentId}-${pid}.txt`
    await fs.writeFile(path.join(directory, file), output, { mode: 0o600 })
    const files = (await fs.readdir(directory))
      .filter((name) => /^\d+-\d+-\d+\.txt$/.test(name))
      .sort()
    for (const old of files.slice(0, -5)) await fs.unlink(path.join(directory, old))
    persist({ ...entry, event: 'native-sample', status: 'captured', file, durationMs: 2000 })
  } catch (error) {
    persist({
      ...entry,
      event: 'native-sample',
      status: 'failed',
      error: String(error).slice(0, 2000)
    })
  } finally {
    sampleRunning = false
  }
}

export function recordRendererHang(
  window: BrowserWindow,
  event: string,
  incident: HangIncident,
  details?: Record<string, unknown>
): void {
  const entry = { incidentId: incident.id, windowId: window.id, ...details }
  try {
    if (window.isDestroyed()) {
      persist({ ...entry, event, destroyed: true })
      return
    }
    const { webContents } = window
    const pid = webContents.isDestroyed() ? 0 : webContents.getOSProcessId()
    persist({
      ...entry,
      event,
      pid,
      version: app.getVersion(),
      electron: process.versions.electron,
      visible: window.isVisible(),
      focused: window.isFocused(),
      minimized: window.isMinimized(),
      route: routeOnly(webContents.getURL()),
      loading: webContents.isLoading(),
      backgroundThrottling: webContents.getBackgroundThrottling(),
      // Electron metrics do not require a responsive renderer IPC round trip.
      processes: app
        .getAppMetrics()
        .slice(0, 64)
        .map((metric) => ({
          pid: metric.pid,
          type: metric.type,
          cpu: metric.cpu,
          memory: metric.memory
        }))
    })
    if (event !== 'unresponsive') return
    void captureNativeSample(pid, entry)
    if (pendingStacks.has(webContents)) {
      persist({ ...entry, event: 'javascript-stack', status: 'previous-request-pending' })
      return
    }
    pendingStacks.add(webContents)
    // A frame without running JS can leave this API pending forever. Keep at most
    // one actual request outstanding per WebContents, even after our timeout.
    let work: Promise<string | void>
    try {
      work = Promise.resolve(webContents.mainFrame.collectJavaScriptCallStack())
    } catch (error) {
      pendingStacks.delete(webContents)
      throw error
    }
    void work.then(
      () => pendingStacks.delete(webContents),
      () => pendingStacks.delete(webContents)
    )
    void withDiagnosticTimeout(work, 5000).then(
      (stack) => {
        persist({
          ...entry,
          event: 'javascript-stack',
          status: stack ? 'captured' : 'unavailable',
          stack: stack?.slice(0, STACK_LIMIT),
          truncated: !!stack && stack.length > STACK_LIMIT
        })
      },
      (error) =>
        persist({ ...entry, event: 'javascript-stack', status: 'failed', error: String(error) })
    )
  } catch (error) {
    persist({ ...entry, event: 'diagnostic-error', sourceEvent: event, error: String(error) })
  }
}
