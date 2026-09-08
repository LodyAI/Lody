import { app } from 'electron'
import { isDevbarEnabled, summarizeDevbarMetrics } from './devbar-metrics'

// One shared sampling window across Desktop windows; no background timer.
let sampledAt: number | undefined
let snapshot: ReturnType<typeof summarizeDevbarMetrics> | null = null

export function getDevbarConfig() {
  return { enabled: isDevbarEnabled(process.env.LODY_DEVBAR) }
}

export function configureDevbarDiagnostics() {
  if (getDevbarConfig().enabled) {
    // Avoid Chromium's bucketized, long-lived performance.memory cache.
    app.commandLine.appendSwitch('enable-precise-memory-info')
  }
}

export function getDevbarMetrics() {
  if (!getDevbarConfig().enabled) return null
  const now = performance.now()
  if (sampledAt === undefined || now - sampledAt >= 1000) {
    snapshot = summarizeDevbarMetrics(
      app.getAppMetrics(),
      sampledAt !== undefined && now - sampledAt < 5000
    )
    sampledAt = now
  }
  return snapshot
}
