import { app } from 'electron'
import { desktopInstallationProfile } from '../platform'
import { isDevbarEnabled, summarizeDevbarMetrics } from './devbar-metrics'

type DevbarRuntime = Awaited<
  ReturnType<(typeof import('./devbar-devframe'))['startDevbarDevframe']>
>
type DevbarMetrics = ReturnType<typeof summarizeDevbarMetrics>

interface DevbarConfig {
  enabled: boolean
  devframe: Pick<DevbarRuntime, 'connection' | 'mcpUrl' | 'uiUrl' | 'embeddedScriptUrl'> | null
}

// One shared sampling window across Desktop windows; no background timer.
let sampledAt: number | undefined
let snapshot: ReturnType<typeof summarizeDevbarMetrics> | null = null
let devframeRuntime: DevbarRuntime | null = null

export function getDevbarConfig(): DevbarConfig {
  return {
    enabled: isDevbarEnabled(process.env.LODY_DEVBAR),
    devframe: devframeRuntime
      ? {
          connection: devframeRuntime.connection,
          mcpUrl: devframeRuntime.mcpUrl,
          uiUrl: devframeRuntime.uiUrl,
          embeddedScriptUrl: devframeRuntime.embeddedScriptUrl
        }
      : null
  }
}

export function configureDevbarDiagnostics(): void {
  if (getDevbarConfig().enabled) {
    // Avoid Chromium's bucketized, long-lived performance.memory cache.
    app.commandLine.appendSwitch('enable-precise-memory-info')
  }
}

export async function startDevbarDevframeService(): Promise<void> {
  if (!getDevbarConfig().enabled || devframeRuntime) return
  try {
    const { startDevbarDevframe } = await import('./devbar-devframe')
    devframeRuntime = await startDevbarDevframe(
      `${desktopInstallationProfile.desktopProtocol}://devbar?view=main-thread`
    )
  } catch (error) {
    console.error('[Devbar] Failed to start Devframe bridge', error)
  }
}

export async function stopDevbarDevframeService(): Promise<void> {
  const runtime = devframeRuntime
  devframeRuntime = null
  await runtime?.close()
}

export function getDevbarMetrics(): DevbarMetrics | null {
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
