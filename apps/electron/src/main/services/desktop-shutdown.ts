/** Prevent quit (and OS lease release) until owned execution has confirmed exit. */
export function createDesktopQuitBarrier(options: {
  prepare?: () => Promise<boolean>
  stop: () => Promise<void>
  quit: () => void
  reportFailure: (error: unknown) => void
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
            return
          }
          state = 'stopped'
          options.quit()
        },
        (error: unknown) => {
          state = 'running'
          options.reportFailure(error)
        }
      )
  }
}
