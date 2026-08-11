import React, { useEffect, useState } from 'react';
import i18next from 'i18next';
import { syncTime, createServerTimeFetcher } from '@lody/shared';
import { usePlatformCapability } from '@lody/platform/react';
import { API_BASE_URL } from '../lib';
import { commands, registerBuiltInCommands } from '../lib/commands';
import { rehydrateAvatarMemoryCacheFromPersistent } from '../lib/avatar-cache';
import { languageAtom } from '../atoms/settings';
import { maybeClearLodyCacheOnBoot } from '../lib/clear-local-cache';
import { useSetAtom } from 'jotai';
import {
  detectBrowserLanguage,
  fallbackLanguage,
  initI18n,
  readStoredLanguagePreference,
} from '../i18n';

const AppInitializer = ({ children }: { children: React.ReactNode }) => {
  const setLanguage = useSetAtom(languageAtom);
  const hasCloudSync = usePlatformCapability('cloudSync');

  // Register the built-in / placeholder commands during the FIRST render — deliberately
  // not in an effect. Passive effects fire child-first, so an effect here would run AFTER
  // a synchronously-mounted command host. That host's real `session.focusInput` would
  // register first, then the built-in placeholder (`when: () => false`) would push on
  // top by id and mask it — ⌘L silently dead until remount. Registering in render
  // guarantees the placeholders land first, matching the
  // per-id stack invariant in lib/commands/AGENTS.md. `registerBuiltInCommands` is
  // idempotent and the platform helpers return safe defaults without `window`, so this is
  // safe to call once during render.
  useState(() => {
    registerBuiltInCommands();
  });

  useEffect(() => {
    const stored = readStoredLanguagePreference();
    const detected = stored ?? detectBrowserLanguage();
    const preferredLanguage = detected ?? fallbackLanguage;
    if (!stored && detected) {
      // Persist the detected choice so languageAtom (which defaults to 'en' until
      // a user picks via Settings) stays in sync with the active i18n language.
      // Rejected: leaving detection ephemeral. The settings selector reads from
      // languageAtom; without persisting it would show English while the UI is
      // in Chinese for first-time visitors.
      setLanguage(detected);
    }
    void initI18n(preferredLanguage).catch((error: unknown) => {
      console.error('AppInitializer: failed to initialize i18n', error);
    });
  }, [setLanguage]);

  /* Run a pending "clear cache" / "clear all local data" request as early as
     possible. `RuntimeProvider` also awaits it (and shares the same one-shot
     promise, so the repo IndexedDB is never reopened mid-delete), but it only
     mounts once a workspace id exists. A user wedged before that — stuck on
     sign-in, which is exactly when the crash screen's hard reset gets used —
     would otherwise carry the pending flag forever. */
  useEffect(() => {
    void maybeClearLodyCacheOnBoot();
  }, []);

  useEffect(() => {
    const syncLanguage = (language: string) => {
      window.api?.setLanguage?.(language);
    };

    if (typeof window === 'undefined' || !window.__LODY_ELECTRON__) return undefined;

    syncLanguage(i18next.resolvedLanguage ?? i18next.language ?? fallbackLanguage);
    i18next.on('languageChanged', syncLanguage);

    return () => {
      i18next.off('languageChanged', syncLanguage);
    };
  }, []);

  // Server time calibration belongs to the cloud synchronization plane. The
  // account-free local platform has no time server (and no cross-device clock
  // to align), so it must not manufacture a relative `file:///api/time`
  // request in Electron. Capability ownership keeps this independent of build
  // kind while preserving the local-clock behavior of getServerNow().
  useEffect(() => {
    if (!hasCloudSync) {
      return;
    }
    syncTime(createServerTimeFetcher(`${API_BASE_URL}/api/time`)).catch(() => {
      // Silently ignore time sync failures - operations will use local time
    });
  }, [hasCloudSync]);

  // Attach the global command registry's capture-phase keydown listener once at app boot.
  // (Built-in commands are registered during render above — before any descendant effect —
  // not here.) Attaching after registration is fine: the listener reads bindings live.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    commands.attach(window);
    // No detach on unmount — AppInitializer is the app root and we want the listener
    // to live as long as the renderer process.
    return undefined;
  }, []);

  /* Pre-warm the in-memory avatar blob-URL map from the persistent
     CacheStorage so the first `<UserAvatar>` mount after a refresh
     can hit the cache synchronously. Without this, every fresh app
     load shows the initials fallback briefly while the persisted
     blob is rehydrated lazily — that's the "blank then load"
     flicker users see on GitHub avatars. Fire-and-forget; if it
     fails, callers fall back to the raw URL path. */
  useEffect(() => {
    void rehydrateAvatarMemoryCacheFromPersistent();
  }, []);

  return <>{children}</>;
};

export default AppInitializer;
