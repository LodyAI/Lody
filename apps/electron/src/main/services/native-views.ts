/**
 * Window-owned native views and the per-workspace access fence. A view is
 * registered only after it is established, and only if neither its window nor the
 * workspace's access went away meanwhile; a reply started before an access loss is
 * discarded. Owners are opaque keys (a window's `WebContents` in main).
 */
export interface NativeViews<Owner extends object> {
  /** The workspace's access generation, read before admission. */
  generation(workspaceId: string): number
  /** Throws `native_access_lost` when access was lost since `generation`. */
  check(workspaceId: string, generation: number): void
  /** Runs one reply; an access loss before or during it discards the reply. */
  fenced<A>(workspaceId: string, work: (check: () => void) => Promise<A>): Promise<A>
  /**
   * Establishes a view and registers it. A window or access loss during
   * establishment releases the view and fails; a failed `ready` unregisters it.
   */
  establish<A>(input: {
    owner: Owner
    workspaceId: string
    generation: number
    observationId: string
    limit: number
    start: () => Promise<{ release: () => void; ready?: Promise<unknown>; value: A }>
  }): Promise<A>
  /** Releases one of the owner's views. */
  release(owner: Owner, observationId: string): void
  /** Releases every view of an owner whose document went away. */
  drop(owner: Owner): void
  /** Access loss: every view of the workspace closes and replies in flight are discarded. */
  loseAccess(workspaceId: string): void
}

export function createNativeViews<Owner extends object>(): NativeViews<Owner> {
  const views = new Map<Owner, Map<string, () => void>>()
  const viewWorkspaces = new WeakMap<() => void, string>()
  const generations = new Map<string, number>()
  const generation = (workspaceId: string) => generations.get(workspaceId) ?? 0
  const check = (workspaceId: string, at: number) => {
    if (generation(workspaceId) !== at) throw new Error('native_access_lost')
  }
  return {
    generation,
    check,
    async fenced(workspaceId, work) {
      const at = generation(workspaceId)
      const result = await work(() => check(workspaceId, at))
      check(workspaceId, at)
      return result
    },
    async establish({ owner, workspaceId, generation: at, observationId, limit, start }) {
      check(workspaceId, at)
      let owned = views.get(owner)
      if (!owned) views.set(owner, (owned = new Map()))
      if (owned.has(observationId) || owned.size >= limit)
        throw new Error('native_meta_view_denied')
      const { release, ready, value } = await start()
      if (views.get(owner) !== owned) {
        release()
        throw new Error('native_meta_view_closed')
      }
      if (generation(workspaceId) !== at) {
        release()
        throw new Error('native_access_lost')
      }
      viewWorkspaces.set(release, workspaceId)
      owned.set(observationId, release)
      if (ready)
        try {
          await ready
        } catch (error) {
          if (owned.get(observationId) === release) {
            owned.delete(observationId)
            release()
          }
          throw error
        }
      check(workspaceId, at)
      return value
    },
    release(owner, observationId) {
      const owned = views.get(owner)
      owned?.get(observationId)?.()
      owned?.delete(observationId)
    },
    drop(owner) {
      const owned = views.get(owner)
      if (!owned) return
      views.delete(owner)
      for (const release of owned.values()) release()
      owned.clear()
    },
    loseAccess(workspaceId) {
      generations.set(workspaceId, generation(workspaceId) + 1)
      for (const owned of views.values())
        for (const [observationId, release] of owned)
          if (viewWorkspaces.get(release) === workspaceId) {
            owned.delete(observationId)
            release()
          }
    }
  }
}
