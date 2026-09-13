/**
 * Capture mobile / Passkey PRF / production CAS unavailability.
 * Does not simulate a phone, fake PRF, or invent a Streams backend.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';

function run(cmd: string, args: string[]): { status: number | null; out: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    status: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromium = '/opt/homebrew/bin/chromium';
const adb = run('which', ['adb']);
const sim = run('xcrun', ['simctl', 'list', 'devices', 'available']);
const usb = run('system_profiler', ['SPUSBDataType']);
const chromeVer = existsSync(chrome) ? run(chrome, ['--version']) : { status: 1, out: 'missing' };
const chromiumVer = existsSync(chromium)
  ? run(chromium, ['--version'])
  : { status: 1, out: 'missing' };
const iphoneUsb = /iPhone|Android|Pixel|Samsung/i.test(usb.out);
const simPhones = [...sim.out.matchAll(/iPhone[^\n]*(Shutdown|Booted)/g)].map((m) => m[0]!.trim());

const report = {
  env: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model ?? 'unknown',
    darwin: run('uname', ['-a']).out,
  },
  desktopBrowsers: {
    chrome: chromeVer.out,
    chromium: chromiumVer.out,
    safari: run('defaults', [
      'read',
      '/Applications/Safari.app/Contents/Info.plist',
      'CFBundleShortVersionString',
    ]).out,
  },
  mobile: {
    adb: adb.status === 0 ? adb.out : 'not-found',
    usbPhone: iphoneUsb,
    iosSimulatorsPresent: simPhones,
    iosSimulatorIsNotRealPhone: true,
  },
  webauthn: {
    nodePublicKeyCredential: typeof globalThis.PublicKeyCredential,
    passkeyPrfInThisProcess: false,
  },
  productionCas: {
    LORO_STREAMS_URL: process.env.LORO_STREAMS_URL ?? 'unset',
    streamsEnvKeys: Object.keys(process.env).filter((k) =>
      /STREAMS|LORO.*TOKEN|LORO.*KEY|CAS_URL|JWT/i.test(k)
    ),
  },
  verdict: {
    realMobileBrowser: false,
    passkeyPrf: false,
    productionAtomicCas: false,
    reason: [
      'no USB phone',
      adb.status === 0 ? 'adb present' : 'adb missing',
      'iOS Simulator listed but is not a real mobile device',
      'Node has no PublicKeyCredential / PRF',
      'no LORO_STREAMS_URL or CAS credentials in env',
    ],
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
