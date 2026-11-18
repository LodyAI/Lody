import type { createNativeWorkspaceMeta } from '@lody/shared/node/native-workspace-meta'
import {
  rendererDocumentDomainScopeSchema,
  type RendererDocumentDomainScope
} from '@lody/shared/renderer-document-domain-migration'
/** Window enumeration/freeze is distinct from normal domain read/write grants.
 * Only an explicit local creation policy may admit a pristine metadata facet;
 * this read performs no reservation, room creation or body authoring. */
export async function assertMainNativeDocumentDomainMigrationAuthority(options: {
  metadata: ReturnType<typeof createNativeWorkspaceMeta>
  scope: RendererDocumentDomainScope
  actorId: string
  machineId: string | undefined
  creationEnabled: boolean
}): Promise<void> {
  const scope = rendererDocumentDomainScopeSchema.parse(options.scope)
  const owner = options.metadata
  owner.assertCurrent()
  if (owner.binding.accountId !== options.actorId)
    throw new Error('Document migration account changed')
  const state = await owner.readDocumentCreationState(scope.metadataDocId)
  owner.assertCurrent()
  const own = state.snapshot.docs.find((row) => row.docId === scope.metadataDocId)
  if (state.pristine) {
    if (!options.creationEnabled) throw new Error('Native document creation disabled')
  } else if (!own || own.deleted) throw new Error('Document metadata unavailable')
  if (scope.domain === 'preview_comments') {
    const parent = state.snapshot.docs.find(
      (row) => row.docId === scope.parentMetadataDocId && !row.deleted
    )
    if (!parent) throw new Error('Preview parent unavailable')
    if (
      state.pristine &&
      (!options.machineId ||
        parent.meta.userId !== options.actorId ||
        parent.meta.machineId !== options.machineId)
    )
      throw new Error('Preview creation authority unavailable')
  }
  owner.assertCurrent()
}
