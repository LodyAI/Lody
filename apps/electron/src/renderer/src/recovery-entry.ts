import { renderBootFailure } from '@lody/components/lib/boot-failure'
import { getIpcServices } from '@lody/components/lib/electron-ipc-client'

// Entry script for `recovery.html`. The main process loads this page after a
// renderer failure (did-fail-load, render-process-gone, preload-error). Error
// context arrives via the URL hash because the same BrowserWindow + preload
// is reused, so this page also has access to the `window.ipc` bridge.
const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Missing #root element on recovery page.')
}

const params = new URLSearchParams(window.location.hash.slice(1))
const message = params.get('message') ?? 'Lody could not load the main window.'
const details = params.get('details') ?? ''
const source = params.get('source') ?? 'unknown'

// Reconstruct an Error so the boot-failure UI shows a consistent layout. The
// full payload also lives on disk under app.getPath('logs')/renderer-fatal.log
// in case the URL hash had to be truncated.
const reconstructed = new Error(message)
if (details) {
  reconstructed.stack = `${message}\n${details}`
}

const buildInfo: Record<string, string> = {
  Runtime: 'electron:recovery',
  Source: source,
  Build: typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : 'unknown',
  BuildDate: typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : 'unknown'
}

renderBootFailure(rootElement, reconstructed, {
  buildInfo,
  surface: 'recovery',
  onReload: () => {
    if (getIpcServices()) {
      try {
        void getIpcServices()!.app.requestRendererReload()
        return
      } catch (error) {
        console.warn('[Lody] requestRendererReload bridge threw', error)
      }
    }
    window.location.reload()
  },
  onCopy: () => {
    try {
      void getIpcServices()?.app.reportRendererFatalError({
        scope: `recovery:${source}`,
        message,
        details,
        copied: true
      })
    } catch (error) {
      console.warn('[Lody] reportRendererFatalError bridge threw', error)
    }
  }
})
