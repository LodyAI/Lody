import { WebSocket } from 'ws';
import { IosSimulatorDeviceControlSchema } from '@lody/shared';
import { createDevicePreviewGateway } from '../device-preview/gateway';
import { DeviceStream } from '../device-preview/backend';
import { createSimulatorDeviceControls } from './device-controls';
import { createBaguetteH264Parser } from './h264-parser';
import { readSimulatorExterior } from './exterior';
import { readSimulatorStill } from './idle-refresh';
import type { SimulatorHostControl } from './host-controls';
import type { SimulatorIceServer } from './webrtc-protocol';
class BaguetteStream extends DeviceStream {
  constructor(private readonly socket: WebSocket) {
    super();
    socket.on('open', () => this.emit('open'));
    socket.on('close', () => this.emit('close'));
    socket.on('error', (e) => this.emit('error', e));
    socket.on('message', (data, binary) =>
      this.emit(
        'message',
        Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data),
        binary
      )
    );
  }
  get readyState() {
    return this.socket.readyState;
  }
  get bufferedAmount() {
    return this.socket.bufferedAmount;
  }
  send(message: string) {
    this.socket.send(message);
  }
  close() {
    this.socket.close();
  }
  terminate() {
    this.socket.terminate();
  }
}
export function createSimulatorGateway(options: {
  operationId: string;
  udid: string;
  port: number;
  softwareKeyboard?: boolean;
  remote?: boolean;
  iceServers?: () => Promise<SimulatorIceServer[]>;
  signal?: AbortSignal;
  hostControl(control: SimulatorHostControl): Promise<void>;
  active(): boolean;
  renew(): void;
}) {
  const controls = createSimulatorDeviceControls({
    ...options,
    signal: options.signal ?? new AbortController().signal,
  });
  return createDevicePreviewGateway({
    ...options,
    backend: {
      supportsMjpeg: true,
      nativeRotation: false,
      initialize: controls.initialize,
      rotation: controls.rotation,
      execute: (control) => controls.execute(IosSimulatorDeviceControlSchema.parse(control)),
      openStream: (h264) =>
        new BaguetteStream(
          new WebSocket(
            `ws://127.0.0.1:${options.port}/simulators/${options.udid}/stream?format=${h264 ? 'avcc' : 'mjpeg'}&version=1`,
            { maxPayload: 16 * 1024 * 1024 }
          )
        ),
      parseH264: createBaguetteH264Parser,
      exterior: (signal) => readSimulatorExterior({ ...options, signal }),
      still: (scale, signal) => readSimulatorStill({ ...options, scale, signal }),
    },
  });
}
