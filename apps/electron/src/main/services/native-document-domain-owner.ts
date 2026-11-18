import { createScheduleDefinitionRegistryAdapter } from '@lody/shared/node/native-schedule-definition'
import { join } from 'node:path'
import type { RepoClient } from '@loro-dev/loro-repo-client'
import type { SessionId, WorkspaceId } from '@lody/shared'
import {
  createNativeDocumentDomains,
  readNativeDocumentDomainRoute
} from '@lody/shared/node/native-document-domains'
import { createNativeScheduleRegistry } from '@lody/shared/node/native-schedule-registry'
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths'
import type { NativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility'
import type { createNativeWorkspaceMeta } from '@lody/shared/node/native-workspace-meta'
import type { NativeDocumentDomainTarget } from '@lody/shared/native-document-domain-ipc'

type Metadata = ReturnType<typeof createNativeWorkspaceMeta>
/** Borrows the application's single physical host connection. Only exact rooms
 * with committed migration receipts are exposed; no legacy fallback or body seed. */
export function createMainNativeDocumentDomainOwner(options: {
  accountId: string
  workspaceId: WorkspaceId
  dataRoot: string
  metadata: Metadata
  compatibility: NativeRepoSdkCompatibility
  assertCurrent(): void
  getClient(): Promise<{ client: RepoClient; generation: string; sdkArtifactId: string }>
}) {
  const selected = resolveLocalIndependentRepo({ platform: 'local', ...options })
  const binding = {
    ...options,
    journalPath: join(selected.directory, 'document-routes.sqlite3'),
    dataDir: selected.dataDir
  }
  let retired = false
  const check = () => {
    if (retired) throw new Error('Document owner retired')
    options.assertCurrent()
    options.metadata.assertCurrent()
  }
  const authorize = async (target: NativeDocumentDomainTarget) => {
    check()
    const roomId = `${target.domain === 'preview_comments' ? 'preview-comment-' : 'schedule-'}${target.id}`
    if (!(await options.metadata.document(roomId).read()))
      throw new Error('Document metadata unavailable')
    if (
      target.domain === 'preview_comments' &&
      !(await options.metadata.document(`session-${target.id}`).read())
    )
      throw new Error('Preview parent metadata unavailable')
    check()
  }
  const registry = createNativeScheduleRegistry({
    workspaceId: options.workspaceId,
    namespace: options.workspaceId,
    writer: `main-definition:${process.pid}`,
    getClient: async () => {
      check()
      const current = await options.getClient()
      check()
      return current.client
    },
    assertAccess: check,
    flush: async () => {
      check()
    }
  })
  const definitionRegistry = createScheduleDefinitionRegistryAdapter(registry, check)
  const domains = createNativeDocumentDomains({
    ...binding,
    compatibility: options.compatibility,
    writer: `main-definition:${process.pid}`,
    assertCurrent: check,
    getClient: options.getClient,
    authorize: (family, id) => authorize({ domain: family, id }),
    flushDefinition: async () => {
      check()
    },
    registry: definitionRegistry
  })
  return {
    definitionRegistry,
    authorize,
    route(target: NativeDocumentDomainTarget) {
      check()
      return readNativeDocumentDomainRoute(binding, target.domain, target.id)
    },
    async acquire(target: NativeDocumentDomainTarget) {
      await authorize(target)
      if (target.domain === 'preview_comments') {
        const port = await domains.preview(target.id as SessionId)
        if (!port) throw new Error('Native preview unavailable')
        return { domain: 'preview_comments' as const, port }
      }
      const port = await domains.schedule(target.id)
      if (!port) throw new Error('Native definition unavailable')
      return { domain: 'schedule_definition' as const, port }
    },
    async close() {
      retired = true
      const results = await Promise.allSettled([domains.close(), registry.close()])
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length) throw new AggregateError(failures, 'Document owner cleanup unconfirmed')
    }
  }
}
