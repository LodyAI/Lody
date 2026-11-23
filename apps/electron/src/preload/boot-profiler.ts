export type BootProfilePoint = {
  name: string
  atMs: number
}

export type BootProfileSnapshot = {
  timeOrigin: number
  points: BootProfilePoint[]
  frames: BootFrameSample[]
}

export type BootFrameSample = {
  atMs: number
  bodyChildCount: number
  visibleTextLength: number
  backgroundColor: string
  blank: boolean
}

export type BootProfilerBridge = {
  mark: (name: string) => void
  snapshot: () => BootProfileSnapshot
}

const BOOT_POINT_PATTERN = /^[a-z][a-z0-9-]{1,63}$/u

/**
 * Records renderer milestones from preload so the probe starts before the
 * route bundle and is not affected by when the test runner obtains a Page.
 * The bridge is only installed for isolated E2E launches.
 */
export function createBootProfiler(): BootProfilerBridge {
  const startedAt = performance.now()
  const points: BootProfilePoint[] = []
  const frames: BootFrameSample[] = []
  let firstDomContentMarked = false

  const mark = (name: string): void => {
    if (!BOOT_POINT_PATTERN.test(name) || points.some((point) => point.name === name)) return
    points.push({ name, atMs: Math.max(0, performance.now() - startedAt) })
  }

  const markFirstDomContent = (): void => {
    if (firstDomContentMarked) return
    if (!document.body || document.body.childElementCount === 0) return
    firstDomContentMarked = true
    mark('first-dom-content')
  }

  mark('preload')
  const sampleFrame = (): void => {
    const body = document.body
    const visibleTextLength = body?.innerText.trim().length ?? 0
    const bodyChildCount = body?.childElementCount ?? 0
    const backgroundColor = body ? getComputedStyle(body).backgroundColor : 'unavailable'
    frames.push({
      atMs: Math.max(0, performance.now() - startedAt),
      bodyChildCount,
      visibleTextLength,
      backgroundColor,
      blank: visibleTextLength === 0
    })
    if (frames.length < 180) requestAnimationFrame(sampleFrame)
  }
  requestAnimationFrame(sampleFrame)
  document.addEventListener('DOMContentLoaded', () => {
    mark('dom-content-loaded')
    markFirstDomContent()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => mark('first-visible-frame'))
    })
  })
  new MutationObserver(markFirstDomContent).observe(document, {
    childList: true,
    subtree: true
  })

  return {
    mark,
    snapshot: () => ({
      timeOrigin: performance.timeOrigin,
      points: points.map((point) => ({ ...point })),
      frames: frames.map((frame) => ({ ...frame }))
    })
  }
}
