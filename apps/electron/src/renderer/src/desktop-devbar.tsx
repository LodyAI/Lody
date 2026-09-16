import type { DevbarRendererSample } from '@lody/shared/devbar'
import { useEffect, useRef, useState, type JSX } from 'react'
import { getIpcServices, onIpcEvent } from '@lody/components/lib/electron-ipc-client'
import { createClsTracker } from './devbar-cls'
import { isDevbarDeepLink } from './devbar-deep-link'
import { createLongTaskBuffer, type LongTaskEntryLike } from './devbar-long-tasks'
import './desktop-devbar.css'

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

export function DesktopDevbar(): JSX.Element {
  const [metrics, setMetrics] = useState<Metrics>(null)
  const [fps, setFps] = useState<number | null>(null)
  const [cls, setCls] = useState<number | null>(null)
  const [heap, setHeap] = useState<number | null>(null)
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
    let closeDevframe: (() => void) | undefined
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
            route: window.location.pathname,
            fps: latestFps,
            cls: clsValue,
            heapBytes: nextHeap,
            cpu: next?.cpu ?? null,
            rssBytes: next?.rss ?? null,
            gpuCpu: next?.gpuCpu ?? null,
            gpuRssBytes: next?.gpuRss ?? null,
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
        const embeddedScript = document.createElement('script')
        embeddedScript.type = 'module'
        embeddedScript.src = config.devframe.embeddedScriptUrl
        embeddedScript.dataset.lodyDevframeHub = 'true'
        document.body.appendChild(embeddedScript)
        const { connectDevframe } = await import('devframe/client')
        const rpc = await connectDevframe({
          connection: config.devframe.connection,
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
        DEVBAR
      </button>
      <span className="desktop-devbar-metrics">
        <span title="Renderer animation-frame callbacks per second; not GPU presentation rate">
          FPS {fps ?? '—'}
        </span>
        <span title="Total duration of renderer long tasks observed during the last sample interval">
          LT {longTaskDuration == null ? '—' : `${longTaskDuration.toFixed(0)}ms`}
        </span>
        <span title="Renderer maximum layout-shift session window, excluding recent input">
          CLS {cls == null ? '—' : cls.toFixed(3)}
        </span>
        <span title="Sum of Electron process resident working sets; excludes external CLI/agents and may double-count shared pages">
          RSS {memory(metrics?.rss)}
        </span>
        <span title="Sum of Electron process CPU usage">CPU {percent(metrics?.cpu)}</span>
        <span title="Current renderer JS heap reported by Chromium, not total app memory or other worker heaps (M = MiB)">
          Heap {memory(heap, 'M')}
        </span>
        <span title="GPU process: CPU usage and resident working set (M = MiB), not GPU hardware utilization or VRAM">
          GPU {percent(metrics?.gpuCpu)} {memory(metrics?.gpuRss, 'M')}
        </span>
      </span>
    </footer>
  )
}
