import { Device } from '@capacitor/device';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import {
  renderBootFailure,
  resolveBootFailureLanguage,
  usageSharingAllowed,
  type BootFailureKind,
} from '@lody/components/lib/boot-failure';
import type { SupportedLanguage } from '@lody/shared/language';
import { updateNativeAppInfo } from '@lody/components/lib/native-app-info';

type CachedAppInfo = {
  version?: string;
  build?: string;
  last_native_reset_outcome?: 'success' | 'fallback';
  native_reset_credential_cleanup_failed?: boolean;
  native_reset_custody_cleanup_failed?: boolean;
};

// Spec §8f.2 mobile failure_kind taxonomy: chunk_load / offline / unknown.
type MobileBootFailureKind = 'chunk_load' | 'offline' | 'unknown';

function getCachedAppInfo(): CachedAppInfo {
  if (typeof window === 'undefined') return {};
  return window.__LODY_APP_INFO__ ?? {};
}

/**
 * Fetch the native app version/build once at boot and stash it on the window so
 * the (synchronous) boot-failure renderer can include it in diagnostics without
 * an async hop. No-ops on web, where `App.getInfo()` is unavailable.
 */
export async function cacheAppInfoForDiagnostics(): Promise<void> {
  if (typeof window === 'undefined') return;
  const nativePlatform = Capacitor.getPlatform();
  updateNativeAppInfo({ native_platform: nativePlatform });
  void Device.getInfo()
    .then((info) =>
      updateNativeAppInfo({
        os_name: info.operatingSystem,
        os_version: info.osVersion,
        manufacturer: info.manufacturer,
        model: info.model,
        android_sdk_version: info.androidSDKVersion,
        webview_version: info.webViewVersion,
        is_virtual: info.isVirtual,
      })
    )
    .catch(() => {});
  try {
    const info = await CapacitorApp.getInfo();
    updateNativeAppInfo({
      version: info.version,
      build: info.build,
      native_platform: nativePlatform,
    });
  } catch {
    // getInfo() rejects on the web platform; diagnostics simply omit version.
  }
}

function getMobileBuildInfo(): Record<string, string> {
  const info: Record<string, string> = {};
  const isNative = typeof window !== 'undefined' && window.__LODY_NATIVE__ === true;
  info.Runtime = isNative ? 'native' : 'web';
  try {
    info.Platform = Capacitor.getPlatform();
  } catch {
    // Capacitor unavailable (e.g. plain browser preview); skip platform.
  }
  info.Mode = import.meta.env.MODE;
  const app = getCachedAppInfo();
  if (app.version) info['App version'] = app.version;
  if (app.build) info['App build'] = app.build;
  if (app.last_native_reset_outcome) info['Last native reset'] = app.last_native_reset_outcome;
  if (app.native_reset_credential_cleanup_failed) info['Native credential cleanup'] = 'failed';
  if (app.native_reset_custody_cleanup_failed) info['Native key cleanup'] = 'failed';
  return info;
}

/**
 * Classify a mobile boot failure into the spec §8f.2 taxonomy
 * (chunk_load / offline / unknown). Message-pattern based because at boot time
 * we only have the raw throw — but we never SEND the message, only the enum.
 */
export function classifyMobileBootFailureKind(error: unknown): MobileBootFailureKind {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'offline';
  }
  const message = (
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '')
  ).toLowerCase();
  if (
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('importing a module script failed') ||
    message.includes('error loading') ||
    message.includes('chunkloaderror') ||
    message.includes('failed to fetch')
  ) {
    return 'chunk_load';
  }
  return 'unknown';
}

function toSharedBootFailureKind(kind: MobileBootFailureKind): BootFailureKind {
  if (kind === 'chunk_load') return 'module_load';
  if (kind === 'offline') return 'offline';
  return 'unknown';
}

function postMobileBootFailedBeacon(): void {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
    const key = env.VITE_PUBLIC_POSTHOG_KEY;
    if (!usageSharingAllowed() || env.VITE_LODY_PLATFORM !== 'cloud' || !key) return;
    const host = env.VITE_PUBLIC_POSTHOG_HOST?.trim().replace(/\/$/, '');
    if (!host) return;

    const payload = {
      api_key: key,
      event: 'mobile/boot_failed',
      distinct_id: crypto.randomUUID(),
      properties: {
        // Anonymous pre-auth beacon: do not create/mutate a person profile.
        $process_person_profile: false,
        platform: 'mobile',
      },
    };

    const url = `${host}/capture/`;
    const body = JSON.stringify(payload);

    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      typeof Blob !== 'undefined'
    ) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) {
        return;
      }
    }

    if (typeof fetch === 'function') {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
        mode: 'cors',
      }).catch(() => {
        // Swallow: a failed analytics beacon must not surface during boot.
      });
    }
  } catch {
    // Never let a boot beacon throw on top of an already-failed boot.
  }
}

type MobileBootHintCopy = {
  chunkLoad: string;
  offline: string;
  unknown: string;
};

const MOBILE_BOOT_HINT_COPY: Record<SupportedLanguage, MobileBootHintCopy> = {
  en: {
    chunkLoad:
      'Part of the app failed to load. This can happen if the install is incomplete. ' +
      'Reload to try again; if it keeps happening, reinstall the app.',
    offline: 'Your device appears to be offline. Check your network connection, then reload.',
    unknown: 'Copy the error below and send it to us, then reload the app.',
  },
  zh_CN: {
    chunkLoad:
      '应用有部分内容加载失败，可能是安装包不完整所致。请重新加载重试；若反复出现，请重新安装应用。',
    offline: '你的设备似乎处于离线状态。请检查网络连接后再重新加载。',
    unknown: '请复制下方的错误信息发送给我们，然后重新加载应用。',
  },
  zh_Hant: {
    chunkLoad:
      '應用程式有部分內容載入失敗，可能是安裝不完整所致。請重新載入重試；若反覆出現，請重新安裝應用程式。',
    offline: '你的裝置似乎處於離線狀態。請檢查網路連線後再重新載入。',
    unknown: '請複製下方的錯誤資訊傳給我們，然後重新載入應用程式。',
  },
  ja: {
    chunkLoad:
      'アプリの一部を読み込めませんでした。インストールが不完全な可能性があります。再読み込みしてもう一度お試しください。繰り返し発生する場合はアプリを再インストールしてください。',
    offline:
      'デバイスがオフラインのようです。ネットワーク接続を確認してから再読み込みしてください。',
    unknown: '下のエラーをコピーして送信し、アプリを再読み込みしてください。',
  },
  ko: {
    chunkLoad:
      '앱의 일부를 불러오지 못했습니다. 설치가 완전하지 않을 때 발생할 수 있습니다. 새로고침하여 다시 시도하고, 문제가 반복되면 앱을 다시 설치해 주세요.',
    offline: '기기가 오프라인 상태인 것 같습니다. 네트워크 연결을 확인한 뒤 새로고침하세요.',
    unknown: '아래 오류를 복사해 보내 주신 뒤 앱을 새로고침해 주세요.',
  },
  es: {
    chunkLoad:
      'Una parte de la aplicación no se pudo cargar. Esto puede ocurrir si la instalación está incompleta. Recarga para intentarlo de nuevo; si sigue pasando, reinstala la aplicación.',
    offline: 'Tu dispositivo parece estar sin conexión. Comprueba tu red y vuelve a cargar.',
    unknown: 'Copia el error de abajo y envíanoslo; luego recarga la aplicación.',
  },
  fr: {
    chunkLoad:
      'Une partie de l’application n’a pas pu être chargée. Cela peut arriver si l’installation est incomplète. Rechargez pour réessayer ; si le problème persiste, réinstallez l’application.',
    offline: 'Votre appareil semble hors ligne. Vérifiez votre connexion réseau puis rechargez.',
    unknown: 'Copiez l’erreur ci-dessous et envoyez-la-nous, puis rechargez l’application.',
  },
  ru: {
    chunkLoad:
      'Не удалось загрузить часть приложения. Это может произойти при неполной установке. Перезагрузите, чтобы попробовать снова; если проблема повторяется, переустановите приложение.',
    offline: 'Похоже, устройство не в сети. Проверьте подключение к интернету и перезагрузите.',
    unknown: 'Скопируйте ошибку ниже и отправьте её нам, затем перезагрузите приложение.',
  },
};

/**
 * Mobile-specific hint shown above the diagnostics block. Distinguishes the
 * common failure modes so the message points the user at the right recovery.
 */
export function computeMobileHint(error: unknown): string {
  const copy = MOBILE_BOOT_HINT_COPY[resolveBootFailureLanguage()];
  // Chunk/module-load failures surface as Error instances; non-Error throws
  // won't match the patterns below, so an empty message is fine for them.
  const message = error instanceof Error ? `${error.name}: ${error.message}` : '';
  const lower = message.toLowerCase();
  if (
    lower.includes('failed to fetch dynamically imported module') ||
    lower.includes('importing a module script failed') ||
    lower.includes('error loading') ||
    lower.includes('chunkloaderror')
  ) {
    return copy.chunkLoad;
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return copy.offline;
  }
  return copy.unknown;
}

/**
 * Styled, copy/reload-capable boot-failure UI for the Capacitor shell. Reuses
 * the shared pure-DOM renderer (no React/stylesheet dependency) so it works even
 * when the app bundle has failed to mount. Registered with the inline boot guard
 * in index.html, which calls it on any unrecoverable boot failure.
 */
export function showMobileBootFailure(root: HTMLElement, error: unknown): void {
  const mobileKind = classifyMobileBootFailureKind(error);

  postMobileBootFailedBeacon();

  renderBootFailure(root, error, {
    hint: computeMobileHint(error),
    buildInfo: getMobileBuildInfo(),
    failureKind: toSharedBootFailureKind(mobileKind),
    // Default onReload (window.location.reload) re-runs the boot path in the
    // WebView, which is what we want on both iOS and Android.
  });
}
