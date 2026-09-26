/** Prevent quit (and OS lease release) until owned execution has confirmed exit. */
export function createDesktopQuitBarrier(options: {
  stop: () => Promise<void>
  quit: () => void
  reportFailure: (error: unknown) => void
}) {
  let state: 'running' | 'stopping' | 'stopped' = 'running'
  return (event: { preventDefault: () => void }): void => {
    if (state === 'stopped') return
    event.preventDefault()
    if (state === 'stopping') return
    state = 'stopping'
    void Promise.resolve()
      .then(options.stop)
      .then(
        () => {
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
