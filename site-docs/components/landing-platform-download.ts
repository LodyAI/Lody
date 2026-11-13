/**
 * Shared platform detection + download targets for landing hero and closing CTA.
 * Matches site-docs download page (mac/win/linux/ios/android).
 */

export type PlatformKey = 'mac-arm' | 'mac-intel' | 'win' | 'linux' | 'ios' | 'android' | 'browser';

export const DOWNLOAD_BASE = 'https://updates.lody.ai/production';
export const ANDROID_APK = 'https://updates.lody.ai/mobile/production/lody-android-latest.apk';
/** Public App Store listing (iPhone / iPad). */
export const APP_STORE_URL =
  'https://apps.apple.com/us/app/lody-run-code-agent-anywhere/id6761373528';

export type PlatformDownloadLabels = {
  macArm: string;
  macIntel: string;
  win: string;
  linux: string;
  ios: string;
  android: string;
  browser: string;
};

export type PrimaryDownloadAction = {
  key: PlatformKey;
  label: string;
  href: string;
  external?: boolean;
  download?: boolean;
};

export function detectPlatform(userAgent: string, platform?: string): PlatformKey {
  if (/Android/u.test(userAgent)) return 'android';
  if (/iPhone|iPad|iPod/u.test(userAgent)) return 'ios';
  if (/Windows/u.test(userAgent)) return 'win';
  if (/Linux/u.test(userAgent) && !/Android/u.test(userAgent)) return 'linux';
  // macOS: prefer Apple Silicon when we can tell (Chrome UA-CH or arm Mac UA).
  if (/Mac|Macintosh/u.test(userAgent) || platform === 'MacIntel' || platform === 'MacPPC') {
    const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform;
    if (
      uaPlatform === 'macOS' ||
      /Mac OS X/u.test(userAgent) ||
      platform === 'MacIntel' ||
      platform === 'MacPPC'
    ) {
      // Intel Macs still report MacIntel; Apple Silicon often does too in Safari.
      // Prefer arm64 DMG (vast majority of current Macs); Intel remains a secondary.
      return 'mac-arm';
    }
    return 'mac-arm';
  }
  return 'browser';
}

export function resolvePrimaryDownloadAction(input: {
  platform: PlatformKey | null;
  labels: PlatformDownloadLabels;
  allPlatforms: { label: string; href: string };
}): PrimaryDownloadAction {
  const key = input.platform ?? 'browser';
  switch (key) {
    case 'mac-arm':
      return {
        key,
        label: input.labels.macArm,
        href: `${DOWNLOAD_BASE}/Lody-latest-arm64.dmg`,
        download: true,
      };
    case 'mac-intel':
      return {
        key,
        label: input.labels.macIntel,
        href: `${DOWNLOAD_BASE}/Lody-latest-x64.dmg`,
        download: true,
      };
    case 'win':
      return {
        key,
        label: input.labels.win,
        href: `${DOWNLOAD_BASE}/Lody-latest-x64-setup.exe`,
        download: true,
      };
    case 'linux':
      return {
        key,
        label: input.labels.linux,
        href: `${DOWNLOAD_BASE}/Lody-latest-x86_64.AppImage`,
        download: true,
      };
    case 'ios':
      return {
        key,
        label: input.labels.ios,
        href: APP_STORE_URL,
        external: true,
      };
    case 'android':
      return {
        key,
        label: input.labels.android,
        href: ANDROID_APK,
        download: true,
      };
    default:
      return {
        key: 'browser',
        label: input.allPlatforms.label,
        href: input.allPlatforms.href,
      };
  }
}
