import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashHistory, RouterProvider } from '@tanstack/react-router'
import { createRouter } from '@lody/components/router'
import '@lody/components/tailwind/index.css'
import { jotaiStore } from '@lody/components/lib'
import { collectBootDiagnostics, renderBootFailure } from '@lody/components/lib/boot-failure'
import { installResizeObserverLoopErrorHandler } from '@lody/components/lib/resize-observer'
import { Provider } from 'jotai'

import { ErrorBoundary } from '@/components/error-boundary'
import { authClient, completeElectronAuthCallback, isElectronAuthCallbackActive } from './auth'
import { installNativeTabBehavior } from './native-tab-behavior'
import { createRendererErrorReporting, type RendererFatalScope } from './renderer-error-reporting'

// Desktop windows should not Tab-cycle a focus ring through the whole UI like a web page.
installNativeTabBehavior()
installResizeObserverLoopErrorHandler()

const rootElement = document.getElementById('root')
if (!rootElement) {
  // Without #root we have no place to render anything; just throw so the
  // main-process diagnostics catch it via did-finish-load + DevTools.
  throw new Error('Missing #root element.')
}

// Track whether React has committed at least once. Pre-mount fatal errors
// take over the UI (otherwise the window is just a permanent white screen);
// post-mount errors are forwarded to the main process for logging but the
// running UI is left intact so the user doesn't lose state.
let rendererMounted = false
let bootFailureShown = false

const buildInfo: Record<string, string> = {
  Runtime: 'electron',
  Build: typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : 'unknown',
  BuildDate: typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : 'unknown',
  Platform:
    typeof window.__LODY_PLATFORM__?.os === 'string' ? window.__LODY_PLATFORM__.os : 'unknown'
}

function reportFatalToMain(error: unknown, scope: RendererFatalScope, copied = false): void {
  try {
    const diag = collectBootDiagnostics(error, { buildInfo })
    window.api?.reportRendererFatalError?.({
      scope,
      message: diag.message,
      details: diag.details,
      copied
    })
  } catch (e) {
    console.warn('[Lody] Failed to forward fatal error to main', e)
  }
}

function requestReloadViaMain(): boolean {
  try {
    const reloader = window.api?.requestRendererReload
    if (typeof reloader === 'function') {
      void reloader()
      return true
    }
  } catch (e) {
    console.warn('[Lody] requestRendererReload bridge threw', e)
  }
  return false
}

function showBootFailure(error: unknown, scope: RendererFatalScope): void {
  if (bootFailureShown) return
  bootFailureShown = true
  reportFatalToMain(error, scope)
  renderBootFailure(rootElement!, error, {
    buildInfo,
    hint: 'If this keeps happening after a Reload, click "Copy error" and share it with the Lody team.',
    onReload: () => {
      if (!requestReloadViaMain()) {
        window.location.reload()
      }
    },
    onCopy: () => reportFatalToMain(error, scope, true)
  })
}

function markRendererCommitted(): void {
  if (rendererMounted) return
  rendererMounted = true
  try {
    window.api?.notifyRendererMounted?.()
  } catch (e) {
    console.warn('[Lody] notifyRendererMounted bridge failed', e)
  }
}

function RendererCommitSentinel(): null {
  useLayoutEffect(() => {
    markRendererCommitted()
  }, [])
  return null
}

const rendererErrorReporting = createRendererErrorReporting({
  hasCommitted: () => rendererMounted,
  reportFatal: reportFatalToMain,
  showBootFailure
})

// Register global handlers BEFORE touching any module that can fail at top
// level (createRouter, authClient init, etc.). They cover three cases:
//   1. Synchronous throws that escape the try/catch (rare).
//   2. Async rejections from boot paths (route loaders, async imports).
//   3. Post-mount asynchronous errors — those only get reported to main
//      for log persistence; the running UI is left alone.
window.addEventListener('error', (event) => {
  rendererErrorReporting.onWindowError(event)
})

window.addEventListener('unhandledrejection', (event) => {
  rendererErrorReporting.onUnhandledRejection(event)
})

try {
  const isFileProtocol = window.location.protocol === 'file:'
  const router = createRouter({
    authClient,
    desktopAuth: {
      completeCallback: completeElectronAuthCallback,
      isCallbackActive: isElectronAuthCallbackActive
    },
    history: isFileProtocol ? createHashHistory() : undefined
  })
  createRoot(rootElement, {
    // ErrorBoundary remains the single owner of caught-error UI and PostHog.
    // React 19 no longer rethrows render errors, so these root callbacks only
    // restore the Electron fatal IPC path that window.error used to observe.
    onCaughtError: (error) => rendererErrorReporting.onReactCaughtError(error),
    onUncaughtError: (error) => rendererErrorReporting.onReactUncaughtError(error)
  }).render(
    <>
      <RendererCommitSentinel />
      <ErrorBoundary name="AppRoot" variant="page" showErrorDetails>
        <Provider store={jotaiStore}>
          <RouterProvider router={router} />
        </Provider>
      </ErrorBoundary>
    </>
  )
} catch (error) {
  rendererErrorReporting.reportSynchronousError(error)
}
