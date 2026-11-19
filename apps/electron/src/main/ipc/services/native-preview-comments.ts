import type { WebContents } from 'electron'
import { getIpcContext, IpcMethod } from 'electron-ipc-decorator'
import { ProductWindowIpcService } from '../product-window-ipc-service'
import { isLocalPlatform, readLocalPlatformSnapshot } from '../../platform'
import {
  NativePreviewScopeSchema,
  NativePreviewOpenSchema,
  NativePreviewReleaseSchema,
  NativePreviewMutationSchema,
  NATIVE_PREVIEW_CHANNEL
} from '@lody/shared/native-preview-comments'
import {
  observeRoom,
  deferredObservationSource,
  type ObservationEvent,
  type ReleaseReceipt
} from '@lody/shared/room-observation'
import type { NativeCommentRow } from '@lody/shared/native-preview-comments'
import type { SessionId } from '@lody/shared'

// The flag is host-controlled and cannot be enabled by renderer input.
const enabled = () => isLocalPlatform() && process.env.LODY_NATIVE_PREVIEW_COMMENTS === '1'
async function admit(workspaceId: string) {
  if (!enabled()) throw new Error('native_preview_disabled')
  const snapshot = await readLocalPlatformSnapshot()
  if (!snapshot || snapshot.workspace.workspaceId !== workspaceId)
    throw new Error('native_preview_scope_denied')
  return snapshot
}
const owners = new Map<WebContents, Map<string, { release(): Promise<ReleaseReceipt> }>>()

function windowOwners(sender: WebContents) {
  let slots = owners.get(sender)
  if (slots) return slots
  slots = new Map()
  owners.set(sender, slots)
  const close = () => {
    owners.delete(sender)
    // Each transport closes its own client on window loss, independently of an ACK.
    for (const observation of slots.values()) void observation.release().catch(() => {})
    slots.clear()
  }
  sender.once('destroyed', close)
  sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) close()
  })
  return slots
}

/** A finite domain IPC group; preload exposes no raw engine channel. */
export class NativePreviewCommentsIpc extends ProductWindowIpcService {
  static override readonly groupName = 'nativePreviewComments'

  @IpcMethod()
  async available(input: unknown) {
    const scope = NativePreviewScopeSchema.parse(input)
    if (!enabled()) return false
    await admit(scope.workspaceId)
    return true
  }

  @IpcMethod()
  async open(input: unknown) {
    const request = NativePreviewOpenSchema.parse(input)
    const sender = getIpcContext().event.sender
    const slots = windowOwners(sender)
    if (slots.size >= 128) throw new Error('native_preview_observation_limit')
    if (slots.has(request.observationId)) throw new Error('native_preview_duplicate_observation')
    const source = deferredObservationSource<NativeCommentRow>(async (listener) => {
      await admit(request.workspaceId)
      const { connectNativePreviewHost, createNativePreviewComments } =
        await import('@lody/shared/node/native-repo')
      const client = await connectNativePreviewHost()
      const lost = () => {
        void client.close()
      }
      sender.once('destroyed', lost)
      const navigating = (
        _event: unknown,
        _url: string,
        _inPlace: boolean,
        isMainFrame: boolean
      ) => {
        if (isMainFrame) lost()
      }
      sender.on('did-start-navigation', navigating)
      try {
        const domain = createNativePreviewComments(client, request.workspaceId)
        await domain.ensure()
        const observation = domain.observe(request.sessionId, (event) =>
          listener(
            event.kind === 'invalidated'
              ? event
              : {
                  ...event,
                  entries: event.entries.map((row) => ({
                    id: String(row.key[2]),
                    comment: row.deleted
                      ? null
                      : (row.value as unknown as NativeCommentRow['comment'])
                  }))
                }
          )
        )
        const ready = observation.ready.catch(async (error) => {
          await client.close()
          throw error
        })
        return {
          ready,
          handle: {
            release: async () => {
              const result = await observation.release()
              await client.close()
              sender.removeListener('destroyed', lost)
              sender.removeListener('did-start-navigation', navigating)
              return result
            }
          }
        }
      } catch (error) {
        await client.close()
        sender.removeListener('destroyed', lost)
        sender.removeListener('did-start-navigation', navigating)
        throw error
      }
    })
    const observation = observeRoom(source, (event: ObservationEvent<NativeCommentRow>) => {
      if (!sender.isDestroyed() && owners.get(sender) === slots)
        sender.send(NATIVE_PREVIEW_CHANNEL, { observationId: request.observationId, event })
    })
    slots.set(request.observationId, observation)
    try {
      await observation.ready
    } catch (error) {
      await observation.release()
      slots.delete(request.observationId)
      throw error
    }
  }

  @IpcMethod()
  async release(input: unknown) {
    const { observationId } = NativePreviewReleaseSchema.parse(input)
    const slots = owners.get(getIpcContext().event.sender)
    const observation = slots?.get(observationId)
    if (!observation) return { status: 'disconnected' as const, generation: 0 }
    const result = await observation.release()
    slots?.delete(observationId)
    return result
  }

  @IpcMethod()
  async mutate(input: unknown) {
    const request = NativePreviewMutationSchema.parse(input)
    const identity = await admit(request.workspaceId)
    const mutation = request.mutation
    if (mutation.kind === 'create' && mutation.comment.authorId !== identity.userId)
      throw new Error('native_preview_author_denied')
    if (mutation.kind === 'resolve' && mutation.resolvedBy !== identity.userId)
      throw new Error('native_preview_author_denied')
    const { connectNativePreviewHost, createNativePreviewComments } =
      await import('@lody/shared/node/native-repo')
    const client = await connectNativePreviewHost()
    try {
      const domain = createNativePreviewComments(client, request.workspaceId)
      await domain.ensure()
      await domain.mutate(request.sessionId as SessionId, mutation)
    } finally {
      await client.close()
    }
  }
}
