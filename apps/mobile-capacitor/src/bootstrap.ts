import './polyfills';
import { installClientLog } from '@lody/components/lib/client-log';
import { Capacitor, registerPlugin } from '@capacitor/core';

const stopClientDiagnostics = installClientLog();
import.meta.hot?.dispose(stopClientDiagnostics);

// This tiny entry must complete recovery before importing any app/auth/storage
// owners. The inline guard remains available if any import below fails.
try {
  if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LodyNativeReset')) {
    const reset = registerPlugin<{
      getResetResult(): Promise<{
        outcome: 'none' | 'success' | 'fallback';
        credentialCleanupFailed?: boolean;
      }>;
      acknowledgeResetResult(options: {
        outcome: 'success' | 'fallback';
      }): Promise<{ custodyCleanupFailed?: boolean } | undefined>;
    }>('LodyNativeReset');
    const { outcome, credentialCleanupFailed } = await reset.getResetResult();
    if (outcome !== 'none') {
      // Retain recovery diagnostics in memory even if the web wipe below throws.
      // The native document-start script also exposes the last native outcome
      // when this module cannot load at all. Neither value contains credentials.
      window.__LODY_APP_INFO__ = Object.assign({}, window.__LODY_APP_INFO__, {
        last_native_reset_outcome: outcome,
        native_reset_credential_cleanup_failed: credentialCleanupFailed === true,
      });
    }
    if (outcome !== 'none') {
      // SessionStorage belongs to the browsing context and can survive a
      // document replacement. Clear it on the original app origin before boot.
      window.sessionStorage.clear();
    }
    if (outcome === 'fallback') {
      const { clearAllLodyLocalData } = await import('@lody/components/lib/clear-local-cache');
      await clearAllLodyLocalData();
    }
    if (outcome !== 'none') {
      const acknowledged = await reset.acknowledgeResetResult({ outcome });
      window.__LODY_APP_INFO__ = Object.assign({}, window.__LODY_APP_INFO__, {
        native_reset_custody_cleanup_failed: acknowledged?.custodyCleanupFailed === true,
      });
    }
  }
  await import('./main');
} catch (error) {
  window.__LODY_BOOT__?.fail(error);
}
