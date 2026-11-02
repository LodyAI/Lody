import type {
  AndroidEmulatorQuality,
  IosSimulatorExteriorAsset,
  IosSimulatorExterior,
} from '@lody/shared';

export type DevicePlatform = 'ios' | 'android';
export type DeviceEntry = {
  id: string;
  name: string;
  runtime: string;
  deviceType: string;
  state: string;
  available: boolean;
  unavailableReason?: string;
  occupancy: 'available' | 'this-session' | 'other-session';
};
export type DeviceCommand =
  | { action: 'list' }
  | { action: 'exterior'; id: string }
  | { action: 'start'; id: string; quality?: AndroidEmulatorQuality }
  | { action: 'status'; operationId?: string }
  | { action: 'stop'; operationId: string };
export type DeviceRequest = {
  sessionId: string;
  requestedByUserId: string;
  command: DeviceCommand;
};
export type DevicePreview = {
  operationId: string;
  id: string;
  phase: 'preparing' | 'booting' | 'connecting' | 'ready' | 'closed' | 'failed';
  transport: 'local' | 'remote';
  viewerUrl?: string;
  message?: string;
};
export type DeviceResponse = {
  sessionId: string;
  success: boolean;
  devices?: DeviceEntry[];
  preview?: DevicePreview;
  exterior?: IosSimulatorExteriorAsset;
  error?: 'unsupported' | 'environment' | 'occupied' | 'unavailable' | 'denied' | 'failed';
  message?: string;
};
export type DeviceExterior = { geometry: IosSimulatorExterior; png: Buffer };
