export type DesktopLaunchAdmission = {
  /**
   * Waits for startup admission before handing the destination to the existing
   * launch handler. Rejected startup never reports success.
   */
  accept: (url: string) => Promise<boolean>
  /** Enables delivery after the application has bound its launch handler. */
  markReady: () => void
  /** Refuses pending and future handoffs for this process lifetime. */
  markRejected: () => void
}

/**
 * Separates port ownership from the ability to consume a launch. The desktop
 * lease exists before Host admission and application import, so early handoff
 * requests must wait instead of being counted as delivered into a buffer that
 * a refused startup will never bind.
 */
export function createDesktopLaunchAdmission(
  deliver: (url: string) => void
): DesktopLaunchAdmission {
  let state: 'pending' | 'ready' | 'rejected' = 'pending'
  let settle: ((accepted: boolean) => void) | undefined
  const admitted = new Promise<boolean>((resolve) => {
    settle = resolve
  })

  const finish = (ready: boolean) => {
    if (state !== 'pending') return
    state = ready ? 'ready' : 'rejected'
    settle?.(ready)
    settle = undefined
  }

  return {
    async accept(url: string): Promise<boolean> {
      if (state === 'pending') await admitted
      if (state !== 'ready') return false
      deliver(url)
      return true
    },
    markReady: () => finish(true),
    markRejected: () => finish(false)
  }
}
