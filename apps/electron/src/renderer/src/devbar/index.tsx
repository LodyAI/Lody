import type { DevbarRendererSample } from '@lody/shared/devbar'
import { useEffect, useRef, useState, type JSX } from 'react'
import { getIpcServices, onIpcEvent } from '@lody/components/lib/electron-ipc-client'
import { createClsTracker } from './cls'
import { isDevbarDeepLink } from './deep-link'
import { devbarSampleRoute } from './route'
import { createLongTaskBuffer, type LongTaskEntryLike } from './long-tasks'
import './index.css'

type AppServices = NonNullable<ReturnType<typeof getIpcServices>>['app']
type Metrics = Awaited<ReturnType<AppServices['getDevbarMetrics']>>

const percent = (value: number | null | undefined): string =>
  value == null ? '—' : `${value.toFixed(1)}%`
const memory = (value: number | null | undefined, suffix = ' MiB'): string =>
  value == null ? '—' : `${(value / 1024 / 1024).toFixed(0)}${suffix}`

function readHeapUsage(): number | null {
  try {
    // Chromium-only API: read a fresh MemoryInfo each time, not a cached object.
    const value = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory
      ?.usedJSHeapSize
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

function DevbarMetric(props: { label: string; value: string; title: string }): JSX.Element {
  return (
    <span className="desktop-devbar-metric" title={props.title}>
      <span className="desktop-devbar-metric-label">{props.label}</span>
      <span className="desktop-devbar-metric-value">{props.value}</span>
    </span>
  )
}

export function DesktopDevbar(): JSX.Element {
  const [metrics, setMetrics] = useState<Metrics>(null)
  const [fps, setFps] = useState<number | null>(null)
  const [cls, setCls] = useState<number | null>(null)
  const [heap, setHeap] = useState<number | null>(null)
  const [heapPrecise, setHeapPrecise] = useState(false)
  const [longTaskDuration, setLongTaskDuration] = useState<number | null>(null)
  const [devframeStatus, setDevframeStatus] = useState('unavailable')
  const activateDockRef = useRef<(() => void) | null>(null)
  const pendingActivationRef = useRef(false)

  useEffect(() => {
    const app = getIpcServices()?.app
    if (!app) return undefined
    let disposed = false
    let polling = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    let frames = 0
    let started = performance.now()
    let latestFps: number | null = null
    let clsValue: number | null = null
    const trackCls = createClsTracker()
    const longTaskBuffer = createLongTaskBuffer()
    let clsObserver: PerformanceObserver | undefined
    let longTaskObserver: PerformanceObserver | undefined
    let recordSample: ((sample: DevbarRendererSample) => Promise<unknown>) | undefined
    let sampleHeapPrecise = false
    let closeDevframe: (() => void) | undefined
    let embeddedScript: HTMLScriptElement | undefined
    if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
      clsValue = 0
      clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          clsValue = trackCls(
            entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
          )
        }
      })
      clsObserver.observe({ type: 'layout-shift', buffered: true })
    }
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      setLongTaskDuration(0)
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskBuffer.record(entry as LongTaskEntryLike, performance.timeOrigin)
        }
      })
      longTaskObserver.observe({ type: 'longtask', buffered: true })
    }
    const tick = (now: number): void => {
      frames++
      if (now - started >= 1000) {
        latestFps = Math.round((frames * 1000) / (now - started))
        setFps(latestFps)
        frames = 0
        started = now
      }
      frame = requestAnimationFrame(tick)
    }
    const poll = async (): Promise<void> => {
      if (disposed || document.hidden || polling) return
      polling = true
      const nextHeap = readHeapUsage()
      setHeap(nextHeap)
      try {
        const next = await app.getDevbarMetrics()
        if (!disposed && !document.hidden) {
          const intervalLongTasks = longTaskBuffer.drain()
          setMetrics(next)
          setCls(clsValue)
          setLongTaskDuration(
            longTaskObserver
              ? intervalLongTasks.reduce((total, task) => total + task.durationMs, 0)
              : null
          )
          const sample: DevbarRendererSample = {
            recordedAtMs: Date.now(),
            route: devbarSampleRoute(window.location),
            fps: latestFps,
            cls: clsValue,
            heapBytes: nextHeap,
            heapPrecise: sampleHeapPrecise,
            cpu: next?.cpu ?? null,
            rssBytes: next?.rss ?? null,
            gpuCpu: next?.gpuCpu ?? null,
            gpuRssBytes: next?.gpuRss ?? null,
            warmPool: next?.warmPool,
            longTasks: intervalLongTasks
          }
          void recordSample?.(sample).catch(() => setDevframeStatus('error'))
        }
      } catch {
        if (!disposed) setMetrics(null)
      }
      polling = false
      if (!disposed && !document.hidden) {
        clearTimeout(timer)
        timer = setTimeout(() => void poll(), 1000)
      }
    }
    const onVisibility = (): void => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      frames = 0
      started = performance.now()
      setFps(null)
      setMetrics(null)
      setHeap(null)
      setLongTaskDuration(null)
      if (!document.hidden) {
        frame = requestAnimationFrame(tick)
        // Let an in-flight poll finish before scheduling another.
        timer = setTimeout(() => void poll(), 1000)
      }
    }
    if (!document.hidden) {
      frame = requestAnimationFrame(tick)
      void poll()
    }
    void app
      .getDevbarConfig()
      .then(async (config) => {
        if (disposed || !config.devframe) return
        sampleHeapPrecise = config.preciseMemory
        setHeapPrecise(config.preciseMemory)
        embeddedScript =
          document.querySelector<HTMLScriptElement>('script[data-lody-devframe-hub]') ??
          document.createElement('script')
        embeddedScript.type = 'module'
        embeddedScript.src = config.devframe.embeddedScriptUrl
        embeddedScript.dataset.lodyDevframeHub = 'true'
        embeddedScript.onerror = () => {
          if (!disposed) setDevframeStatus('error')
        }
        // The embedded Hub script reads this global when it builds its own
        // connection so the opaque `file://` origin can present the token.
        globalThis.__DEVFRAME_CONNECTION_AUTH_TOKEN__ = config.devframe.authToken
        if (!embeddedScript.isConnected) document.body.appendChild(embeddedScript)
        const { connectDevframe } = await import('devframe/client')
        const rpc = await connectDevframe({
          connection: config.devframe.connection,
          authToken: config.devframe.authToken,
          simpleAuth: false,
          webmcp: false
        })
        if (disposed) {
          rpc.close?.()
          return
        }
        setDevframeStatus(rpc.status)
        const stopStatus = rpc.events.on('connection:status', (status) => {
          if (!disposed) setDevframeStatus(status)
        })
        const devbar = rpc.scope('lody-devbar')
        recordSample = (sample) => devbar.rpc.call('record-sample', sample)
        activateDockRef.current = () => {
          void rpc
            .call('hub:docks:activate', { dockId: 'lody-main-thread' })
            .catch(() => setDevframeStatus('error'))
        }
        if (pendingActivationRef.current) {
          pendingActivationRef.current = false
          activateDockRef.current()
        }
        closeDevframe = () => {
          stopStatus()
          activateDockRef.current = null
          rpc.close?.()
          delete globalThis.__DEVFRAME_CONNECTION_AUTH_TOKEN__
        }
      })
      .catch(() => setDevframeStatus('error'))
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      clsObserver?.disconnect()
      longTaskObserver?.disconnect()
      embeddedScript?.remove()
      closeDevframe?.()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  useEffect(
    () =>
      onIpcEvent('app.deepLink', (url) => {
        if (!isDevbarDeepLink(url)) return
        if (activateDockRef.current) activateDockRef.current()
        else pendingActivationRef.current = true
      }),
    []
  )

  return (
    <footer className="desktop-devbar" aria-label="Desktop performance">
      <button
        type="button"
        className="desktop-devbar-label"
        title={`Open Lody DevTools (${devframeStatus})`}
        onClick={() => {
          if (activateDockRef.current) activateDockRef.current()
          else pendingActivationRef.current = true
        }}
      >
        <span className="desktop-devbar-status" data-status={devframeStatus} aria-hidden="true" />
        Devbar
      </button>
      <span className="desktop-devbar-metrics">
        <DevbarMetric
          label="FPS"
          value={fps == null ? '—' : String(fps)}
          title="Renderer animation-frame callbacks per second; not GPU presentation rate"
        />
        <DevbarMetric
          label="Blk"
          value={longTaskDuration == null ? '—' : `${longTaskDuration.toFixed(0)}ms`}
          title="Renderer main thread blocked by long tasks during the last sample interval"
        />
        <DevbarMetric
          label="CLS"
          value={cls == null ? '—' : cls.toFixed(3)}
          title="Renderer maximum layout-shift session window, excluding recent input"
        />
        <DevbarMetric
          label="RSS"
          value={memory(metrics?.rss)}
          title="Sum of Electron process resident working sets; excludes external CLI/agents and may double-count shared pages"
        />
        <DevbarMetric
          label="CPU"
          value={percent(metrics?.cpu)}
          title="Sum of Electron process CPU usage"
        />
        <DevbarMetric
          label="Heap"
          value={heap == null ? '—' : `${heapPrecise ? '' : '~'}${memory(heap, 'M')}`}
          title="Current renderer JS heap reported by Chromium, not total app memory or other worker heaps (M = MiB)"
        />
        <DevbarMetric
          label="GPU"
          value={`${percent(metrics?.gpuCpu)} ${memory(metrics?.gpuRss, 'M')}`}
          title="GPU process: CPU usage and resident working set (M = MiB), not GPU hardware utilization or VRAM"
        />
        <DevbarMetric
          label="Warm"
          value={
            metrics?.warmPool == null
              ? '—'
              : `${metrics.warmPool.phase}${
                  metrics.warmPool.spareRssBytes == null
                    ? ''
                    : ` ${memory(metrics.warmPool.spareRssBytes, 'M')}`
                }`
          }
          title="Developer-only auxiliary-window warm pool phase and hidden spare renderer RSS"
        />
      </span>
    </footer>
  )
}
