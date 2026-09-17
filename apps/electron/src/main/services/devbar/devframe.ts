import type { DevbarRendererSample, DevbarSnapshot } from '@lody/shared/devbar'
import type { ConnectionMeta } from 'devframe'
import type { HubInstance } from '@devframes/hub/initiate'
import type { Server } from 'node:http'
import type { JsonRenderView } from '@devframes/json-render'
import { DEVFRAMES_HUB_BASE, initHub } from '@devframes/hub/initiate'
import { toJsonRenderDockEntry } from '@devframes/json-render/hub'
import { createJsonRenderView } from '@devframes/json-render/node'
import { createServer } from 'node:http'
import { defineDevframe, defineRpcFunction } from 'devframe'
import { DevbarRendererSampleSchema, DevbarSnapshotSchema } from '@lody/shared/devbar'
import { z } from 'zod'
import pkg from '../../../../package.json' with { type: 'json' }
import { createDevbarAuth, isAllowedDevbarRequestOrigin } from './control'
import { createDevbarRequestListener } from './local-routes'
import { createDevbarViewState, DEVBAR_VIEW_SPEC } from './json-render'
import { DevbarRecording } from './recording'

const DEVBAR_ID = 'lody-devbar'
const DEVBAR_DOCK_ID = 'lody-main-thread'
const DEVBAR_VIEW_DOCK_ID = 'lody-main-thread-view'
const DEVBAR_PORT_RANGE = [9765, 9785] as const

export interface DevbarDevframeRuntime {
  connection: {
    connectionMeta: ConnectionMeta
    metaBaseUrl: string
  }
  mcpUrl: string | null
  uiUrl: string
  embeddedScriptUrl: string
  deepLink: string
  close: () => Promise<void>
}

async function listenOnAvailablePort(server: Server): Promise<number> {
  for (let port = DEVBAR_PORT_RANGE[0]; port <= DEVBAR_PORT_RANGE[1]; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        function onListening(): void {
          server.off('error', onError)
          resolve()
        }
        function onError(error: NodeJS.ErrnoException): void {
          server.off('listening', onListening)
          reject(error)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
      return port
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`No Devbar port available in ${DEVBAR_PORT_RANGE.join('-')}`)
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.()
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function renderSnapshot(snapshot: DevbarSnapshot, deepLink: string): string {
  const latest = snapshot.latest
  if (!latest) {
    return `# Lody Devbar\n\nNo renderer sample has arrived yet.\n\nOpen overlay: ${deepLink}`
  }

  const metric = (value: number | null, suffix: string): string =>
    value == null ? 'unavailable' : `${value.toFixed(1)}${suffix}`
  const recentTasks = snapshot.longTasks
    .slice(-10)
    .reverse()
    .map(
      (task) =>
        `- ${new Date(task.observedAtMs).toISOString()}: ${task.durationMs.toFixed(1)} ms (${task.name})`
    )

  return [
    '# Lody Devbar',
    '',
    `Route: ${latest.route}`,
    `Open overlay: ${deepLink}`,
    `Last sample: ${new Date(latest.recordedAtMs).toISOString()}`,
    `FPS: ${metric(latest.fps, '')}`,
    `CLS: ${metric(latest.cls, '')}`,
    `Electron CPU: ${metric(latest.cpu, '%')}`,
    `Long tasks observed: ${snapshot.summary.longTaskCount}`,
    `Worst long task: ${metric(snapshot.summary.maxLongTaskDurationMs, ' ms')}`,
    '',
    '## Recent long tasks',
    '',
    ...(recentTasks.length > 0 ? recentTasks : ['No long tasks recorded.'])
  ].join('\n')
}

export async function startDevbarDevframe(
  deepLink: string,
  options: { agentAccess: boolean; rendererOrigin?: string; authToken: string }
): Promise<DevbarDevframeRuntime> {
  const recording = new DevbarRecording()
  let dashboardView: JsonRenderView | undefined
  const definition = defineDevframe({
    id: DEVBAR_ID,
    name: 'Lody Devbar',
    version: pkg.version,
    packageName: pkg.name,
    importMetaUrl: import.meta.url,
    homepage: pkg.homepage,
    description: 'Live renderer and Electron performance diagnostics for Lody Desktop.',
    icon: 'ph:activity-duotone',
    cli: {
      command: DEVBAR_ID,
      port: 9765,
      portRange: [9765, 9785],
      host: '127.0.0.1'
    },
    async setup(ctx) {
      const devbar = ctx.scope(DEVBAR_ID)
      dashboardView = createJsonRenderView(devbar, {
        id: 'main-thread',
        title: 'Main-thread diagnostics',
        spec: DEVBAR_VIEW_SPEC
      })
      const snapshotState = await devbar.rpc.sharedState<DevbarSnapshot>('snapshot', {
        initialValue: recording.snapshot()
      })
      const samples = devbar.rpc.streaming.create<DevbarRendererSample>('samples', {
        replayWindow: 120
      })
      const liveSamples = samples.start({ id: 'live' })

      const publish = (sample: DevbarRendererSample): DevbarSnapshot => {
        const snapshot = recording.record(sample)
        snapshotState.mutate((draft) => {
          Object.assign(draft, snapshot)
        })
        dashboardView?.patchState([
          { op: 'replace', path: '/dashboard', value: createDevbarViewState(snapshot) }
        ])
        liveSamples.write(sample)
        return snapshot
      }

      devbar.rpc.register(
        defineRpcFunction({
          name: 'record-sample',
          type: 'action',
          jsonSerializable: true,
          args: [DevbarRendererSampleSchema],
          returns: DevbarSnapshotSchema,
          handler: publish
        })
      )

      devbar.rpc.register(
        defineRpcFunction({
          name: 'get-snapshot',
          type: 'query',
          jsonSerializable: true,
          snapshot: true,
          args: [],
          returns: DevbarSnapshotSchema,
          agent: {
            title: 'Read Lody performance snapshot',
            description:
              'Read the latest Lody renderer metrics and the bounded recent long-task history.',
            safety: 'read'
          },
          handler: () => recording.snapshot()
        })
      )

      devbar.rpc.register(
        defineRpcFunction({
          name: 'open-sample-stream',
          type: 'query',
          jsonSerializable: true,
          args: [],
          returns: z.object({ streamId: z.literal('live') }),
          handler: async () => ({ streamId: 'live' as const })
        })
      )

      ctx.rpc.register(
        defineRpcFunction({
          name: 'anonymous:devframe:auth',
          type: 'action',
          jsonSerializable: true,
          args: [
            z.object({
              authToken: z.string(),
              ua: z.string(),
              origin: z.string()
            })
          ],
          returns: z.object({ isTrusted: z.boolean() }),
          handler: (params: { authToken: string }) => {
            const session = ctx.rpc.getCurrentRpcSession()
            if (!session) return { isTrusted: false }
            if (params.authToken === options.authToken) {
              session.meta.clientAuthToken = params.authToken
              session.meta.isTrusted = true
            }
            return { isTrusted: session.meta.isTrusted === true }
          }
        })
      )

      ctx.agent.registerResource({
        id: 'lody-devbar-current',
        name: 'Current Lody performance diagnostics',
        description: 'A concise Markdown snapshot of the active Lody Desktop renderer.',
        mimeType: 'text/markdown',
        read: () => ({ text: renderSnapshot(recording.snapshot(), deepLink) })
      })
    }
  })

  let hub: HubInstance | undefined
  let origin: string | undefined
  const server = createServer(
    createDevbarRequestListener({
      isAllowedOrigin: (requestOrigin) =>
        !origin || isAllowedDevbarRequestOrigin(requestOrigin, origin, options.rendererOrigin),
      snapshot: () => recording.snapshot(),
      forward: () => hub?.nodeMiddleware.bind(hub)
    })
  )
  const port = await listenOnAvailablePort(server)
  // Once listen succeeds the retry-loop 'error' listener is gone; a server
  // 'error' with no listener would surface as a fatal uncaughtException.
  server.on('error', (error) => {
    console.error('[Devbar] Hub server error', error)
  })
  origin = `http://127.0.0.1:${port}`

  try {
    const [hubUi, jsonRenderUi, inspect, a11y, terminals] = await Promise.all([
      import('@devframes/hub-ui'),
      import('@devframes/json-render-ui/hub'),
      import('@devframes/plugin-inspect'),
      import('@devframes/plugin-a11y'),
      options.agentAccess ? import('@devframes/plugin-terminals') : Promise.resolve(null)
    ])
    hub = initHub({
      name: 'Lody DevTools',
      version: pkg.version,
      base: DEVFRAMES_HUB_BASE,
      server,
      origin,
      host: '127.0.0.1',
      auth: createDevbarAuth(options.authToken, () => ({
        hub: origin,
        renderer: options.rendererOrigin
      })),
      allowedOrigins: [
        'file://',
        origin,
        ...(options.rendererOrigin ? [options.rendererOrigin] : [])
      ],
      mcp: options.agentAccess,
      register: true,
      ui: hubUi.createUi({
        branding: {
          productName: 'Lody DevTools',
          tagline: 'Local diagnostics for Lody Desktop',
          windowTitle: 'Lody DevTools'
        },
        dockPreferences: {
          defaultMode: 'float',
          defaultPosition: 'bottom',
          maxVisibleItems: 8
        }
      }),
      renderers: [jsonRenderUi.jsonRenderUiRenderer()],
      devframes: [
        {
          devframe: definition,
          dock: { when: 'false' }
        },
        inspect.createInspectDevframe(),
        a11y.createA11yDevframe(),
        ...(terminals
          ? [
              terminals.createTerminalsDevframe({
                cwd: process.cwd(),
                allowArbitraryCommands: false,
                scrollback: 2_000
              })
            ]
          : [])
      ],
      configure(ctx) {
        for (const dock of ctx.docks.views.values()) {
          if (dock.type === 'iframe' && dock.url.startsWith('/')) {
            ctx.docks.update({
              ...dock,
              url: new URL(dock.url, origin).href
            })
          }
        }
        if (!dashboardView) throw new Error('Lody Devbar view was not initialized')
        // JSON-render's closed catalog has no chart primitive, so the visible
        // dock is a `custom-render` entry whose module (served from
        // `/__lody/dock-renderer.mjs`) mounts the hidden JSON-render view and
        // appends the canvas trends card below it inside the same dock.
        ctx.docks.register(
          toJsonRenderDockEntry(dashboardView, {
            id: DEVBAR_VIEW_DOCK_ID,
            title: 'Main thread',
            icon: 'ph:activity-duotone',
            category: 'performance',
            visibility: 'false'
          })
        )
        ctx.docks.register({
          type: 'custom-render',
          id: DEVBAR_DOCK_ID,
          title: 'Main thread',
          icon: 'ph:activity-duotone',
          category: 'performance',
          renderer: {
            importFrom: new URL('/__lody/dock-renderer.mjs', origin).href
          }
        })
        ctx.docks.activate(DEVBAR_DOCK_ID)
      }
    })
    await hub.ready
  } catch (error) {
    await hub?.close().catch(() => undefined)
    await closeServer(server).catch(() => undefined)
    throw error
  }

  const connection = {
    connectionMeta: hub.connectionMeta(),
    metaBaseUrl: `${origin}${DEVFRAMES_HUB_BASE}__connection.json`
  }

  return {
    connection,
    mcpUrl: options.agentAccess ? `${origin}${DEVFRAMES_HUB_BASE}__mcp` : null,
    uiUrl: `${origin}${DEVFRAMES_HUB_BASE}`,
    embeddedScriptUrl: `${origin}${DEVFRAMES_HUB_BASE}embedded.js`,
    deepLink,
    close: async () => {
      await hub?.close()
      await closeServer(server)
    }
  }
}
