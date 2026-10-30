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
