import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths'
import type { RendererWfBinding } from '@lody/shared/renderer-room-migration'

/** Read the owning journal without opening an engine or changing its schema. */
export function readNativeWorkspaceFlockOwner(
  dataRoot: string,
  binding: RendererWfBinding
): 'legacy' | 'native' | 'frozen' {
  return readNativeWorkspaceRoomOwner(dataRoot, binding, 'flock')
}

export function readNativeWorkspaceMetaOwner(
  dataRoot: string,
  binding: Omit<RendererWfBinding, 'roomId'>
): 'legacy' | 'native' | 'frozen' {
  return readNativeWorkspaceRoomOwner(dataRoot, { ...binding, roomId: 'meta' }, 'meta')
}

function readNativeWorkspaceRoomOwner(
  dataRoot: string,
  binding: RendererWfBinding,
  kind: 'flock' | 'meta'
): 'legacy' | 'native' | 'frozen' {
  const selected = resolveLocalIndependentRepo({
    platform: 'local',
    dataRoot,
    accountId: binding.accountId,
    workspaceId: binding.workspaceId
  })
  const file = join(selected.directory, 'routes.sqlite3')
  if (!existsSync(file)) return 'legacy'
  const database = new Database(file, { readonly: true, fileMustExist: true })
  try {
    return database.transaction(() => {
      const ownerBinding = JSON.stringify([binding.accountId, binding.workspaceId])
      const roomKey = JSON.stringify({ kind, id: binding.roomId })
      const maintenance = database
        .prepare('SELECT 1 FROM native_room_maintenance WHERE binding = ? AND room_key = ?')
        .get(ownerBinding, roomKey)
      if (maintenance) return 'frozen' as const
      const row = database
        .prepare('SELECT stage FROM native_room_migrations WHERE binding = ? AND room_key = ?')
        .get(ownerBinding, roomKey) as { stage: string } | undefined
      if (!row || row.stage === 'legacy') return 'legacy' as const
      if (row.stage === 'native') return 'native' as const
      if (row.stage === 'frozen' || row.stage === 'verified') return 'frozen' as const
      throw new Error('Unknown native room ownership stage')
    })()
  } finally {
    database.close()
  }
}

/** Published WF is persistent state: a missing native DB is never a rebuildable empty catalog. */
export function assertPublishedNativeWorkspaceFlockStorage(
  dataRoot: string,
  binding: RendererWfBinding
): void {
  assertPublishedNativeWorkspaceRoomStorage(dataRoot, binding, 'flock')
}

export function assertPublishedNativeWorkspaceMetaStorage(
  dataRoot: string,
  binding: Omit<RendererWfBinding, 'roomId'>
): void {
  assertPublishedNativeWorkspaceRoomStorage(dataRoot, { ...binding, roomId: 'meta' }, 'meta')
}

function assertPublishedNativeWorkspaceRoomStorage(
  dataRoot: string,
  binding: RendererWfBinding,
  kind: 'flock' | 'meta'
): void {
  const selected = resolveLocalIndependentRepo({
    platform: 'local',
    dataRoot,
    accountId: binding.accountId,
    workspaceId: binding.workspaceId
  })
  const journalPath = join(selected.directory, 'routes.sqlite3')
  if (!existsSync(journalPath)) return
  const journal = new Database(journalPath, { readonly: true, fileMustExist: true, timeout: 0 })
  let published = false
  try {
    const row = journal
      .prepare('SELECT stage FROM native_room_migrations WHERE binding=? AND room_key=?')
      .get(
        JSON.stringify([binding.accountId, binding.workspaceId]),
        JSON.stringify({ kind, id: binding.roomId })
      ) as { stage: string } | undefined
    published = row?.stage === 'native'
  } finally {
    journal.close()
  }
  if (!published) return
  const file = join(
    selected.dataDir,
    'namespaces',
    `ns_${Buffer.from(binding.workspaceId).toString('hex')}.sqlite3`
  )
  if (!existsSync(file))
    throw new Error('Native workspace catalog recovery required: published storage is missing')
  const database = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 })
  try {
    database.transaction(() => {
      const schema = database.prepare("SELECT v FROM v2_meta WHERE k='schema_version'").get() as
        | { v: number }
        | undefined
      const room = database
        .prepare('SELECT encryption FROM v2_rooms WHERE room_kind=? AND room_id=?')
        .get(kind === 'flock' ? 2 : 3, binding.roomId) as { encryption: number } | undefined
      if (schema?.v !== 1 || !room || room.encryption !== 0)
        throw new Error(
          'Native workspace catalog recovery required: room is absent, protected, or unsupported'
        )
    })()
  } finally {
    database.close()
  }
}
