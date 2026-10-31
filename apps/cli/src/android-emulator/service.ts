import { DevicePreviewService, type DevicePreviewDependencies } from '../device-preview/service';
import type { AndroidEmulatorRequest, AndroidEmulatorResponse } from '@lody/shared';
import { listAndroidDevices, bootAndroidDevice } from './devices';
import { ensureScrcpyServer } from './runtime';
import { openAndroidConnection } from './connection';
export class AndroidEmulatorService extends DevicePreviewService {
  constructor(deps: Omit<DevicePreviewDependencies, 'adapter'>) {
    super({
      ...deps,
      adapter: {
        platform: 'android',
        normalize: (id) => id,
        list: listAndroidDevices,
        prepare: (signal) => ensureScrcpyServer(signal, deps.runtimeBaseUrl),
        boot: bootAndroidDevice,
        open: (runtime, device, signal) => openAndroidConnection(runtime, device.id, signal),
        environmentMessage:
          'Check the Android SDK, configured AVDs, and ADB access on this machine.',
      },
    });
  }
  override async control(
    request: AndroidEmulatorRequest,
    remote: boolean,
    authorizeRemote?: () => Promise<unknown>
  ): Promise<AndroidEmulatorResponse> {
    return {
      ...(await super.control(request, remote, authorizeRemote)),
      type: 'android-emulator/control_response',
    };
  }
  override async controlFromAgent(
    request: AndroidEmulatorRequest
  ): Promise<AndroidEmulatorResponse> {
    return {
      ...(await super.controlFromAgent(request)),
      type: 'android-emulator/control_response',
    };
  }
}
