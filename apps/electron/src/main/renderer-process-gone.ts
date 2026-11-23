export type RendererProcessGoneDetails = {
  reason: string
  exitCode: number
}

export type RendererCrashReport = {
  error: Error
  component: 'electron-renderer'
  extra: {
    source: 'render-process-gone'
    renderer_crash_reason: string
    renderer_exit_code: number
  }
}

export type RendererCrashRecovery = {
  message: string
  details: string
  source: 'render-process-gone'
}

/**
 * Classify a terminated Chromium renderer without asking Electron to reload it.
 *
 * The caller sends the report from Electron main, which survives the renderer,
 * then replaces the crashed surface with the copyable recovery page. Reloading
 * the product renderer remains an explicit user action on that page.
 */
export function createRendererProcessGoneHandling(
  details: RendererProcessGoneDetails
): { report: RendererCrashReport; recovery: RendererCrashRecovery } | null {
  // Electron emits this during ordinary window teardown. It is not a crash and
  // must neither open recovery nor create a telemetry event.
  if (details.reason === 'clean-exit') return null

  return {
    report: {
      error: new Error('The Lody renderer process exited unexpectedly.'),
      component: 'electron-renderer',
      extra: {
        source: 'render-process-gone',
        renderer_crash_reason: details.reason,
        renderer_exit_code: details.exitCode
      }
    },
    recovery: {
      message: 'The Lody window crashed.',
      details: `Reason: ${details.reason}\nExit code: ${details.exitCode}`,
      source: 'render-process-gone'
    }
  }
}
