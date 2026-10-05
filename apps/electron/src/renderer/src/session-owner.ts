import { getIpcServices, onIpcEvent } from '@lody/components/lib/electron-ipc-client'
import { createWorkspaceRuntime } from '@lody/components/providers/create-workspace-runtime'
import { createSharedSessionOwner } from '@lody/components/providers/shared-session-owner'
import { jotaiStore } from '@lody/components/lib/utils'
import { userAtom } from '@lody/components/atoms'

const services = getIpcServices()
if (!services) throw new Error('Session owner needs the desktop bridge')
const snapshot = await services.localPlatform.getSnapshot()
if (!snapshot) throw new Error('Local workspace is not provisioned')
jotaiStore.set(userAtom, { id: snapshot.userId, name: 'Local', email: 'local@localhost.invalid' })
const runtime = await createWorkspaceRuntime({
  workspaceId: snapshot.workspace.workspaceId as Parameters<
    typeof createWorkspaceRuntime
  >[0]['workspaceId'],
  workspaceSlug: snapshot.workspace.slug ?? 'local',
  accountId: snapshot.userId,
  apiBaseUrl: '',
  syncMode: 'local',
  cacheWindowId: 'session-owner'
})
const owner = createSharedSessionOwner(runtime, (event) => {
  void services.sessionOwner.publish(event)
})
onIpcEvent('sessionOwner.releaseClient', (id) => owner.releaseClient(id))
onIpcEvent('sessionOwner.request', ({ requestId, clientId, request }) => {
  void (async () => {
    try {
      const value =
        request === 'shutdown' ? await owner.dispose() : await owner.request(clientId, request)
      await services.sessionOwner.reply(requestId, { ok: true, value })
    } catch (error) {
      await services.sessionOwner.reply(requestId, {
        ok: false,
        error: error instanceof Error ? error.message : 'Session owner operation failed'
      })
    }
  })().catch((error) => console.error('[Session owner] Response failed', error))
})
await services.sessionOwner.ready()
