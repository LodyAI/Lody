export type DesktopLaunchEvent = { url?: string; activate?: boolean }

/** Keep early OS callbacks while the ownership gate and application import run. */
export function createDesktopLaunchBuffer(): {
  push: (event: DesktopLaunchEvent) => void
  bind: (handler: (event: DesktopLaunchEvent) => void) => void
} {
  let handle: ((event: DesktopLaunchEvent) => void) | undefined
  const pending: DesktopLaunchEvent[] = []
  return {
    push(event: DesktopLaunchEvent) {
      if (handle) handle(event)
      else {
        if (pending.length === 32) pending.shift()
        pending.push(event)
      }
    },
    bind(handler: (event: DesktopLaunchEvent) => void) {
      if (handle) throw new Error('Desktop launch handler is already bound')
      handle = handler
      for (const event of pending.splice(0)) handler(event)
    }
  }
}
