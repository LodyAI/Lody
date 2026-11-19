import type { WebContents } from 'electron'
import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import { connectNativeRepo, isNativeWorkspaceMetaEnabled } from '@lody/shared/node/native-repo'
import {
  createNativeWorkspaceMeta,
  importLegacyMeta,
  type NativeWorkspaceMeta
} from '@lody/shared/node/native-workspace-meta'
import {
  NATIVE_META_CHANNEL,
  NativeMetaCommitSchema,
  NativeMetaImportSchema,
  NativeMetaOpenSchema,
  NativeMetaReleaseSchema,
  type NativeMetaCommand
} from '@lody/shared/native-workspace-meta-ipc'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../../platform'
import { bundledNativeRepoHostLauncher } from '../../services/cli-service'

class NotCommitted extends Error {}

// Host-controlled; renderer input cannot enable it or choose another workspace.
const enabled = () => isLocalPlatform() && isNativeWorkspaceMetaEnabled()
async function admit(workspaceId: string) {
  if (!enabled()) throw new Error('native_meta_disabled')
  const snapshot = await readLocalPlatformSnapshot()
  if (snapshot?.workspace.workspaceId !== workspaceId) throw new Error('native_meta_scope_denied')
}

/** One shared connection and one Meta observation per workspace in main. */
const metas = new Map<string, Promise<NativeWorkspaceMeta>>()
function workspaceMeta(workspaceId: string) {
  let meta = metas.get(workspaceId)
  if (!meta) {
    meta = connectNativeRepo({ launcher: bundledNativeRepoHostLauncher }).then(({ client }) =>
      createNativeWorkspaceMeta(client, workspaceId, (reason) => new NotCommitted(reason))
    )
    metas.set(workspaceId, meta)
    meta.catch(() => metas.delete(workspaceId))
  }
  return meta
}

/** Window-owned view registrations; a closed or navigated window drops its own. */
const views = new Map<WebContents, Map<string, () => void>>()
function windowViews(sender: WebContents) {
  let owned = views.get(sender)
  if (owned) return owned
  const created = new Map<string, () => void>()
  views.set(sender, created)
  const drop = () => {
    views.delete(sender)
    for (const unsubscribe of created.values()) unsubscribe()
    created.clear()
  }
  sender.once('destroyed', drop)
  sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) drop()
  })
  return (owned = created)
}

/** Finite domain IPC: approved views and Meta commands only. */
export class NativeWorkspaceMetaIpc extends ProductWindowIpcService {
  static override readonly groupName = 'nativeWorkspaceMeta'

  @IpcMethod()
  async available(input: unknown) {
    if (!enabled()) return false
    await admit(NativeMetaOpenSchema.pick({ workspaceId: true }).parse(input).workspaceId)
    return true
  }

  @IpcMethod()
  async open(input: unknown) {
    const { workspaceId, observationId } = NativeMetaOpenSchema.parse(input)
    await admit(workspaceId)
    const sender = getIpcContext().event.sender
    const owned = windowViews(sender)
    if (owned.has(observationId) || owned.size >= 16) throw new Error('native_meta_view_denied')
    const meta = await workspaceMeta(workspaceId)
    const opened = await meta.open((update) => {
      if (!sender.isDestroyed()) sender.send(NATIVE_META_CHANNEL, { observationId, update })
    })
    if (views.get(sender) !== owned) {
      opened.unsubscribe()
      throw new Error('native_meta_view_closed')
    }
    owned.set(observationId, opened.unsubscribe)
    return opened.snapshot
  }

  @IpcMethod()
  async release(input: unknown) {
    const { observationId } = NativeMetaReleaseSchema.parse(input)
    const owned = views.get(getIpcContext().event.sender)
    owned?.get(observationId)?.()
    owned?.delete(observationId)
  }

  /** `notCommitted` is a proven pre-write refusal; any rejection is an unknown outcome. */
  @IpcMethod()
  async commit(input: unknown) {
    const { workspaceId, command } = NativeMetaCommitSchema.parse(input)
    await admit(workspaceId)
    const meta = await workspaceMeta(workspaceId)
    try {
      return await meta.commit(command as NativeMetaCommand)
    } catch (error) {
      if (error instanceof NotCommitted)
        return { outcome: 'not-committed' as const, reason: error.message }
      throw error
    }
  }

  @IpcMethod()
  async importLegacy(input: unknown) {
    const { workspaceId, source, bundle } = NativeMetaImportSchema.parse(input)
    await admit(workspaceId)
    const { client } = await connectNativeRepo({ launcher: bundledNativeRepoHostLauncher })
    return importLegacyMeta(client, workspaceId, source, async () => bundle)
  }
}
