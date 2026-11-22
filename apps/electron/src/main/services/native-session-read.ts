import type { E2eeMachineSharingView } from '@lody/platform'
import {
  getSessionRoomId,
  MACHINE_DOC_PREFIX,
  SESSION_DOC_PREFIX,
  type MachineId,
  type SessionId
} from '@lody/shared'
import {
  isNativePreviewCommentDocId,
  isNativeSessionDocId
} from '@lody/shared/native-workspace-meta-ipc'
import { getSessionIdFromPreviewCommentRoomId } from '@lody/shared/preview-comment-types'
import type { NativeWorkspaceMeta } from '@lody/shared/node/native-workspace-meta'
import {
  getLocalProjectVisibilityKey,
  isSessionEditableToUser,
  isUsableSharedMachineView,
  resolveSessionVisibilityState,
  sessionReadGrantsFromSharing,
  type SessionMachineRecord
} from '@lody/shared/session-visibility'

/** An admitted encrypted reader: the signed-in account and its verified ledger facts. */
export interface NativeEncryptedAccess {
  readonly accountId: string
  /** This device's membership in the verified ledger; machine ownership is matched on it. */
  readonly membershipId: string | null
  /** The verified ledger lets this device write content (an active non-Guest member). */
  readonly mayWrite: boolean
  readMachineSharing(machineId: string): Promise<E2eeMachineSharingView>
}

/**
 * A renderer reads a Session only under the session read rules, and writes one
 * only when it may edit it: the same shared functions the renderer lists and edits
 * Sessions with. A Preview comment document follows its Session. Inputs come from
 * native Meta and the host's verified ledger and sharing view, never from the
 * renderer; a machine's owner is its verified ledger owner, never a Meta field.
 */
export async function authorizeNativeSessionAccess(
  access: NativeEncryptedAccess,
  meta: NativeWorkspaceMeta,
  workspaceId: string,
  docId: string,
  mode: 'read' | 'write'
) {
  const sessionDocId = isNativePreviewCommentDocId(docId)
    ? getSessionRoomId(getSessionIdFromPreviewCommentRoomId(docId) as SessionId)
    : docId
  if (!isNativeSessionDocId(sessionDocId)) return
  const denied = () =>
    new Error(mode === 'read' ? 'native_doc_read_denied' : 'native_doc_write_denied')
  if (mode === 'write' && !access.mayWrite) throw denied()
  const read = async (id: string) => {
    const row = await meta.readDoc(id)
    return row && !row.deleted ? (row.meta as SessionMachineRecord) : undefined
  }
  const id = sessionDocId.slice(SESSION_DOC_PREFIX.length)
  const found = await read(sessionDocId)
  if (!found) throw denied()
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
  const view = machineId
    ? await access.readMachineSharing(machineId).catch(() => undefined)
    : undefined
  const owned =
    !!machineId &&
    !!view &&
    !view.removed &&
    access.membershipId !== null &&
    view.ownerMembershipId === access.membershipId
  const shared = !owned && !!machine && !!view && isUsableSharedMachineView(machineId!, view)
  const visibleMachineIds = new Set(machineId && (owned || shared) ? [machineId] : [])
  const visibleProjectKeys = new Set(
    machineId && shared
      ? view!.projects.map((project) => getLocalProjectVisibilityKey(machineId, project))
      : []
  )
  const ownedMachineIds = new Set(machineId && owned ? [machineId] : [])
  if (mode === 'write') {
    if (
      !isSessionEditableToUser(
        session,
        visibleMachineIds,
        visibleProjectKeys,
        access.accountId,
        ownedMachineIds
      )
    )
      throw denied()
    return
  }
  const state = resolveSessionVisibilityState(session, visibleMachineIds, visibleProjectKeys, {
    currentUserId: access.accountId,
    ownedMachineIds,
    readSharedSessions:
      machineId && view
        ? new Map([[machineId, { machineId, ...sessionReadGrantsFromSharing(view) }]])
        : undefined,
    sessionsById,
    workspaceId
  })
  if (state !== 'visible') throw denied()
}
