import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DevbarSnapshot } from '@lody/shared/devbar'

/**
 * Self-contained ES module the Hub imports for the `custom-render` Main
 * thread dock. It mounts the hidden JSON-render view (the official
 * Main-thread UI, untouched) into the dock container and appends a canvas
 * trends card below it, fed by the same-origin `snapshot.json` route. Kept
 * dependency-free so it can be served verbatim.
 */
const DOCK_RENDERER_MJS = `const INNER_DOCK_ID = 'lody-main-thread-view'
const POLL_MS = 1000

const METRICS = [
  {
    key: 'fps',
    label: 'FPS',
    color: '#3b82f6',
    fromZero: true,
    target: 60,
    value: (s) => s.fps,
    format: (v) => v.toFixed(0)
  },
  {
    key: 'cpu',
    label: 'Electron CPU',
    color: '#f59e0b',
    fromZero: true,
    value: (s) => s.cpu,
    format: (v) => v.toFixed(1) + '%'
  },
  {
    key: 'heap',
    label: 'JS heap',
    color: '#8b5cf6',
    value: (s) => (s.heapBytes == null ? null : s.heapBytes / 1048576),
    format: (v, s) => ((s && s.heapPrecise === false) ? '~' : '') + v.toFixed(0) + ' MiB'
  },
  {
    key: 'rss',
    label: 'Resident memory',
    color: '#10b981',
    value: (s) => (s.rssBytes == null ? null : s.rssBytes / 1048576),
    format: (v) => v.toFixed(0) + ' MiB'
  },
  {
    key: 'blocked',
    label: 'Blocked / sample',
    color: '#ef4444',
    fromZero: true,
    value: (s) => (s.longTasks ?? []).reduce((total, task) => total + task.durationMs, 0),
    format: (v) => v.toFixed(0) + ' ms'
  }
]

const CSS = '.lody-trends{margin-top:14px;border:1px solid rgba(128,128,128,.28);border-radius:10px;padding:12px 14px;font-variant-numeric:tabular-nums}' +
  '.lody-trends-title{font-size:12px;font-weight:600;opacity:.75;margin:0 0 4px}' +
  '.lody-trends-row{display:grid;grid-template-columns:minmax(110px,max-content) minmax(0,1fr) 84px 140px;align-items:center;gap:12px;padding:7px 0;border-top:1px solid rgba(128,128,128,.16)}' +
  '.lody-trends-row:first-of-type{border-top:none}' +
  '.lody-trends-label{opacity:.7;white-space:nowrap}' +
  '.lody-trends-canvas{display:block;width:100%;height:34px}' +
  '.lody-trends-current{font-weight:600;text-align:right;white-space:nowrap}' +
  '.lody-trends-range{opacity:.45;text-align:right;white-space:nowrap;font-size:11px}'

function drawRow(canvas, metric, samples) {
  const dpr = devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  const values = samples.map((s) => metric.value(s))
  const finite = values.filter((v) => v != null && Number.isFinite(v))
  const peak = finite.reduce((m, v) => Math.max(m, v), 0)
  const bottom = metric.fromZero ? 0 : finite.reduce((m, v) => Math.min(m, v), peak)
  const top = Math.max(metric.target ?? 0, peak * 1.05, bottom + 1e-9)
  const span = top - bottom || 1

  if (metric.target != null && peak <= metric.target * 4) {
    const y = h - 2 - ((metric.target - bottom) / span) * (h - 6)
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = metric.color
    ctx.globalAlpha = 0.45
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  const xFor = (i) => (samples.length <= 1 ? w : (i / (samples.length - 1)) * w)
  const yFor = (v) => h - 2 - ((v - bottom) / span) * (h - 6)
  ctx.strokeStyle = metric.color
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'round'
  let run = []
  const flush = () => {
    if (run.length === 0) return
    ctx.beginPath()
    run.forEach((i, n) => (n === 0 ? ctx.moveTo(xFor(i), yFor(values[i])) : ctx.lineTo(xFor(i), yFor(values[i]))))
    ctx.stroke()
    ctx.globalAlpha = 0.15
    ctx.fillStyle = metric.color
    ctx.lineTo(xFor(run[run.length - 1]), h - 2)
    ctx.lineTo(xFor(run[0]), h - 2)
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = 1
    run = []
  }
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) flush()
    else run.push(i)
  })
  flush()
}

// The viewer invokes a custom-render entry's module as a dock client script:
// the default export receives a DockClientScriptContext whose "current" dock
// state exposes the pane element through domElements.panel (and the
// dom:panel:mounted event when the script runs before mount).
export default async function main(context) {
  const panel =
    context.current.domElements.panel ??
    (await new Promise((resolve) => {
      const off = context.current.events.on('dom:panel:mounted', (el) => {
        off()
        resolve(el)
      })
    }))

  const rootNode = panel.getRootNode()
  const style = document.createElement('style')
  style.textContent = CSS
  ;(rootNode.head || rootNode).append(style)

  const viewHost = document.createElement('div')
  const card = document.createElement('section')
  card.className = 'lody-trends'
  const title = document.createElement('h2')
  title.className = 'lody-trends-title'
  title.textContent = 'Live trends'
  card.append(title)
  const rows = METRICS.map((metric) => {
    const row = document.createElement('div')
    row.className = 'lody-trends-row'
    const label = document.createElement('span')
    label.className = 'lody-trends-label'
    label.textContent = metric.label
    const canvas = document.createElement('canvas')
    canvas.className = 'lody-trends-canvas'
    const current = document.createElement('span')
    current.className = 'lody-trends-current'
    current.textContent = '—'
    const range = document.createElement('span')
    range.className = 'lody-trends-range'
    row.append(label, canvas, current, range)
    card.append(row)
    return { metric, canvas, current, range }
  })
  panel.append(viewHost, card)

  let innerDispose = null
  const inner = (context.docks.entries || []).find((entry) => entry.id === INNER_DOCK_ID)
  const mounting = inner
    ? context.renderers.mount(inner, viewHost).then((result) => {
        if (result.status === 'mounted') innerDispose = result.dispose
        else viewHost.textContent = 'Main-thread view is unavailable (' + result.status + ').'
      })
    : Promise.resolve((viewHost.textContent = 'Main-thread view is not registered.'))

  // The viewer runs this script once and caches it; the pane element persists
  // across activations, so only the polling is tied to the dock's lifecycle.
  const snapshotUrl = new URL('./snapshot.json', import.meta.url)
  let timer = null
  let lastSnapshot = null

  function render(snapshot) {
    const samples = (snapshot.samples || []).slice(-60)
    const latest = samples.length ? samples[samples.length - 1] : null
    for (const row of rows) {
      const values = samples.map((s) => row.metric.value(s))
      const finite = values.filter((v) => v != null && Number.isFinite(v))
      const current = latest ? row.metric.value(latest) : null
      row.current.textContent =
        current == null || !Number.isFinite(current) ? '—' : row.metric.format(current, latest)
      row.range.textContent =
        finite.length === 0
          ? ''
          : row.metric.format(Math.min(...finite), latest) +
            ' – ' +
            row.metric.format(Math.max(...finite), latest)
      drawRow(row.canvas, row.metric, samples)
    }
  }

  function poll() {
    if (timer == null) return
    if (!document.hidden && context.current.isActive) {
      fetch(snapshotUrl, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((snapshot) => {
          if (snapshot) render((lastSnapshot = snapshot))
        })
        .catch(() => {})
    }
    timer = setTimeout(poll, POLL_MS)
  }
  timer = setTimeout(poll, 0)

  addEventListener('resize', () => {
    if (lastSnapshot) render(lastSnapshot)
  })
}
`

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.statusCode = status
  response.setHeader('Content-Type', contentType)
  response.setHeader('Cache-Control', 'no-store')
  response.end(body)
}

export type DevbarRequestForward = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void
) => void

/**
 * The loopback server's request listener. The main process exits on
 * uncaughtException, so a throwing route or Hub middleware must never escape
 * here: it degrades to 500 instead of taking the app down.
 */
export function createDevbarRequestListener(options: {
  isAllowedOrigin: (requestOrigin: string | undefined) => boolean
  snapshot: () => DevbarSnapshot
  /** Resolves the Hub middleware per request; undefined while it starts. */
  forward: () => DevbarRequestForward | undefined
}): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    try {
      const requestOrigin = request.headers.origin
      if (!options.isAllowedOrigin(requestOrigin)) {
        response.statusCode = 403
        response.end('Origin not allowed')
        return
      }
      if (requestOrigin) {
        response.setHeader('Access-Control-Allow-Origin', requestOrigin)
        response.setHeader('Vary', 'Origin')
      }
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      if (handleDevbarLocalRoute(request, response, options.snapshot)) return
      const forward = options.forward()
      if (!forward) {
        response.statusCode = 503
        response.end('Lody DevTools is starting')
        return
      }
      forward(request, response, (error) => {
        response.statusCode = error ? 500 : 404
        response.end(error instanceof Error ? error.message : 'Not found')
      })
    } catch (error) {
      console.error('[Devbar] Request handler failed', error)
      if (!response.headersSent) response.statusCode = 500
      response.end()
    }
  }
}

/**
 * Lody-owned loopback routes served alongside the Hub on the same origin:
 * the custom-render dock module and the metrics snapshot it polls. Neither
 * needs a devframe client or an extra capability.
 */
export function handleDevbarLocalRoute(
  request: IncomingMessage,
  response: ServerResponse,
  snapshot: () => DevbarSnapshot
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  let pathname: string
  try {
    pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  } catch {
    return false
  }
  // Sandboxed frames present the same opaque `null` Origin as the packaged
  // `file://` renderer, so these routes only serve hub pages on this origin
  // and non-browser callers that send no Origin header at all.
  if (pathname.startsWith('/__lody/') && request.headers.origin === 'null') {
    response.writeHead(403).end()
    return true
  }
  switch (pathname) {
    case '/__lody/dock-renderer.mjs':
      send(response, 200, 'text/javascript; charset=utf-8', DOCK_RENDERER_MJS)
      return true
    case '/__lody/snapshot.json':
      send(response, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot()))
      return true
    default:
      return false
  }
}
