import {
  isSessionWindow,
  isWarmWindow,
  clearWarmWindowFlag
} from '@lody/components/lib/desktop-window'
import { useLayoutEffect, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashHistory, RouterProvider } from '@tanstack/react-router'
import { createRouter } from '@lody/components/router'
import {
  detectBrowserLanguage,
  fallbackLanguage,
  initI18n,
  readStoredLanguagePreference
} from '@lody/components/i18n'
import { languageAtom } from '@lody/components/atoms/settings'
import { sidebarCollapsedAtom } from '@lody/components/atoms/sidebar-state'
import '@lody/components/tailwind/index.css'
import { jotaiStore } from '@lody/components/lib'
import { collectBootDiagnostics, renderBootFailure } from '@lody/components/lib/boot-failure'
import { installResizeObserverLoopErrorHandler } from '@lody/components/lib/resize-observer'
import { getIpcServices, onIpcEvent, sendIpc } from '@lody/components/lib/electron-ipc-client'
import { Provider } from 'jotai'

import { ErrorBoundary } from '@/components/error-boundary'
import { authClient } from './auth'
import { installNativeTabBehavior } from './native-tab-behavior'
import { createRendererErrorReporting, type RendererFatalScope } from './renderer-error-reporting'
import { DesktopDevbar } from './devbar/index'

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
    void getIpcServices()?.app.reportRendererFatalError({
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
    if (getIpcServices()) {
      void getIpcServices()!.app.requestRendererReload()
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
    void getIpcServices()?.app.notifyRendererMounted()
  } catch (e) {
    console.warn('[Lody] notifyRendererMounted bridge failed', e)
  }
}

function RendererCommitSentinel(): null {
  useLayoutEffect(() => {
    markRendererCommitted()
    if (isWarmWindow()) {
      // A hidden window can miss animation frames, so signal through a timer.
      // The spare only needs its committed shell before main can claim it.
      const timer = window.setTimeout(() => sendIpc('app.windowReady', null), 0)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [])
  return null
}

/**
 * A warm renderer must never expose its router's transition state. The router
 * can briefly have no mounted route while it binds the claimed target, so keep
 * an opaque, theme-matched surface above it until the target has painted.
 *
 * This is deliberately text-free: showing a spinner makes an auxiliary window
 * feel like a second loading screen instead of a native window reveal.
 */
function WarmWindowSurface(): ReactElement | null {
  const [visible, setVisible] = useState(() => isWarmWindow())
  useLayoutEffect(() => {
    const onTargetPainted = () => setVisible(false)
    window.addEventListener('lody:warm-window-target-painted', onTargetPainted)
    return () => window.removeEventListener('lody:warm-window-target-painted', onTargetPainted)
  }, [])
  if (!visible) return null
  return (
    <div
      id="lody-warm-window-surface"
      aria-hidden="true"
      data-warm-window-surface="visible"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        backgroundColor: 'hsl(var(--background))',
        pointerEvents: 'none',
        isolation: 'isolate'
      }}
    />
  )
}

function waitForTargetContentPainted(onTargetPainted: () => void): void {
  let stableFrames = 0
  const startedAt = performance.now()
  const check = () => {
    // `innerText` intentionally excludes route shells that are still hidden by
    // Suspense/CSS. `textContent` becomes non-empty too early and would bring
    // the exact blank-frame regression back under a slower renderer.
    const hasContent = Boolean(rootElement?.innerText?.trim())
    stableFrames = hasContent ? stableFrames + 1 : 0
    // The first non-empty commit can still be followed by a layout pass that
    // replaces the route shell. Require two consecutive frames so the opaque
    // surface is removed only after a real target frame is on screen.
    if (stableFrames >= 2 || performance.now() - startedAt >= 5000) {
      onTargetPainted()
      return
    }
    requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}

/**
 * Binds a claimed warm window to a concrete route without a reload. The renderer
 * is already booted; this reproduces the storage flags a fresh auxiliary window
 * would derive from its URL, then navigates client-side.
 */
function installWarmWindowBinding(
  router: ReturnType<typeof createRouter>,
  onTargetPainted: () => void
): void {
  onIpcEvent('app.windowTarget', (target) => {
    sessionStorage.setItem('lody:auxiliaryWindow', '1')
    sessionStorage.removeItem('lody:windowFocusConsumed')
    if (target.sessionId) {
      sessionStorage.setItem('lody:sessionWindow', '1')
    }
    jotaiStore.set(sidebarCollapsedAtom, Boolean(target.sessionId))

    const navigation = target.sessionId
      ? router.navigate({
          to: '/$workspaceName/sessions/$sessionId',
          params: { workspaceName: target.workspace, sessionId: target.sessionId },
          search: { tab: `session:${target.sessionId}` },
          state: { focusComposerSessionId: target.sessionId }
        })
      : router.navigate({
          to: '/$workspaceName/chat',
          params: { workspaceName: target.workspace }
        })
    // Keep the opaque warm shell until the target route has committed and had
    // two animation frames to paint. This covers both the router transition
    // and the first layout/paint of the workspace surface.
    void navigation.finally(() => {
      clearWarmWindowFlag()
      waitForTargetContentPainted(onTargetPainted)
    })
  })
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
  // Resolve and persist the desktop's first-run language before React can
  // commit. AppInitializer keeps later changes synchronized; awaiting here
  // closes the window where onboarding could paint once in English first.
  const storedLanguage = readStoredLanguagePreference()
  const detectedLanguage = storedLanguage ?? detectBrowserLanguage()
  const bootLanguage = detectedLanguage ?? fallbackLanguage
  await initI18n(bootLanguage)
  if (!storedLanguage && detectedLanguage) {
    jotaiStore.set(languageAtom, detectedLanguage)
  }

  const usesHashHistory =
    window.location.protocol === 'file:' || window.location.pathname.endsWith('/devbar.html')
  const devbar = await getIpcServices()
    ?.app.getDevbarConfig()
    .catch(() => null)
  if (devbar?.enabled) document.documentElement.setAttribute('data-desktop-devbar', '')
  const router = createRouter({
    authClient,
    history: usesHashHistory ? createHashHistory() : undefined
  })
  installWarmWindowBinding(router, () =>
    window.dispatchEvent(new Event('lody:warm-window-target-painted'))
  )
  if (isSessionWindow() && !sessionStorage.getItem('lody:windowFocusConsumed')) {
    const sessionId = router.history.location.pathname.split('/sessions/')[1]?.split('/')[0]
    if (sessionId) {
      router.history.replace(router.history.location.href, {
        ...router.history.location.state,
        focusComposerSessionId: sessionId
      })
      sessionStorage.setItem('lody:windowFocusConsumed', '1')
    }
  }
  createRoot(rootElement, {
    // ErrorBoundary remains the single owner of caught-error UI and PostHog.
    // React 19 no longer rethrows render errors, so these root callbacks only
    // restore the Electron fatal IPC path that window.error used to observe.
    onCaughtError: (error) => rendererErrorReporting.onReactCaughtError(error),
    onUncaughtError: (error) => rendererErrorReporting.onReactUncaughtError(error)
  }).render(
    <>
      <RendererCommitSentinel />
      <WarmWindowSurface />
      <ErrorBoundary name="AppRoot" variant="page" showErrorDetails>
        <Provider store={jotaiStore}>
          <RouterProvider router={router} />
        </Provider>
      </ErrorBoundary>
      {devbar?.enabled && (
        // A diagnostics footer must never take the app down with it: a crash
        // here degrades to no bar, not to the fatal renderer path.
        <ErrorBoundary name="DesktopDevbar" fallbackRender={() => null}>
          <DesktopDevbar />
        </ErrorBoundary>
      )}
    </>
  )
} catch (error) {
  rendererErrorReporting.reportSynchronousError(error)
}
