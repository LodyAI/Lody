import type { SessionId } from '@lody/shared'
import type { WorkspaceRuntime } from '@lody/components/atoms/runtime'

type Target = { workspace: string; sessionId?: string }
type Runtime = Pick<
  WorkspaceRuntime,
  'workspaceSlug' | 'acquireSessionStore' | 'releaseSessionStoreRef'
>

/** Give a local cached entry a chance to arrive before mounting its React tree. */
export function createWindowTargetNavigator({
  getRuntime,
  applyRoute,
  reportError
}: {
  getRuntime: () => Runtime | null
  applyRoute: (target: Target) => Promise<unknown>
  reportError: (error: unknown) => void
}) {
  let generation = 0
  return async (target: Target, completed: () => void): Promise<void> => {
    const current = ++generation
    const runtime = getRuntime()
    if (target.sessionId && runtime?.workspaceSlug === target.workspace) {
      const id = target.sessionId as SessionId
      let timer: ReturnType<typeof setTimeout> | undefined
      const acquisition = runtime
        .acquireSessionStore(id)
        .then(() => runtime.releaseSessionStoreRef(id), reportError)
      try {
        // Slow/cold storage must still enter the route's loading/error UI. The
        // borrow releases even if navigation times out or a newer target wins.
        await Promise.race([
          acquisition,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 50)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    if (current !== generation) return
    try {
      await applyRoute(target)
    } finally {
      if (current === generation) completed()
    }
  }
}
