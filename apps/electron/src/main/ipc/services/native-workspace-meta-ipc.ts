import type { WebContents } from 'electron'
import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import {
  connectNativeRepo,
  importLegacyRoom,
  isLegacyRoomPublished,
  isNativeEncryptedWorkspaceEnabled,
  isNativeWorkspaceMetaEnabled,
  nativeRepoDataDir
} from '@lody/shared/node/native-repo'
import {
  finishPendingNativeWipes,
  nativeEncryptedPendingUpload,
  nativeLocalIdentities,
  nativeWriterSigningKey
} from '@lody/shared/node/native-encrypted-workspace'
import { commitFlockPayloads, observeNativeFlockDoc } from '@lody/shared/node/native-flock-docs'
import {
  commitDocUpdates,
  createNativeRemoteHistoryPort,
  importLegacyDoc,
  isLegacyDocPublished,
  observeNativeDoc
} from '@lody/shared/node/native-docs'
import {
  createNativeWorkspaceMeta,
  type NativeWorkspaceMeta
} from '@lody/shared/node/native-workspace-meta'
import {
  authorizeSessionPatch,
  NATIVE_DOC_PATHS_CHANNEL,
  NativeDocListFieldsSchema,
  NativeDocObservePathsSchema,
  NativeDocPatchSchema,
  NativeDocReadSchema,
  NATIVE_DOC_CHANNEL,
  NATIVE_FLOCK_CHANNEL,
  NativeDocCommitSchema,
  NativeDocLegacyCheckSchema,
  NativeDocLegacySchema,
  NativeDocOpenSchema,
  NATIVE_META_CHANNEL,
  NativeFlockCommitSchema,
  NativeFlockOpenSchema,
  isNativeFlockDocId,
  NativeMetaCommitSchema,
  NativeMetaImportSchema,
  NativeMetaLegacyCheckSchema,
  NativeMetaOpenSchema,
  NativeMetaReleaseSchema,
  type NativeMetaCommand
} from '@lody/shared/native-workspace-meta-ipc'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../../platform'
import { bundledNativeRepoHostLauncher } from '../../services/cli-service'
import {
  admitNativeEncryptedReader,
  removeNativeEncryptedWorkspace,
  type NativeEncryptedAccess
} from '../../services/native-encrypted-access'
import { authorizeNativeSessionAccess } from '../../services/native-session-read'
import { createNativeViews } from '../../services/native-views'
import { onNativeAccessLost } from '../../services/native-encrypted-workspaces'

class NotCommitted extends Error {}

/**
 * Host-controlled; renderer input cannot enable it or choose another workspace.
 * Cloud builds serve encrypted workspaces only (specs/native-engine-cloud-e2ee.md,
 * phase 1), behind their own switch.
 */
/** Encrypted workspaces kept native with the switch off until their rows upload. */
const uploading = new Set<string>()
const encryptedMode = (workspaceId?: string) =>
  !isLocalPlatform() &&
  (isNativeEncryptedWorkspaceEnabled() || (!!workspaceId && uploading.has(workspaceId)))
const enabled = (workspaceId?: string) =>
  (isNativeWorkspaceMetaEnabled() && (isLocalPlatform() || isNativeEncryptedWorkspaceEnabled())) ||
  (!isLocalPlatform() && !!workspaceId && uploading.has(workspaceId))

/**
 * Local: the single local workspace. Cloud: this window's E2EE reader lease for the
 * signed-in account (the first admitted request attaches the namespace). Returns
 * the encrypted access for the per-request session read check.
 */
async function admit(
  workspaceId: string,
  flockDocId?: string
): Promise<NativeEncryptedAccess | undefined> {
  if (!enabled(workspaceId)) throw new Error('native_meta_disabled')
  if (flockDocId !== undefined && !isNativeFlockDocId(workspaceId, flockDocId))
    throw new Error('native_meta_scope_denied')
  if (encryptedMode(workspaceId))
    return admitNativeEncryptedReader(getIpcContext().event.sender.id, workspaceId, await connect())
  const snapshot = await readLocalPlatformSnapshot()
  if (snapshot?.workspace.workspaceId !== workspaceId) throw new Error('native_meta_scope_denied')
  return undefined
}

/** Admission plus, in an encrypted workspace, the session read or edit rules for `docId`. */
async function admitDoc(workspaceId: string, docId: string, mode: 'read' | 'write' = 'read') {
  const access = await admit(workspaceId)
  if (access)
    await authorizeNativeSessionAccess(
      access,
      await workspaceMeta(workspaceId),
      workspaceId,
      docId,
      mode
    )
  return access
}

/** Encrypted namespaces bootstrap from the cloud; nothing local is imported into them. */
function refuseEncryptedImport(workspaceId: string) {
  if (encryptedMode(workspaceId)) throw new Error('native_meta_scope_denied')
}

let swept: Promise<unknown> | undefined
const nativeDataDir = () => nativeRepoDataDir(isLocalPlatform() ? 'local' : 'cloud')
const connect = async () => {
  const connection = await connectNativeRepo({
    launcher: bundledNativeRepoHostLauncher,
    dataDir: nativeDataDir()
  })
  if (!isLocalPlatform())
    await (swept ??= finishPendingNativeWipes(connection.client, connection.dataDir))
  return connection
}

/**
 * Durable encrypted access loss, from the E2EE removal path: every view of the
 * workspace closes and late replies are discarded, then the namespace is retired
 * or dropped.
 */
export function removeNativeWorkspace(
  workspaceId: string,
  reason: 'member_removed' | 'device_revoked',
  revoked: {
    writer: string
    stillCurrent: (writers: readonly string[]) => Promise<boolean>
  }
) {
  if (!enabled(workspaceId) || !encryptedMode(workspaceId)) return Promise.resolve()
  return removeNativeEncryptedWorkspace(workspaceId, reason, {
    ...revoked,
    connect,
    dataDir: nativeDataDir()
  })
}

/** The other identities of this installation recorded for the namespace (candidates only). */
export async function nativeLocalIdentityCandidates(workspaceId: string, writer: string) {
  if (!enabled(workspaceId) || !encryptedMode(workspaceId)) return []
  const writers = await nativeLocalIdentities(nativeDataDir(), workspaceId).list()
  return writers
    .filter((other) => other !== writer)
    .map((other) => ({ writer: other, signingPublicKey: nativeWriterSigningKey(other) }))
}

/** One shared connection and one Meta observation per workspace in main. */
const metas = new Map<string, Promise<NativeWorkspaceMeta>>()
function workspaceMeta(workspaceId: string) {
  let meta = metas.get(workspaceId)
  if (!meta) {
    meta = connect().then(({ client }) =>
      createNativeWorkspaceMeta(client, workspaceId, (reason) => new NotCommitted(reason))
    )
    metas.set(workspaceId, meta)
    meta.catch(() => metas.delete(workspaceId))
  }
  return meta
}

/** Window-owned views and the access fence. */
const views = createNativeViews<WebContents>()
onNativeAccessLost((workspaceId) => {
  views.loseAccess(workspaceId)
  metas
    .get(workspaceId)
    ?.then((meta) => meta.close())
    .catch(() => {})
  metas.delete(workspaceId)
  for (const key of remoteDocs.keys())
    if (key.startsWith(`${workspaceId}\0`)) remoteDocs.delete(key)
})
const watchedSenders = new WeakSet<WebContents>()

/** The sending window; its views are released when its document goes away. */
function viewOwner() {
  const sender = getIpcContext().event.sender
  if (!watchedSenders.has(sender)) {
    watchedSenders.add(sender)
    sender.once('destroyed', () => views.drop(sender))
    sender.on('did-start-navigation', (event, _url, inPlace, isMainFrame) => {
      const sameDocument = (event as { isSameDocument?: boolean }).isSameDocument ?? inPlace
      if (isMainFrame && !sameDocument) views.drop(sender)
    })
  }
  return sender
}

/** Finite domain IPC: approved views and Meta commands only. */
export class NativeWorkspaceMetaIpc extends ProductWindowIpcService {
  static override readonly groupName = 'nativeWorkspaceMeta'

  @IpcMethod()
  async available(input: unknown) {
    const { workspaceId } = NativeMetaOpenSchema.pick({ workspaceId: true }).parse(input)
    if (!enabled(workspaceId) && !isLocalPlatform() && !uploading.has(workspaceId)) {
      const pending = await nativeEncryptedPendingUpload(
        nativeRepoDataDir('cloud'),
        workspaceId,
        connect
      ).catch(() => 0)
      if (pending > 0) {
        uploading.add(workspaceId)
        console.warn('[native-meta] switch is off; the workspace stays native until it uploads', {
          pending
        })
      }
    }
    if (!enabled(workspaceId)) return false
    if (encryptedMode(workspaceId))
      return admit(workspaceId).then(
        () => true,
        (error: unknown) => {
          console.warn('[native-meta] encrypted workspace stays on the legacy path', {
            code: (error as Error | null)?.message?.slice(0, 64)
          })
          return false
        }
      )
    await admit(workspaceId)
    return true
  }

  @IpcMethod()
  async open(input: unknown) {
    const { workspaceId, observationId } = NativeMetaOpenSchema.parse(input)
    const generation = views.generation(workspaceId)
    await admit(workspaceId)
    const sender = viewOwner()
    return views.establish({
      owner: sender,
      workspaceId,
      generation,
      observationId,
      limit: 16,
      start: async () => {
        const meta = await workspaceMeta(workspaceId)
        const opened = await meta.open((update) => {
          if (!sender.isDestroyed()) sender.send(NATIVE_META_CHANNEL, { observationId, update })
        })
        return { release: opened.unsubscribe, value: opened.snapshot }
      }
    })
  }

  @IpcMethod()
  async release(input: unknown) {
    const { observationId } = NativeMetaReleaseSchema.parse(input)
    views.release(getIpcContext().event.sender, observationId)
  }

  /** `notCommitted` is a proven pre-write refusal; any rejection is an unknown outcome. */
  @IpcMethod()
  async commit(input: unknown) {
    const { workspaceId, command } = NativeMetaCommitSchema.parse(input)
    return views.fenced(workspaceId, async (check) => {
      await admit(workspaceId)
      const meta = await workspaceMeta(workspaceId)
      check()
      try {
        return await meta.commit(command as NativeMetaCommand)
      } catch (error) {
        if (error instanceof NotCommitted)
          return { outcome: 'not-committed' as const, reason: error.message }
        throw error
      }
    })
  }

  /** Whether this window's legacy Meta and Flock replicas still need importing. */
  @IpcMethod()
  async needsLegacy(input: unknown) {
    const { workspaceId, source } = NativeMetaLegacyCheckSchema.parse(input)
    if (await admit(workspaceId)) return false
    const { client } = await connect()
    return !(await isLegacyRoomPublished(client, workspaceId, { kind: 'meta', id: 'meta' }, source))
  }

  @IpcMethod()
  async importLegacy(input: unknown) {
    const { workspaceId, flockDocId, source, bundle } = NativeMetaImportSchema.parse(input)
    await admit(workspaceId, flockDocId)
    refuseEncryptedImport(workspaceId)
    const { client } = await connect()
    const room =
      flockDocId === undefined
        ? { kind: 'meta' as const, id: 'meta' }
        : { kind: 'flock' as const, id: flockDocId }
    return importLegacyRoom(client, workspaceId, room, source, async () => bundle)
  }

  /** A window's register view of one owned named Flock document. */
  @IpcMethod()
  async openFlockDoc(input: unknown) {
    const { workspaceId, flockDocId, observationId } = NativeFlockOpenSchema.parse(input)
    const generation = views.generation(workspaceId)
    await admit(workspaceId, flockDocId)
    const sender = viewOwner()
    await views.establish({
      owner: sender,
      workspaceId,
      generation,
      observationId,
      limit: 16,
      start: async () => {
        const { client } = await connect()
        const observation = await observeNativeFlockDoc(
          client,
          workspaceId,
          flockDocId,
          (event) => {
            if (sender.isDestroyed()) return
            sender.send(NATIVE_FLOCK_CHANNEL, {
              observationId,
              event:
                event.kind === 'snapshot'
                  ? { kind: 'snapshot', file: event.file }
                  : event.kind === 'changes'
                    ? { kind: 'changes', registers: event.registers }
                    : event
            })
          }
        )
        return {
          release: () => void observation.release().catch(() => {}),
          ready: observation.ready,
          value: undefined
        }
      }
    })
  }

  /** Resolves only after the payloads are durably committed. */
  @IpcMethod()
  async commitFlockDoc(input: unknown) {
    const { workspaceId, flockDocId, payloads } = NativeFlockCommitSchema.parse(input)
    await views.fenced(workspaceId, async (check) => {
      await admit(workspaceId, flockDocId)
      const { client } = await connect()
      check()
      await commitFlockPayloads(client, workspaceId, flockDocId, payloads)
    })
  }

  /** A window's update view of one replica document (Schedule or Preview comment). */
  @IpcMethod()
  async openDoc(input: unknown) {
    const { workspaceId, docId, observationId, since } = NativeDocOpenSchema.parse(input)
    const generation = views.generation(workspaceId)
    await admitDoc(workspaceId, docId)
    const sender = viewOwner()
    await views.establish({
      owner: sender,
      workspaceId,
      generation,
      observationId,
      limit: 64,
      start: async () => {
        const { client } = await connect()
        const observation = await observeNativeDoc(
          client,
          workspaceId,
          docId,
          (event) => {
            if (!sender.isDestroyed()) sender.send(NATIVE_DOC_CHANNEL, { observationId, event })
          },
          since
        )
        return {
          release: () => void observation.release().catch(() => {}),
          ready: observation.ready,
          value: undefined
        }
      }
    })
  }

  /** Resolves only after the updates are durably committed. */
  @IpcMethod()
  async commitDoc(input: unknown) {
    const { workspaceId, docId, updates } = NativeDocCommitSchema.parse(input)
    await views.fenced(workspaceId, async (check) => {
      await admitDoc(workspaceId, docId, 'write')
      const { client } = await connect()
      check()
      await commitDocUpdates(client, workspaceId, docId, updates)
    })
  }

  /** Whether this window's legacy replica of a document still needs importing. */
  @IpcMethod()
  async needsLegacyDoc(input: unknown) {
    const { workspaceId, docId, source } = NativeDocLegacyCheckSchema.parse(input)
    return views.fenced(workspaceId, async () => {
      if (await admit(workspaceId)) return false
      const { client } = await connect()
      return !(await isLegacyDocPublished(client, workspaceId, docId, source))
    })
  }

  @IpcMethod()
  async importLegacyDoc(input: unknown) {
    const { workspaceId, docId, source, snapshot, version } = NativeDocLegacySchema.parse(input)
    await admit(workspaceId)
    refuseEncryptedImport(workspaceId)
    const { client } = await connect()
    return importLegacyDoc(client, workspaceId, docId, source, async () => ({
      snapshot,
      version
    }))
  }

  /** One JSON path of a remote Session document and the head it was read at. */
  @IpcMethod()
  async readDocPath(input: unknown) {
    const { workspaceId, docId, path } = NativeDocReadSchema.parse(input)
    return views.fenced(workspaceId, async () => {
      await admitDoc(workspaceId, docId)
      return (await remoteDoc(workspaceId, docId)).readPathAt(path)
    })
  }

  /** Bounded, field-aligned rows of a remote Session document's history. */
  @IpcMethod()
  async readDocListFields(input: unknown) {
    const { workspaceId, docId, start, end, fields } = NativeDocListFieldsSchema.parse(input)
    return views.fenced(workspaceId, async () => {
      await admitDoc(workspaceId, docId)
      return (await remoteDoc(workspaceId, docId)).readListFields(start, end, fields)
    })
  }

  /** A window's changed-path view of one remote Session document. */
  @IpcMethod()
  async observeDocPaths(input: unknown) {
    const { workspaceId, docId, observationId } = NativeDocObservePathsSchema.parse(input)
    const generation = views.generation(workspaceId)
    await admitDoc(workspaceId, docId)
    const sender = viewOwner()
    await views.establish({
      owner: sender,
      workspaceId,
      generation,
      observationId,
      limit: 64,
      start: async () => {
        const observation = (await remoteDoc(workspaceId, docId)).observePaths((event) => {
          if (!sender.isDestroyed()) sender.send(NATIVE_DOC_PATHS_CHANNEL, { observationId, event })
        })
        return { release: () => observation.close(), ready: observation.ready, value: undefined }
      }
    })
  }

  /**
   * Applies a renderer's checked JSON patch. A conflict or an unknown outcome
   * is reported as such: an unknown outcome is never a non-write.
   */
  @IpcMethod()
  async applyDocPatch(input: unknown) {
    const { workspaceId, docId, ops, precondition } = NativeDocPatchSchema.parse(input)
    return views.fenced(workspaceId, async (check) => {
      const access = await admitDoc(workspaceId, docId, 'write')
      const userId = access?.accountId ?? (await readLocalPlatformSnapshot())?.userId
      if (!userId) throw new Error('native_meta_scope_denied')
      authorizeSessionPatch(ops, userId)
      const port = await remoteDoc(workspaceId, docId)
      check()
      try {
        return await port.applyPatch(ops, precondition)
      } catch (error) {
        const name = (error as { name?: unknown } | null)?.name
        if (name === 'RemoteWriteConflictError') throw new Error('native_doc_write_conflict')
        if (name === 'RemoteWriteIndeterminateError')
          throw new Error('native_doc_write_indeterminate')
        throw error
      }
    })
  }
}

/** One port per document on main's shared connection. */
const remoteDocs = new Map<string, ReturnType<typeof createNativeRemoteHistoryPort>>()
async function remoteDoc(workspaceId: string, docId: string) {
  const { client } = await connect()
  const key = `${workspaceId}\0${docId}`
  let port = remoteDocs.get(key)
  if (!port) remoteDocs.set(key, (port = createNativeRemoteHistoryPort(client, workspaceId, docId)))
  return port
}
