import { useEffect, useState } from 'react'
import { getIpcServices } from '@lody/components/lib/electron-ipc-client'
import { createClsTracker } from './devbar-cls'
import './desktop-devbar.css'

type AppServices = NonNullable<ReturnType<typeof getIpcServices>>['app']
type Metrics = Awaited<ReturnType<AppServices['getDevbarMetrics']>>

const percent = (value: number | null | undefined) => (value == null ? '—' : `${value.toFixed(1)}%`)
const memory = (value: number | null | undefined, suffix = ' MiB') =>
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

export function DesktopDevbar() {
  const [metrics, setMetrics] = useState<Metrics>(null)
  const [fps, setFps] = useState<number | null>(null)
  const [cls, setCls] = useState<number | null>(null)
  const [heap, setHeap] = useState<number | null>(null)

  useEffect(() => {
    const app = getIpcServices()?.app
    if (!app) return undefined
    let disposed = false
    let polling = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    let frames = 0
    let started = performance.now()
    let clsValue: number | null = null
    const trackCls = createClsTracker()
    let observer: PerformanceObserver | undefined
    if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
      clsValue = 0
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          clsValue = trackCls(
            entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
          )
        }
      })
      observer.observe({ type: 'layout-shift', buffered: true })
    }
    const tick = (now: number) => {
      frames++
      if (now - started >= 1000) {
        setFps(Math.round((frames * 1000) / (now - started)))
        frames = 0
        started = now
      }
      frame = requestAnimationFrame(tick)
    }
    const poll = async () => {
      if (disposed || document.hidden || polling) return
      polling = true
      setHeap(readHeapUsage())
      try {
        const next = await app.getDevbarMetrics()
        if (!disposed && !document.hidden) setMetrics(next)
      } catch {
        if (!disposed) setMetrics(null)
      }
      polling = false
      if (!disposed && !document.hidden) {
        setCls(clsValue)
        clearTimeout(timer)
        timer = setTimeout(() => void poll(), 1000)
      }
    }
    const onVisibility = () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      frames = 0
      started = performance.now()
      setFps(null)
      setMetrics(null)
      setHeap(null)
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
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <footer className="desktop-devbar" aria-label="Desktop performance">
      <span className="desktop-devbar-label">DEVBAR</span>
      <span className="desktop-devbar-metrics">
        <span title="Renderer animation-frame callbacks per second; not GPU presentation rate">
          FPS {fps ?? '—'}
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
