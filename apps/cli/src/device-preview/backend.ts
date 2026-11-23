import { EventEmitter } from 'node:events';
import type { DevicePreviewControl } from '@lody/shared';
import type { H264Packet } from './h264-flow';
import type { DeviceExterior } from './types';

/** A bounded platform stream; its close must flush touch release before closing capture. */
export abstract class DeviceStream extends EventEmitter<{
  open: [];
  close: [];
  error: [Error];
  message: [Buffer, boolean];
}> {
  abstract readonly readyState: number;
  abstract readonly bufferedAmount: number;
  abstract send(message: string): void;
  abstract close(): void;
  abstract terminate(): void;
}
export type DevicePreviewBackend = {
  supportsMjpeg: boolean;
  nativeRotation: boolean;
  initialize(): Promise<void>;
  execute(control: DevicePreviewControl, signal: AbortSignal): Promise<void>;
  rotation(): 0 | 90 | 180 | 270;
  openStream(h264: boolean): DeviceStream;
  parseH264(): (message: Buffer) => H264Packet[];
  exterior(signal: AbortSignal): Promise<DeviceExterior>;
  still(scale: number, signal: AbortSignal): Promise<Buffer>;
};
