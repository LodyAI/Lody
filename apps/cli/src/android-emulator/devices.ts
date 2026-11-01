import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommandTextLegacy, startProcessLegacy } from '@lody/shared/node/process';
import type { DeviceEntry } from '../device-preview/types';

const validAvd = /^[a-zA-Z0-9_.-]{1,200}$/;
export function parseAvdNames(value: string): string[] {
  const names = value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.some((n) => !validAvd.test(n))) throw Error('Invalid AVD catalog');
  return [...new Set(names)];
}
export function matchAvdSerial(
  name: string,
  running: Array<{ name: string; serial: string }>
): string | undefined {
  const matches = running.filter((d) => d.name === name);
  if (matches.length > 1) throw Error('Multiple running instances of this AVD');
  return matches[0]?.serial;
}
export async function androidTools(): Promise<{ adb: string; emulator: string }> {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'),
    join(homedir(), 'Android', 'Sdk'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ].filter((s): s is string => !!s);
  const find = async (tool: string, folder: string) => {
    const name = tool + (process.platform === 'win32' ? '.exe' : '');
    const paths = [
      ...roots.map((r) => join(r, folder, name)),
      ...(process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((r) => join(r, name)),
    ];
    for (const path of paths) {
      try {
        await access(path);
        return path;
      } catch {
        /* Try next explicit SDK location. */
      }
    }
    throw Error(`Android SDK ${tool} is missing`);
  };
  return { adb: await find('adb', 'platform-tools'), emulator: await find('emulator', 'emulator') };
}
async function command(path: string, args: string[], signal?: AbortSignal, timeout = 15000) {
  return (
    await runCommandTextLegacy(
      { command: path, args, check: 'exit-0', timeout, maxOutputBytes: 1024 * 1024 },
      { signal }
    )
  ).stdout;
}
export async function runningAvds(
  signal?: AbortSignal
): Promise<Array<{ name: string; serial: string }>> {
  const { adb } = await androidTools();
  const devices = await command(adb, ['devices'], signal);
  const serials = devices.split(/\r?\n/).flatMap((line) => {
    const match = /^(emulator-\d+)\s+device$/.exec(line.trim());
    return match?.[1] ? [match[1]] : [];
  });
  const result = [];
  for (const serial of serials) {
    const name = (await command(adb, ['-s', serial, 'emu', 'avd', 'name'], signal))
      .split(/\r?\n/)[0]
      ?.trim();
    if (name && validAvd.test(name)) result.push({ name, serial });
  }
  return result;
}
export async function listAndroidDevices(signal?: AbortSignal): Promise<DeviceEntry[]> {
  const { emulator } = await androidTools();
  const names = parseAvdNames(await command(emulator, ['-list-avds'], signal));
  const running = await runningAvds(signal);
  return names.map((name) => {
    const matches = running.filter((d) => d.name === name);
    return {
      id: name,
      name,
      runtime: 'Android',
      deviceType: 'AVD',
      state: matches.length ? 'Booted' : 'Shutdown',
      available: matches.length <= 1,
      unavailableReason: matches.length > 1 ? 'Multiple running instances' : undefined,
      occupancy: 'available',
    };
  });
}
export async function resolveAndroidSerial(name: string, signal?: AbortSignal): Promise<string> {
  if (!validAvd.test(name)) throw Error('Invalid AVD');
  const serial = matchAvdSerial(name, await runningAvds(signal));
  if (!serial) throw Error('Selected AVD is not running');
  return serial;
}
export async function bootAndroidDevice(name: string, signal: AbortSignal): Promise<void> {
  if (!validAvd.test(name)) throw Error('Invalid AVD');
  const { adb, emulator } = await androidTools();
  if (!parseAvdNames(await command(emulator, ['-list-avds'], signal)).includes(name))
    throw Error('Unknown AVD');
  if (!matchAvdSerial(name, await runningAvds(signal))) {
    signal.throwIfAborted();
    // The device is a user resource and intentionally survives preview cancellation.
    const { child } = startProcessLegacy({
      command: emulator,
      args: ['-avd', name, '-no-window', '-no-audio'],
      processGroup: false,
      options: { detached: true, stdio: 'ignore' },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
  for (;;) {
    deadline.throwIfAborted();
    const serial = matchAvdSerial(name, await runningAvds(deadline));
    if (
      serial &&
      (
        await command(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], deadline)
      ).trim() === '1'
    )
      return;
    await delay(500, undefined, { signal: deadline });
  }
}
