/// <reference types="vite/client" />

// Build-time constants injected by vite.config.ts
declare const __BUILD_DATE__: string;
declare const __GIT_COMMIT__: string;
// Linked Lody client version (cli/electron/mobile share one version). Injected
// by the web/electron-renderer builds; left undefined in the mobile build,
// which reads the authoritative native version from Capacitor instead — always
// guard reads with `typeof __APP_VERSION__ !== 'undefined'`.
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SERVER_URL: string;
  readonly VITE_LORO_STREAMS_BASE_URL?: string;
  readonly VITE_SITE_URL?: string;
  readonly VITE_CONVEX_DEPLOY_URL?: string;
  readonly VITE_CONVEX_SITE_URL: string;
  readonly VITE_ONESIGNAL_APP_ID: string;
  readonly VITE_ONESIGNAL_SAFARI_WEB_ID: string;
  /**
   * Escape hatch that pins the Machine RPC response live transport. Unset (the
   * normal build) uses the SSE-first policy with its long-poll fallback.
   */
  readonly VITE_LORO_STREAMS_RPC_LIVE_MODE?: 'sse' | 'long-poll';
  readonly VITE_PUBLIC_POSTHOG_HOST?: string;
  readonly VITE_PUBLIC_POSTHOG_KEY?: string;
  /**
   * Build-time platform selection (specs/platform-providers.md): `local` for
   * the open-source build, `cloud`/unset for the official build. Read once via
   * `src/lib/app-platform.ts`.
   */
  readonly VITE_LODY_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  OneSignal?: unknown;
  OneSignalDeferred?: Array<(OneSignal: unknown) => void>;
}
