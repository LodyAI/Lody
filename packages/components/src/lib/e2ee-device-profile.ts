import type { E2eeDeviceProfile } from '@lody/cloud-api';
import { collectClientBuildInfo } from './client-build-info';
import { isNativeAppShell } from './native-platform';

// Native hw.machine identifiers, never browser UA. Source:
// https://github.com/devicekit/DeviceKit/blob/master/Source/Device.generated.swift
const IPHONE_MODELS: Readonly<Record<string, string>> = {
  'iPhone13,1': 'iPhone 12 mini',
  'iPhone13,2': 'iPhone 12',
  'iPhone13,3': 'iPhone 12 Pro',
  'iPhone13,4': 'iPhone 12 Pro Max',
  'iPhone14,4': 'iPhone 13 mini',
  'iPhone14,5': 'iPhone 13',
  'iPhone14,2': 'iPhone 13 Pro',
  'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,6': 'iPhone SE (3rd generation)',
  'iPhone14,7': 'iPhone 14',
  'iPhone14,8': 'iPhone 14 Plus',
  'iPhone15,2': 'iPhone 14 Pro',
  'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone15,4': 'iPhone 15',
  'iPhone15,5': 'iPhone 15 Plus',
  'iPhone16,1': 'iPhone 15 Pro',
  'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,3': 'iPhone 16',
  'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,1': 'iPhone 16 Pro',
  'iPhone17,2': 'iPhone 16 Pro Max',
  'iPhone17,5': 'iPhone 16e',
  'iPhone18,3': 'iPhone 17',
  'iPhone18,1': 'iPhone 17 Pro',
  'iPhone18,2': 'iPhone 17 Pro Max',
  'iPhone18,4': 'iPhone Air',
  'iPhone18,5': 'iPhone 17e',
};
const nativeModel = (model: string | undefined) => model && (IPHONE_MODELS[model] ?? model);

/** Only the current host's display data. Never copy this onto another device. */
function collect(): E2eeDeviceProfile {
  const app = window.__LODY_APP_INFO__;
  const desktop = window.__LODY_ELECTRON__ ? window.__LODY_PLATFORM__ : undefined;
  const version = collectClientBuildInfo().appVersion;
  if (desktop)
    return {
      client: 'desktop',
      name: desktop.machineName,
      os: { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[desktop.os] ?? desktop.os,
      osVersion: desktop.osVersion,
      appVersion: version,
    };
  if (isNativeAppShell())
    return {
      client: 'mobile',
      model: nativeModel(app?.model),
      os: app?.os_name === 'ios' ? 'iOS' : app?.os_name === 'android' ? 'Android' : app?.os_name,
      osVersion: app?.os_version,
      appVersion: app?.version ?? version,
    };
  // Browser OS versions and hardware models are often frozen or omitted. Do not
  // turn compatibility UA values into claims about the real OS or iPhone model.
  const hints = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = navigator.platform;
  const os =
    hints.userAgentData?.platform ||
    (/iPhone|iPod/.test(platform)
      ? 'iOS'
      : /iPad/.test(platform) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        ? 'iPadOS'
        : /Mac/.test(platform)
          ? 'macOS'
          : /Win/.test(platform)
            ? 'Windows'
            : /Android/.test(navigator.userAgent)
              ? 'Android'
              : /Linux/.test(platform)
                ? 'Linux'
                : undefined);
  return { client: 'web', os, appVersion: version };
}

export function collectE2eeDeviceProfile(): E2eeDeviceProfile {
  const result = collect();
  return Object.fromEntries(
    Object.entries(result)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        value!
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .trim()
          .slice(0, 128),
      ])
  ) as E2eeDeviceProfile;
}
