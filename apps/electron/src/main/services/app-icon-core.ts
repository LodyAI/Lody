export type AppIconName = 'default' | 'aqua'
export type AppIconState = { supported: boolean; name: AppIconName }

export function parseAppIconName(value: unknown): AppIconName {
  if (value !== 'default' && value !== 'aqua') throw new Error('Unknown app icon')
  return value
}

/** One queue for every window and startup restoration. Persist only confirmed changes. */
export function createAppIconController(deps: {
  supported: boolean
  read: () => AppIconName
  write: (name: AppIconName) => void
  apply: (name: AppIconName) => Promise<void>
}) {
  let tail: Promise<unknown> = Promise.resolve()
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation)
    tail = result.catch(() => {})
    return result
  }

  return {
    getState(): Promise<AppIconState> {
      return enqueue(async () => {
        if (!deps.supported) return { supported: false, name: 'default' }
        const name = deps.read()
        // Reconcile after an app update, or retry a previous native failure.
        await deps.apply(name)
        return { supported: true, name }
      })
    },
    setIcon(raw: unknown): Promise<AppIconState> {
      return enqueue(async () => {
        const name = parseAppIconName(raw)
        if (!deps.supported) throw new Error('App icons are unsupported on this host')
        const previous = deps.read()
        try {
          await deps.apply(name)
          deps.write(name)
        } catch (error) {
          await deps.apply(previous)
          throw error
        }
        return { supported: true, name }
      })
    }
  }
}
