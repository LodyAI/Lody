import { initPushBridge } from './push-notifications';
import './polyfills';
import { Effect } from 'effect';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { createRouter } from '@lody/components/router';
import '@lody/components/tailwind/index.css';
import { jotaiStore } from '@lody/components/lib';
import {
  detectBrowserLanguage,
  fallbackLanguage,
  initI18n,
  readStoredLanguagePreference,
} from '@lody/components/i18n';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@lody/components/atoms/settings';
import { Provider } from 'jotai';
import { isNativePlatform } from 'better-auth-capacitor/client';

import { initNativeKeyboard } from './native-keyboard';
import { initE2eePairLinks } from './e2ee-pair-link';
import { initAppStoreReviewBridge } from './app-store-review';
import { initAppIconBridge } from './app-icon';
import { initLiveActivityBridge } from './live-activity';
import { initNativeClipboardBridge } from './native-clipboard';
import { initHomeWidgetSync } from './home-widget';
import { initTokenUsageWidget } from './token-usage-widget';
import { initProviderQuotaWidget } from './provider-quota-widget';
import { hideNativeSplash, initNativeSplashHandoff, initStartupThemeBridge } from './startup-theme';
import { initResumeRecovery } from './resume-recovery';
import { cacheAppInfoForDiagnostics, showMobileBootFailure } from './boot-failure-mobile';
import { ErrorBoundary } from '@/components/error-boundary';
import { authClient } from './auth';
import { convexClient } from '@lody/components/providers/convex-provider';
import { mobilePersonalHost } from './e2ee/mobile-host';
import { Capacitor } from '@capacitor/core';
import type { E2eeRuntimeFactory, E2eeWorkspaceRuntime } from '@lody/platform';
import { Device } from '@capacitor/device';
import { nativePasskeyPort } from './e2ee/passkey-bridge';
import { MobileRecoveryContext, type MobileRecoveryConfig } from './recovery/recovery-context';
import { MobileRecoveryHostProvider } from './recovery/recovery-host';

// Upgrade the inline boot guard (index.html) to the styled fallback. The guard
// owns the watchdog + a last-resort UI for the case where this module never
// finishes evaluating (failed dynamic import / WASM init) — a case a
// module-level handler can't catch because it would never run. Here we just
// register the richer renderer and report the failures we can see synchronously.
const bootGuard = typeof window !== 'undefined' ? window.__LODY_BOOT__ : undefined;
if (bootGuard) {
  bootGuard.render = (root, error) => {
    if (root) showMobileBootFailure(root, error);
    // The failure UI sits under the native splash, which is held up until the
    // theme lands (`startup-theme.ts`); on a failed boot that never happens.
    if (window.__LODY_NATIVE__) hideNativeSplash();
  };
}

function reportBootFailure(error: unknown): void {
  // Boot happens before the PostHog provider mounts, so a synchronous boot
  // failure here cannot be auto-captured; the boot guard still renders the
  // failure UI. Post-boot crashes are captured by PostHog error tracking
  // (capture_exceptions + ErrorBoundary → posthog.captureException).
  if (bootGuard) {
    bootGuard.fail(error);
    return;
  }
  // No inline guard present (unexpected host / test env): render directly.
  const root = document.getElementById('root');
  if (root) showMobileBootFailure(root, error);
}

try {
  const baseUrl = import.meta.env.BASE_URL || '/';
  const basepath = baseUrl === '/' || baseUrl === './' ? '' : baseUrl.replace(/\/$/, '');
  window.__LODY_NATIVE__ = isNativePlatform();
  if (window.__LODY_NATIVE__) {
    window.__LODY_CORDOVA_READY__ = false;
    document.addEventListener(
      'deviceready',
      () => {
        window.__LODY_CORDOVA_READY__ = true;
      },
      { once: true }
    );
  }
  const encryptedHost = window.__LODY_NATIVE__
    ? mobilePersonalHost(convexClient, Effect.runPromise)
    : undefined;
  // Workspace recovery borrows the same owner the router uses; never a second host.
  let recoveryRuntime: E2eeWorkspaceRuntime | undefined;
  const createE2eeRuntime: E2eeRuntimeFactory | undefined = encryptedHost
    ? (input) => {
        const runtime = encryptedHost.createRuntime(input);
        if (runtime) recoveryRuntime = runtime;
        return runtime;
      }
    : undefined;
  const recovery: MobileRecoveryConfig | null = window.__LODY_NATIVE__
    ? {
        enabled: () => jotaiStore.get(e2eeRecoveryVaultFeatureEnabledAtom),
        client: convexClient,
        run: Effect.runPromise,
        passkey: nativePasskeyPort({ enabled: Capacitor.getPlatform() === 'ios' }),
        defaultLabel: async () => {
          const info = await Device.getInfo();
          const android = info.platform === 'android';
          const device = android
            ? info.model.trim() || 'Android'
            : info.model.startsWith('iPad')
              ? 'iPad'
              : 'iPhone';
          return /^\d+(?:\.\d+){0,3}$/.test(info.osVersion)
            ? `${device} · ${android ? 'Android' : 'iOS'} ${info.osVersion}`
            : device;
        },
        runtime: () => recoveryRuntime,
      }
    : null;
  const router = createRouter({
    basepath,
    authClient,
    createE2eeRuntime,
    prepareE2eeCreation: encryptedHost?.prepareCreation,
  });
  if (encryptedHost) {
    const retire = () => {
      // The owner retains incomplete-close failures until native work settles.
      void encryptedHost.close().catch(() => {
        console.debug('Encrypted mobile host shutdown remains pending');
      });
    };
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) retire();
    });
    import.meta.hot?.dispose(retire);
  }
  if (window.__LODY_NATIVE__) {
    initPushBridge();
    const stopPairLinks = initE2eePairLinks();
    import.meta.hot?.dispose(() => {
      void stopPairLinks().catch(() => {});
    });
    initNativeKeyboard();
    initAppIconBridge();
    initAppStoreReviewBridge();
    initLiveActivityBridge();
    initNativeClipboardBridge();
    const stopHomeWidgetSync = initHomeWidgetSync(authClient);
    const stopTokenWidget = initTokenUsageWidget(router);
    const stopQuotaWidget = initProviderQuotaWidget();
    import.meta.hot?.dispose(() => {
      void stopHomeWidgetSync().catch((error: unknown) => {
        console.error('Failed to dispose Home Screen widget sync', error);
      });
      void stopTokenWidget().catch((error: unknown) => {
        console.error('Failed to dispose Token usage widget sync', error);
      });
      void stopQuotaWidget().catch((error: unknown) => {
        console.error('Failed to dispose subscription quota widget sync', error);
      });
    });
    initStartupThemeBridge();
    initNativeSplashHandoff();
    initResumeRecovery();
    void cacheAppInfoForDiagnostics();
  }

  await initI18n(readStoredLanguagePreference() ?? detectBrowserLanguage() ?? fallbackLanguage);

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Missing #root element.');
  }

  createRoot(rootElement).render(
    <ErrorBoundary name="AppRoot" variant="page" showErrorDetails>
      <Provider store={jotaiStore}>
        <MobileRecoveryContext.Provider value={recovery}>
          <MobileRecoveryHostProvider>
            <RouterProvider router={router} />
          </MobileRecoveryHostProvider>
        </MobileRecoveryContext.Provider>
      </Provider>
    </ErrorBoundary>
  );

  // The boot path completed: React committed either the app or its
  // error-boundary fallback — either way the screen isn't blank — so cancel the
  // inline watchdog.
  bootGuard?.markBooted();
} catch (error) {
  reportBootFailure(error);
}
