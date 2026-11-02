import type { LoroRepo } from 'loro-repo';
import type { LoroDoc } from 'loro-crdt';
import type { CodeCollabDebugGlobal } from './lib/code-collab-global-debug';
import type { WorkspacePresenceDebugGlobal } from './providers/workspace-presence-transport';
import type { LodyLiveActivityBridge } from './hooks/use-lody-live-activity';
import type { LodyAppStoreReviewBridge } from './hooks/use-app-store-review-prompt';
import type { AppIconBridge } from './components/mobile/mobile-app-icon-settings';
import type { LodyStartupThemeBridge } from './theme-provider';
import type { LodyNativeResetBridge } from './lib/clear-local-cache';

/**
 * Boot guard installed by the inline script in a shell's index.html (currently
 * apps/mobile). It owns the boot watchdog and a last-resort fallback UI;
 * main.tsx upgrades `render` to the styled renderer and signals lifecycle via
 * markBooted()/fail().
 */
export interface LodyBootController {
  booted: boolean;
  render: ((root: HTMLElement | null, error: unknown) => void) | null;
  getFirstError: () => unknown;
  markBooted: () => void;
  fail: (error: unknown) => void;
}

declare global {
  interface Window {
    repo?: LoroRepo;
    currentSessionDoc?: LoroDoc;
    currentCodeCollab?: CodeCollabDebugGlobal;
    lodyPresence?: WorkspacePresenceDebugGlobal;
    __LODY_NATIVE__?: boolean;
    __LODY_CORDOVA_READY__?: boolean;
    __LODY_ELECTRON__?: true;
    __LODY_PLATFORM__?: {
      os: string;
      osVersion?: string;
      architecture?: string;
      electronVersion?: string;
      chromiumVersion?: string;
      homeDir: string;
      machineName?: string;
      preferredSystemLanguages?: readonly string[];
    };
    __LODY_BOOT__?: LodyBootController;
    __LODY_LIVE_ACTIVITY__?: LodyLiveActivityBridge;
    __LODY_APP_STORE_REVIEW__?: LodyAppStoreReviewBridge;
    __LODY_APP_ICON__?: AppIconBridge;
    __LODY_STARTUP_THEME__?: LodyStartupThemeBridge;
    __LODY_NATIVE_RESET__?: LodyNativeResetBridge;
    __LODY_APP_INFO__?: {
      version?: string;
      build?: string;
      native_platform?: string;
      os_name?: string;
      os_version?: string;
      manufacturer?: string;
      model?: string;
      android_sdk_version?: number;
      webview_version?: string;
      is_virtual?: boolean;
      app_version?: string;
      install_id?: string;
    };
    authenticate?: (options: { token: string }) => Promise<unknown>;
    /** Electron preload sets this only when main registered the E2E client-loss probe. */
    __LODY_E2E_CLIENT_LOSS__?: true;
    ipc?: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (channel: string, listener: (payload: unknown) => void) => () => void;
      send: (channel: string, payload?: unknown) => void;
    };
  }
}

export type WindowGlobals = {
  repo?: LoroRepo;
  currentSessionDoc?: LoroDoc;
  currentCodeCollab?: CodeCollabDebugGlobal;
  lodyPresence?: WorkspacePresenceDebugGlobal;
  __LODY_NATIVE__?: boolean;
  __LODY_CORDOVA_READY__?: boolean;
  __LODY_LIVE_ACTIVITY__?: LodyLiveActivityBridge;
};
