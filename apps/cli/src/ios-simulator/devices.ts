import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { IosSimulatorDevice } from '@lody/shared';
const exec = promisify(execFile);
const Devices = z.object({
  devices: z.record(
    z.string(),
    z.array(
      z.object({
        udid: z.string().uuid(),
        name: z.string(),
        state: z.string(),
        isAvailable: z.boolean(),
        availabilityError: z.string().optional(),
        deviceTypeIdentifier: z.string().optional(),
      })
    )
  ),
});
export function parseSimulatorDevices(value: unknown): IosSimulatorDevice[] {
  return Object.entries(Devices.parse(value).devices).flatMap(([runtime, devices]) =>
    runtime.includes('.iOS-')
      ? devices.map((d) => ({
          udid: d.udid,
          name: d.name,
          runtime: runtime.replace(/^.*\.iOS-/, 'iOS ').replace(/(?<=\d)-/g, '.'),
          deviceType: d.deviceTypeIdentifier?.split('.').at(-1)?.replaceAll('-', ' ') ?? '',
          state: d.state,
          available: d.isAvailable,
          unavailableReason: d.availabilityError,
          occupancy: 'available' as const,
        }))
      : []
  );
}
export async function listSimulatorDevices(signal?: AbortSignal): Promise<IosSimulatorDevice[]> {
  if (process.platform !== 'darwin') throw new Error('iOS Simulator requires macOS.');
  const { stdout } = await exec('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'], {
    signal,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseSimulatorDevices(JSON.parse(stdout));
}
export async function bootSimulator(udid: string, signal: AbortSignal): Promise<void> {
  // bootstatus -b starts a stopped device and joins an already-running boot.
  await exec('/usr/bin/xcrun', ['simctl', 'bootstatus', z.string().uuid().parse(udid), '-b'], {
    signal,
    timeout: 180000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
