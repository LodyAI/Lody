export interface ConversationFrame {
  route: number
  pane: number | null
  visible: boolean
  scrollTop: number
  scrollHeight: number
  viewportHeight: number
  mountedRows: number
  rowsTruncated: boolean
  rows: { id: number; top: number; height: number }[]
}

type Observation =
  | 'route'
  | 'pane-removed'
  | 'pane-replaced'
  | 'rehidden'
  | 'rows-empty'
  | 'anchor-shift'
export type CaptureStop = 'manual' | 'timeout' | 'limit' | 'hidden' | 'unmounted' | 'error'

export interface ConversationCaptureReport {
  version: 1
  kind: 'lody-conversation-capture'
  limits: {
    durationMs: number
    samples: number
    rowsPerFrame: number
    longTasks: number
    inputs: number
  }
  ended: { atMs: number; reason: CaptureStop } | null
  summary: {
    sampledFrames: number
    maxFrameGapMs: number
    observations: Partial<Record<Observation, number>>
  }
  samples: { atMs: number; frame: ConversationFrame; observations: Observation[] }[]
  longTasks: { atMs: number; durationMs: number }[]
  inputs: { atMs: number; kind: string }[]
  limitations: string
}

interface ConversationCapture {
  sample(now: number, frame: ConversationFrame): boolean
  input(now: number, kind: 'pointerdown' | 'wheel' | 'keydown'): void
  longTask(now: number, durationMs: number): void
  stop(now: number, reason: CaptureStop): void
  report(): ConversationCaptureReport
}

/** Bounded observations, not a diagnosis: geometry changes alone do not identify their cause. */
export function createConversationCapture(startedAt: number): ConversationCapture {
  const samples: { atMs: number; frame: ConversationFrame; observations: Observation[] }[] = []
  const longTasks: { atMs: number; durationMs: number }[] = []
  const inputs: { atMs: number; kind: string }[] = []
  const counts: Partial<Record<Observation, number>> = {}
  let previous: ConversationFrame | undefined
  let previousKey = ''
  let lastPane: number | null = null
  let revealed = false
  let ended: { atMs: number; reason: CaptureStop } | null = null
  let sampledFrames = 0
  let maxFrameGapMs = 0
  let lastFrameAt = startedAt
  const elapsed = (now: number): number => Math.max(0, Math.round((now - startedAt) * 100) / 100)
  return {
    sample(now: number, frame: ConversationFrame): boolean {
      if (ended) return false
      if (now - startedAt >= 60_000) return false
      maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrameAt)
      lastFrameAt = now
      sampledFrames++
      const key = JSON.stringify(frame)
      if (key === previousKey) return true
      if (samples.length >= 1800) return false
      const observations: Observation[] = []
      if (!previous || frame.route !== previous.route) {
        observations.push('route')
        revealed = false
        lastPane = null
      } else {
        if (previous.pane !== null && frame.pane === null) observations.push('pane-removed')
        if (lastPane !== null && frame.pane !== null && frame.pane !== lastPane)
          observations.push('pane-replaced')
        if (revealed && previous.visible && !frame.visible && frame.pane !== null)
          observations.push('rehidden')
        if (
          previous.visible &&
          frame.visible &&
          previous.rows.length > 0 &&
          frame.rows.length === 0
        )
          observations.push('rows-empty')
        const anchor = previous.rows[0]
        const retained = anchor && frame.rows.find((row) => row.id === anchor.id)
        if (
          previous.pane === frame.pane &&
          previous.visible &&
          frame.visible &&
          retained &&
          Math.abs(frame.scrollTop - previous.scrollTop) < 1 &&
          Math.abs(retained.top - anchor.top) > 2
        )
          observations.push('anchor-shift')
      }
      if (frame.visible && frame.rows.length > 0) revealed = true
      if (frame.pane !== null) lastPane = frame.pane
      for (const observation of observations) counts[observation] = (counts[observation] ?? 0) + 1
      samples.push({ atMs: elapsed(now), frame, observations })
      previous = frame
      previousKey = key
      return true
    },
    input(now: number, kind: 'pointerdown' | 'wheel' | 'keydown'): void {
      if (!ended && inputs.length < 200) inputs.push({ atMs: elapsed(now), kind })
    },
    longTask(now: number, durationMs: number): void {
      if (!ended && longTasks.length < 100) longTasks.push({ atMs: elapsed(now), durationMs })
    },
    stop(now: number, reason: CaptureStop): void {
      ended ??= { atMs: elapsed(now), reason }
    },
    report(): ConversationCaptureReport {
      return {
        version: 1,
        kind: 'lody-conversation-capture',
        limits: {
          durationMs: 60_000,
          samples: 1800,
          rowsPerFrame: 200,
          longTasks: 100,
          inputs: 200
        },
        ended,
        summary: { sampledFrames, maxFrameGapMs, observations: { ...counts } },
        samples: [...samples],
        longTasks: [...longTasks],
        inputs: [...inputs],
        limitations:
          'DOM observations, not presented screen frames or CPU stacks. Route/row IDs are capture-local aliases. Recording does not make a session cold. Source/projection identity is not inspected. Anchor shifts may be legitimate layout changes.'
      }
    }
  }
}

/** Call only from the enabled Devbar after an explicit start action. */
export function startConversationCapture(onStop: (report: ConversationCaptureReport) => void): {
  stop: (reason?: CaptureStop) => void
} {
  const startedAt = performance.now()
  const capture = createConversationCapture(startedAt)
  const nodes = new WeakMap<Element, number>()
  const routes = new Map<string, number>()
  const rowKeys = new Map<string, number>()
  let nextNode = 1
  let raf = 0
  let stopped = false
  let observer: PerformanceObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const alias = (map: Map<string, number>, key: string): number => {
    if (!map.has(key)) map.set(key, map.size + 1)
    return map.get(key)!
  }
  const input = (event: Event): void =>
    capture.input(performance.now(), event.type as 'pointerdown' | 'wheel' | 'keydown')
  const visibility = (): void => {
    if (document.hidden) stop('hidden')
  }
  const stop = (reason: CaptureStop = 'manual'): void => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
    clearTimeout(timer)
    observer?.disconnect()
    document.removeEventListener('visibilitychange', visibility)
    for (const kind of ['pointerdown', 'wheel', 'keydown'])
      document.removeEventListener(kind, input, true)
    capture.stop(performance.now(), reason)
    routes.clear()
    rowKeys.clear()
    onStop(capture.report())
  }
  const sample = (): void => {
    if (stopped) return
    try {
      const route = alias(routes, window.location.hash || window.location.pathname)
      const pane = document.querySelector<HTMLElement>('[data-message-selection-scroll]')
      const frame: ConversationFrame = {
        route,
        pane: null,
        visible: false,
        scrollTop: 0,
        scrollHeight: 0,
        viewportHeight: 0,
        mountedRows: 0,
        rowsTruncated: false,
        rows: []
      }
      if (pane) {
        if (!nodes.has(pane)) nodes.set(pane, nextNode++)
        const box = pane.getBoundingClientRect()
        const style = getComputedStyle(pane)
        frame.pane = nodes.get(pane)!
        frame.visible =
          box.width > 0 &&
          box.height > 0 &&
          style.visibility === 'visible' &&
          style.display !== 'none' &&
          Number(style.opacity) > 0 &&
          pane.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        frame.scrollTop = pane.scrollTop
        frame.scrollHeight = pane.scrollHeight
        frame.viewportHeight = box.height
        const rows = pane.querySelectorAll<HTMLElement>('[data-virtual-index]')
        frame.mountedRows = rows.length
        frame.rowsTruncated = rows.length > 200
        for (const row of Array.from(rows).slice(0, 200)) {
          const r = row.getBoundingClientRect()
          if (r.bottom <= box.top || r.top >= box.bottom || r.height <= 0) continue
          const key = row.dataset.conversationRowKey
          if (!key) continue
          frame.rows.push({
            id: alias(rowKeys, `${route}:${key}`),
            top: Math.round((r.top - box.top) * 100) / 100,
            height: Math.round(r.height * 100) / 100
          })
        }
      }
      const now = performance.now()
      if (!capture.sample(now, frame)) return stop(now - startedAt >= 60_000 ? 'timeout' : 'limit')
      raf = requestAnimationFrame(sample)
    } catch {
      stop('error')
    }
  }
  try {
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) capture.longTask(entry.startTime, entry.duration)
      })
      observer.observe({ type: 'longtask' })
    }
    for (const kind of ['pointerdown', 'wheel', 'keydown'])
      document.addEventListener(kind, input, { capture: true, passive: true })
    document.addEventListener('visibilitychange', visibility)
    timer = setTimeout(() => stop('timeout'), 60_000)
    if (document.hidden) stop('hidden')
    else sample()
  } catch {
    stop('error')
  }
  return { stop }
}
