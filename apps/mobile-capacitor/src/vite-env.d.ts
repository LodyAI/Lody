/// <reference types="vite/client" />

// Build-time constants injected by vite.config.ts
declare const __BUILD_DATE__: string;
declare const __GIT_COMMIT__: string;
// Not injected in the mobile build (Capacitor provides the native version);
// declared so shared components typecheck. Guard reads with `typeof`.
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SERVER_URL: string;
  /** Product site URL; recovery files carry its canonical origin (default Lody Cloud). */
  readonly VITE_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
