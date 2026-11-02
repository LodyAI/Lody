import type { SimulatorIceServer } from './webrtc-protocol';
import { readIdleSimulatorExterior } from './exterior';
import { type IosSimulatorRequest, type IosSimulatorResponse } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { QuickTunnelSession } from '@/preview/quick-tunnel-session';
import { LocalPreviewProxyManager } from '@/preview/local-preview-proxy';
import { ensureBaguetteBinary } from './baguette-binary';
import { startBaguetteProcess } from './baguette-process';
import { createSimulatorGateway } from './gateway';
import { listSimulatorDevices, bootSimulator } from './devices';
import { type SimulatorControlLeases } from './control-leases';

type Dependencies = {
  workspaceId: string;
  logger: Logger;
  runtimeBaseUrl: string;
  iceServers?: (
    sessionId: string
  ) => Promise<{ iceServers: SimulatorIceServer[]; expiresAt: number }>;
  authorize(request: IosSimulatorRequest): Promise<void>;
  onAgentPreviewStarted?: (sessionId: string, operationId: string) => Promise<void>;
  leases?: SimulatorControlLeases;
  now?: () => number;
  list?: typeof listSimulatorDevices;
  boot?: typeof bootSimulator;
  exterior?: typeof readIdleSimulatorExterior;
  binary?: (signal: AbortSignal) => Promise<string>;
  process?: typeof startBaguetteProcess;
  gateway?: typeof createSimulatorGateway;
  localProxy?: Pick<LocalPreviewProxyManager, 'acquire' | 'closeSession'>;
  tunnel?: (
    options: ConstructorParameters<typeof QuickTunnelSession>[0]
  ) => Pick<QuickTunnelSession, 'ready' | 'closed' | 'cancel' | 'activity'>;
};

import { DevicePreviewService } from '../device-preview/service';
import type { DeviceRequest, DeviceResponse } from '../device-preview/types';
function fromRequest(request: IosSimulatorRequest): DeviceRequest {
  const c = request.command;
  return {
    ...request,
    command: c.action === 'start' || c.action === 'exterior' ? { action: c.action, id: c.udid } : c,
  };
}
function toRequest(request: DeviceRequest): IosSimulatorRequest {
  const c = request.command;
  return {
    ...request,
    command: c.action === 'start' || c.action === 'exterior' ? { action: c.action, udid: c.id } : c,
  };
}
function response(result: DeviceResponse): IosSimulatorResponse {
  return {
    ...result,
    type: 'ios-simulator/control_response',
    devices: result.devices?.map(({ id, ...d }) => ({ ...d, udid: id })),
    preview: result.preview && (({ id, ...p }) => ({ ...p, udid: id }))(result.preview),
  };
}
/** Old wire contract, one shared operation owner. */
export class IosSimulatorService {
  private readonly core: DevicePreviewService;
  constructor(deps: Dependencies) {
    this.core = new DevicePreviewService({
      ...deps,
      authorize: (r) => deps.authorize(toRequest(r)),
      adapter: {
        platform: 'ios',
        normalize: (id) => id.toUpperCase(),
        environmentMessage:
          'Unable to manage iOS Simulator. Check machine access, Xcode and the installed iOS runtime.',
        list: async (signal) =>
          (await (deps.list ?? listSimulatorDevices)(signal)).map(({ udid, ...d }) => ({
            ...d,
            id: udid,
          })),
        prepare: (signal) =>
          deps.binary?.(signal) ?? ensureBaguetteBinary(signal, deps.runtimeBaseUrl),
        boot: deps.boot ?? bootSimulator,
        exterior: async (id, signal) => {
          const binary = await (deps.binary?.(signal) ??
            ensureBaguetteBinary(signal, deps.runtimeBaseUrl));
          return (deps.exterior ?? readIdleSimulatorExterior)(binary, id, signal);
        },
        open: async (binary, device, signal) => {
          const process = await (deps.process ?? startBaguetteProcess)(binary, signal);
          return {
            closed: process.closed,
            stop: () => process.stop(),
            gateway: (context) =>
              (deps.gateway ?? createSimulatorGateway)({
                ...context,
                udid: device.id,
                port: process.port,
                softwareKeyboard: /iphone|ipad/i.test(device.deviceType),
                hostControl: (control) => process.control(device.id, control),
              }),
          };
        },
      },
    });
  }
  async controlFromAgent(request: IosSimulatorRequest) {
    return response(await this.core.controlFromAgent(fromRequest(request)));
  }
  async control(
    request: IosSimulatorRequest,
    remote: boolean,
    authorizeRemote?: () => Promise<unknown>
  ) {
    return response(await this.core.control(fromRequest(request), remote, authorizeRemote));
  }
  closeSession(sessionId: string) {
    return this.core.closeSession(sessionId);
  }
  closeAll() {
    return this.core.closeAll();
  }
  enableRemote() {
    this.core.enableRemote();
  }
  revokeRemote() {
    this.core.revokeRemote();
  }
}
