export type HangIncident = { id: string; startedAt: number }

type Options = {
  now: () => number
  schedule: (callback: () => void, delay: number) => () => void
  record: (event: string, incident: HangIncident, details?: Record<string, unknown>) => void
  showDialog: () => Promise<number>
  reload: () => void
  quit: () => void
}

/** A dialog may outlive the stall that opened it. Its result belongs to that stall only. */
export function createRendererHangWatchdog(options: Options) {
  let active: HangIncident | null = null
  let cancelTimer: (() => void) | undefined
  let dialogOpen = false
  let disposed = false
  let sequence = 0

  function record(event: string, incident: HangIncident, details?: Record<string, unknown>) {
    options.record(event, incident, {
      elapsedMs: options.now() - incident.startedAt,
      stillUnresponsive: active === incident,
      ...details
    })
  }

  function arm() {
    cancelTimer?.()
    if (!active || dialogOpen || disposed) return
    const incident = active
    cancelTimer = options.schedule(() => {
      cancelTimer = undefined
      if (active !== incident || dialogOpen || disposed) return
      dialogOpen = true
      record('dialog-opened', incident)
      void (async () => {
        try {
          const response = await options.showDialog()
          if (disposed) return
          record('dialog-result', incident, { response })
          // Reload / quit remain explicit user actions, including after recovery.
          if (response === 1) {
            reset('reload')
            options.reload()
          } else if (response === 2) {
            reset('quit')
            options.quit()
          }
        } catch (error) {
          record('dialog-error', incident, { error: String(error) })
        } finally {
          dialogOpen = false
          arm()
        }
      })()
    }, 10_000)
  }

  function reset(reason: string) {
    const previous = active
    active = null
    cancelTimer?.()
    cancelTimer = undefined
    if (previous) record(reason, previous)
  }

  return {
    unresponsive() {
      if (disposed || active) return
      const startedAt = options.now()
      active = { id: `${startedAt}-${++sequence}`, startedAt }
      record('unresponsive', active)
      arm()
    },
    responsive() {
      reset('responsive')
    },
    navigation() {
      reset('navigation')
    },
    dispose() {
      disposed = true
      reset('closed')
    }
  }
}
