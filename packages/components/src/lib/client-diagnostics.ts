import { collectClientBuildInfo } from './client-build-info';
import { isNativeAppShell } from './native-platform';
import { readClientLog, redactClientLogText } from './client-log';

const CLIENT_LOG_TAIL_CHARS = 24_000;
const CLIENT_LOG_READ_TIMEOUT_MS = 1000;

async function readClientLogTailWithin(): Promise<string> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      readClientLog().then((text) => text.slice(-CLIENT_LOG_TAIL_CHARS) || '(no captured events)'),
      new Promise<string>((resolve) => {
        timeout = window.setTimeout(
          () => resolve('(renderer log read timed out)'),
          CLIENT_LOG_READ_TIMEOUT_MS
        );
      }),
    ]);
  } catch {
    return '(renderer log unavailable)';
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

export function parseClientUserAgent(ua: string): Record<string, string> {
  const result: Record<string, string> = {};
  const browsers: [string, RegExp][] = [
    ['Huawei Browser', /HuaweiBrowser\/([\d.]+)/i],
    ['Mi Browser', /MiuiBrowser\/([\d.]+)/i],
    ['Samsung Internet', /SamsungBrowser\/([\d.]+)/i],
    ['Edge', /(?:Edg|EdgA|EdgiOS)\/([\d.]+)/],
    ['Opera', /(?:OPR|OPiOS)\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, pattern] of browsers) {
    const match = ua.match(pattern);
    if (match) {
      result.browser = name;
      result.browserVersion = match[1]!;
      break;
    }
  }
  const systems: [string, RegExp][] = [
    ['HarmonyOS', /HarmonyOS[ /]([\d.]+)/i],
    ['Android', /Android[ /]([\d.]+)/],
    ['iOS', /(?:CPU (?:iPhone )?OS|iPhone OS) ([\d_]+)/],
    ['Windows', /Windows NT ([\d.]+)/],
    ['macOS', /Mac OS X ([\d_]+)/],
  ];
  for (const [name, pattern] of systems) {
    const match = ua.match(pattern);
    if (match) {
      result.uaOS = name;
      result.uaOSVersion = match[1]!.replaceAll('_', '.');
      break;
    }
  }
  if (!result.uaOS && /Linux/.test(ua)) result.uaOS = 'Linux';
  return result;
}

type UserAgentHints = {
  platform?: string;
  brands?: { brand: string; version: string }[];
  getHighEntropyValues?: (keys: string[]) => Promise<Record<string, unknown>>;
};

/** Explicit allowlist: never include hostnames, home paths, IDs, URLs or account data. */
export async function collectClientDiagnostics(): Promise<string> {
  const logTail = readClientLogTailWithin();
  const app = window.__LODY_APP_INFO__;
  const desktop = window.__LODY_PLATFORM__;
  const hints = (navigator as Navigator & { userAgentData?: UserAgentHints }).userAgentData;
  const info: Record<string, unknown> = {
    ...collectClientBuildInfo(),
    ...parseClientUserAgent(navigator.userAgent),
    runtime: window.__LODY_ELECTRON__ ? 'electron' : isNativeAppShell() ? 'native' : 'web',
    nativeAppVersion: app?.version,
    nativeAppBuild: app?.build,
    os: desktop
      ? ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[desktop.os] ?? desktop.os)
      : (app?.os_name ?? hints?.platform ?? navigator.platform),
    osVersion: desktop?.osVersion ?? app?.os_version,
    architecture: desktop?.architecture,
    electronVersion: desktop?.electronVersion,
    chromiumVersion: desktop?.chromiumVersion,
    manufacturer: app?.manufacturer,
    model: app?.model,
    androidSDKVersion: app?.android_sdk_version,
    webViewVersion: app?.webview_version,
    isVirtual: app?.is_virtual,
    userAgent: navigator.userAgent,
    browserBrands: hints?.brands,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: navigator.onLine,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: window.devicePixelRatio,
    },
    screen: { width: window.screen.width, height: window.screen.height },
  };
  if (hints?.getHighEntropyValues) {
    let timeout: number | undefined;
    try {
      const values = await Promise.race([
        hints.getHighEntropyValues([
          'platformVersion',
          'architecture',
          'bitness',
          'model',
          'fullVersionList',
        ]),
        new Promise<undefined>((resolve) => {
          timeout = window.setTimeout(resolve, 1000);
        }),
      ]);
      if (values) {
        for (const key of [
          'platformVersion',
          'architecture',
          'bitness',
          'model',
          'fullVersionList',
        ]) {
          if (values[key] !== undefined) info[`browser_${key}`] = values[key];
        }
      }
    } catch {
      /* Unsupported or denied: keep the raw UA. */
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  }
  return redactClientLogText(
    `Reporting client environment\n${JSON.stringify(info, null, 2)}\n\nRenderer diagnostic log tail (includes persisted recovery events)\n${await logTail}`
  ).slice(0, 64_000);
}
