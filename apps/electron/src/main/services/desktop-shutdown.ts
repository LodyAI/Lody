/** Prevent quit (and OS lease release) until owned execution has confirmed exit. */
export function createDesktopQuitBarrier(options: {
  prepare?: () => Promise<boolean>
  stop: () => Promise<void>
  quit: () => void
  recover?: () => boolean | Promise<boolean>
  reportFailure: (error: unknown, recovered: boolean) => void
  /** The app stays running: a renderer chose Stay, or cleanup failed. */
  cancelled?: () => void
}) {
  let state: 'running' | 'stopping' | 'stopped' = 'running'
  return (event: { preventDefault: () => void }): Promise<void> | void => {
    if (state === 'stopped') return
    event.preventDefault()
    if (state === 'stopping') return
    state = 'stopping'
    return Promise.resolve()
      .then(async () => {
        if (options.prepare && !(await options.prepare())) return false
        await options.stop()
        return true
      })
      .then(
        (allowed) => {
          if (!allowed) {
            state = 'running'
            options.cancelled?.()
            return
          }
          state = 'stopped'
          options.quit()
        },
        async (error: unknown) => {
          let recovered = false
          try {
            recovered = (await options.recover?.()) ?? false
          } catch {
            /* report original failure */
          }
          state = 'running'
          options.cancelled?.()
          options.reportFailure(error, recovered)
        }
      )
  }
}

/** Ends the recovery wait without abandoning or replacing an unresolved owner. */
export async function waitForQuitRecovery<T>(
  cleanup: Promise<T>,
  timeoutMs = 30_000
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      cleanup,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Only resources whose execution ends with Electron main may use this budget.
 * A deadline ends the wait, never releases custody or permits a replacement.
 * The caller must terminate main if any resource remains unconfirmed. */
export async function drainMainProcessQuitResources(
  resources: ReadonlyArray<{ name: string; close: () => Promise<void> }>,
  timeoutMs = 15_000,
  observe: (name: string, state: 'closing' | 'closed' | 'failed' | 'timeout') => void = () => {}
): Promise<string[]> {
  const notify: typeof observe = (name, state) => {
    try {
      observe(name, state)
    } catch {
      // A diagnostic sink cannot own termination.
    }
  }
  const unconfirmed = new Set(resources.map((resource) => resource.name))
  const pending = new Set(unconfirmed)
  const cleanup = Promise.all(
    resources.map(async ({ name, close }) => {
      notify(name, 'closing')
      try {
        await close()
        unconfirmed.delete(name)
        notify(name, 'closed')
      } catch {
        notify(name, 'failed')
      } finally {
        pending.delete(name)
      }
    })
  )
  await waitForQuitRecovery(cleanup, timeoutMs)
  for (const name of pending) notify(name, 'timeout')
  return [...unconfirmed]
}
