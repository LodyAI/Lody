// One quit that relaunches the app, requested by a renderer. Quit runs through
// the desktop quit barrier, which a renderer's Stay answer or an unconfirmed CLI
// exit can cancel. `app.relaunch()` cannot be withdrawn once called, so it is
// deferred to `will-quit`, the point where the quit can no longer be cancelled.
import { app } from 'electron'

export type RelaunchQuitOutcome = 'quitting' | 'cancelled'

let pending: ((outcome: RelaunchQuitOutcome) => void) | null = null

/** Quit and relaunch; settles `cancelled` when the app stays running. */
export function quitAndRelaunch(): Promise<RelaunchQuitOutcome> {
  if (pending) return Promise.resolve('cancelled')
  return new Promise((resolve) => {
    pending = resolve
    app.quit()
  })
}

/** `will-quit`: the quit is final. */
export function relaunchIfRequested(): void {
  if (!pending) return
  app.relaunch()
  pending('quitting')
  pending = null
}

/** The quit barrier kept the app running. */
export function cancelRequestedRelaunch(): void {
  pending?.('cancelled')
  pending = null
}
