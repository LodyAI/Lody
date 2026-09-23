import type { Platform, Runtime } from './types';

let cachedPlatform: Platform | null = null;
let cachedRuntime: Runtime | null = null;

export function getPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform;
  if (typeof window === 'undefined') return 'unknown';

  const electronOs = (window as { __LODY_PLATFORM__?: { os?: string } }).__LODY_PLATFORM__?.os;
  if (electronOs === 'darwin') return (cachedPlatform = 'mac');
  if (electronOs === 'win32') return (cachedPlatform = 'win');
  if (electronOs === 'linux') return (cachedPlatform = 'linux');

  const ua = navigator.userAgent || '';
  const platform = (navigator.platform || '').toLowerCase();
  if (/iphone|ipad|ipod/i.test(ua)) return (cachedPlatform = 'ios');
  if (/android/i.test(ua)) return (cachedPlatform = 'android');
  if (platform.includes('mac')) return (cachedPlatform = 'mac');
  if (platform.includes('win')) return (cachedPlatform = 'win');
  if (platform.includes('linux')) return (cachedPlatform = 'linux');
  return (cachedPlatform = 'unknown');
}

export function getRuntime(): Runtime {
  if (cachedRuntime) return cachedRuntime;
  if (typeof window === 'undefined') return 'web';
  const w = window as {
    __LODY_ELECTRON__?: boolean;
    __LODY_NATIVE__?: boolean;
    __LODY_CORDOVA_READY__?: boolean;
  };
  if (w.__LODY_ELECTRON__) return (cachedRuntime = 'electron');
  if (w.__LODY_NATIVE__ || w.__LODY_CORDOVA_READY__) return (cachedRuntime = 'mobile');
  return (cachedRuntime = 'web');
}

export function isMac(): boolean {
  const p = getPlatform();
  return p === 'mac' || p === 'ios';
}

export function getHotkeyPlatform(): 'mac' | 'windows' | 'linux' {
  const platform = getPlatform();
  if (platform === 'mac' || platform === 'ios') return 'mac';
  if (platform === 'win') return 'windows';
  return 'linux';
}

// Test-only: reset module-cached platform/runtime for tests that mock window globals.
export function __resetPlatformCacheForTests(): void {
  cachedPlatform = null;
  cachedRuntime = null;
}
