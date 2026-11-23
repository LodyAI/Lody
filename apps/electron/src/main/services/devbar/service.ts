import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { desktopInstallationProfile } from '../../platform'
import { initialDevbarControl, type DevbarControlInput } from './control'
import { summarizeDevbarMetrics } from './metrics'

type DevbarRuntime = Awaited<ReturnType<(typeof import('./devframe'))['startDevbarDevframe']>>
type DevbarMetrics = ReturnType<typeof summarizeDevbarMetrics>

interface DevbarConfig {
  enabled: boolean
  preciseMemory: boolean
  devframe:
    | (Pick<DevbarRuntime, 'connection' | 'mcpUrl' | 'uiUrl' | 'embeddedScriptUrl'> & {
        authToken: string
      })
    | null
}

// One shared sampling window across Desktop windows; no background timer.
let sampledAt: number | undefined
let snapshot: ReturnType<typeof summarizeDevbarMetrics> | null = null
let devframeRuntime: DevbarRuntime | null = null
let devframeStart: Promise<DevbarRuntime> | null = null
let control = initialDevbarControl(process.env.LODY_DEVBAR)
const preciseMemory = control.enabled
// Per-process token the renderer presents to the Hub's RPC transport; stable
// across capability restarts so a live page keeps working after a Hub restart.
const devbarAuthToken = randomBytes(24).toString('base64url')

export function getDevbarConfig(): DevbarConfig {
  return {
    enabled: control.enabled,
    preciseMemory,
    devframe: devframeRuntime
      ? {
          connection: devframeRuntime.connection,
          mcpUrl: devframeRuntime.mcpUrl,
          uiUrl: devframeRuntime.uiUrl,
          embeddedScriptUrl: devframeRuntime.embeddedScriptUrl,
          authToken: devbarAuthToken
        }
      : null
  }
}

export function isDevbarRendererEnabled(): boolean {
  return control.enabled
}

async function createDevbarRuntime(): Promise<DevbarRuntime> {
  const { startDevbarDevframe } = await import('./devframe')
  let rendererOrigin: string | undefined
  try {
    rendererOrigin = process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL).origin
      : undefined
  } catch {
    rendererOrigin = undefined
  }
  return await startDevbarDevframe(
    `${desktopInstallationProfile.desktopProtocol}://devbar?view=main-thread`,
    { rendererOrigin, authToken: devbarAuthToken }
  )
}

export async function startDevbarDevframeService(): Promise<boolean> {
  if (!control.enabled) return false
  if (devframeRuntime) return true
  if (!devframeStart) {
    devframeStart = createDevbarRuntime().then((runtime) => {
      devframeRuntime = runtime
      return runtime
    })
  }
  const pending = devframeStart
  try {
    await pending
    return true
  } catch (error) {
    console.error('[Devbar] Failed to start Devframe bridge', error)
    return false
  } finally {
    if (devframeStart === pending) devframeStart = null
  }
}

export async function stopDevbarDevframeService(): Promise<void> {
  const pending = devframeStart
  if (pending) await pending.catch(() => undefined)
  devframeStart = null
  const runtime = devframeRuntime
  devframeRuntime = null
  // A failed close must not turn "disable Devbar" or quit into a rejection:
  // the runtime is already dropped and the socket dies with the process.
  await runtime
    ?.close()
    .catch((error) => console.error('[Devbar] Failed to stop Devframe bridge', error))
}

export async function setDevbarControl(next: DevbarControlInput): Promise<{
  ok: boolean
  config: DevbarConfig
}> {
  control = next
  if (!next.enabled) {
    await stopDevbarDevframeService()
    return { ok: true, config: getDevbarConfig() }
  }

  const started = await startDevbarDevframeService()
  if (!started) {
    control = { enabled: false }
  }
  return { ok: started, config: getDevbarConfig() }
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
