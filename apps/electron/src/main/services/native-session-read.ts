import type { E2eeMachineSharingView } from '@lody/platform'
import {
  getSessionRoomId,
  MACHINE_DOC_PREFIX,
  SESSION_DOC_PREFIX,
  type MachineId,
  type SessionId
} from '@lody/shared'
import { isNativeSessionDocId } from '@lody/shared/native-workspace-meta-ipc'
import type { NativeWorkspaceMeta } from '@lody/shared/node/native-workspace-meta'
import {
  getLocalProjectVisibilityKey,
  isUsableSharedMachineView,
  resolveSessionVisibilityState,
  sessionReadGrantsFromSharing,
  type SessionMachineRecord
} from '@lody/shared/session-visibility'

/** An admitted encrypted reader: the signed-in account and its verified sharing views. */
export interface NativeEncryptedAccess {
  readonly accountId: string
  readMachineSharing(machineId: string): Promise<E2eeMachineSharingView>
}

/**
 * A renderer reads a Session only under the session read rules: the same shared
 * functions the renderer lists Sessions with. Inputs come from native Meta and the
 * host's verified sharing view, never from the renderer.
 */
export async function authorizeNativeSessionRead(
  access: NativeEncryptedAccess,
  meta: NativeWorkspaceMeta,
  workspaceId: string,
  docId: string
) {
  if (!isNativeSessionDocId(docId)) return
  const read = async (id: string) => {
    const row = await meta.readDoc(id)
    return row && !row.deleted
      ? (row.meta as SessionMachineRecord & { ownerUserId?: unknown })
      : undefined
  }
  const id = docId.slice(SESSION_DOC_PREFIX.length)
  const found = await read(docId)
  if (!found) throw new Error('native_doc_read_denied')
  const session = { ...found, id }
  const sessionsById = new Map<string, SessionMachineRecord>()
  if (typeof session.parentSessionId === 'string') {
    const parent = await read(getSessionRoomId(session.parentSessionId as SessionId))
    if (parent)
      sessionsById.set(session.parentSessionId, { ...parent, id: session.parentSessionId })
  }
  const machineId =
    typeof session.machineId === 'string' ? (session.machineId as MachineId) : undefined
  const machine = machineId ? await read(`${MACHINE_DOC_PREFIX}${machineId}`) : undefined
  const owned = !!machineId && machine?.ownerUserId === access.accountId
  const view =
    machineId && !owned
      ? await access.readMachineSharing(machineId).catch(() => undefined)
      : undefined
  const shared = !!machineId && !!machine && !!view && isUsableSharedMachineView(machineId, view)
  const state = resolveSessionVisibilityState(
    session,
    new Set(machineId && (owned || shared) ? [machineId] : []),
    new Set(
      machineId && shared
        ? view!.projects.map((project) => getLocalProjectVisibilityKey(machineId, project))
        : []
    ),
    {
      currentUserId: access.accountId,
      ownedMachineIds: new Set(machineId && owned ? [machineId] : []),
      readSharedSessions:
        machineId && view
          ? new Map([[machineId, { machineId, ...sessionReadGrantsFromSharing(view) }]])
          : undefined,
      sessionsById,
      workspaceId
    }
  )
  if (state !== 'visible') throw new Error('native_doc_read_denied')
}
