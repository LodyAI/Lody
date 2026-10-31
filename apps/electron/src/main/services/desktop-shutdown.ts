import { access, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const quitWarningPath = (directory: string) => join(directory, 'quit-unconfirmed')

/** Presence only: never persist workspace identities, content or failure causes. */
export function recordUnconfirmedDesktopQuit(directory: string): Promise<void> {
  return writeFile(quitWarningPath(directory), '', { mode: 0o600 })
}

/** Claim last launch's marker so delivery cannot erase a new quit's warning.
 * Unsupported/failed notifications retain the marker for a later launch. */
export async function reportPreviousUnconfirmedDesktopQuit(
  directory: string,
  notify: () => Promise<{ shown: boolean }>
): Promise<void> {
  const previous = `${quitWarningPath(directory)}.previous`
  try {
    await rename(quitWarningPath(directory), previous)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await access(previous)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if ((await notify()).shown) await unlink(previous)
}

/** No UI is admitted here: parentless native dialogs can block JS timers on macOS.
 * Even marker I/O cannot delay termination beyond this additional budget. */
export async function finishUnconfirmedDesktopQuit(options: {
  record: () => Promise<void>
  exit: (code: 1) => void
}): Promise<void> {
  try {
    await waitForQuitRecovery(Promise.resolve().then(options.record), 1_000)
  } catch {
    // The caller has already logged unconfirmed persistence; marker I/O is best effort.
  } finally {
    options.exit(1)
  }
}

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
