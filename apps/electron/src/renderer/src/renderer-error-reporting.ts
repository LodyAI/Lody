export type RendererFatalScope =
  'boot:synchronous' | 'react:caught' | 'react:uncaught' | 'window.error' | 'unhandledrejection'

type ErrorEventLike = {
  error?: unknown
  message?: unknown
}

type PromiseRejectionEventLike = {
  reason?: unknown
}

type RendererErrorReportingOptions = {
  hasCommitted: () => boolean
  reportFatal: (error: Error, scope: RendererFatalScope) => void
  showBootFailure: (error: Error, scope: RendererFatalScope) => void
  schedule?: (callback: () => void) => void
}

function normalizeError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  if (value === undefined || value === null) return new Error(fallbackMessage)
  return new Error(String(value))
}

/**
 * Routes every renderer-fatal surface through one deterministic policy.
 *
 * React 19 no longer rethrows render errors, so createRoot callbacks and the
 * browser global events can observe the same Error. The WeakSet keeps the IPC
 * log single-owner without suppressing a later, distinct failure. Dispatch is
 * deferred by one microtask so an ErrorBoundary fallback can commit the root
 * sentinel before a caught initial render is classified as a boot failure.
 */
export function createRendererErrorReporting(options: RendererErrorReportingOptions) {
  const reportedErrors = new WeakSet<object>()
  const schedule = options.schedule ?? queueMicrotask

  const route = (value: unknown, scope: RendererFatalScope, fallbackMessage: string): void => {
    const error = normalizeError(value, fallbackMessage)
    if (reportedErrors.has(error)) return
    reportedErrors.add(error)

    schedule(() => {
      if (options.hasCommitted()) {
        options.reportFatal(error, scope)
        return
      }
      options.showBootFailure(error, scope)
    })
  }

  return {
    reportSynchronousError(error: unknown): void {
      route(error, 'boot:synchronous', 'Synchronous renderer boot failure')
    },
    onReactCaughtError(error: unknown): void {
      route(error, 'react:caught', 'Caught React render error')
    },
    onReactUncaughtError(error: unknown): void {
      route(error, 'react:uncaught', 'Uncaught React render error')
    },
    onWindowError(event: ErrorEventLike): void {
      const value = event.error ?? event.message
      route(value, 'window.error', 'Unknown window error')
    },
    onUnhandledRejection(event: PromiseRejectionEventLike): void {
      route(event.reason, 'unhandledrejection', 'Unhandled promise rejection')
    }
  }
}
