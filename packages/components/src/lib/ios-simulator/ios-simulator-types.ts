import type { IosSimulatorDevice, IosSimulatorResponse } from '@lody/shared';

/**
 * View types for the iOS Simulator side panel. The wire contract
 * (`ios-simulator/control` and its `@lody/shared` DTOs) belongs to the Machine
 * RPC layer; `ios-simulator-model.ts` is the one place that maps it onto these.
 */

/** A runtime as the picker groups by it, parsed from the device's `runtime` string. */
export type IosSimulatorRuntimeEntry = {
  /** The raw `runtime` value; devices group by exact equality. */
  key: string;
  /** Display name, e.g. `iOS 18.2`. */
  name: string;
  /** `iOS`, `watchOS`, …; empty when the runtime string is not recognisable. */
  platform: string;
  version: string;
};

export type IosSimulatorDeviceFamily = 'iphone' | 'ipad' | 'watch' | 'tv' | 'vision' | 'other';

export type IosSimulatorDeviceState =
  | 'booted'
  | 'booting'
  | 'shutdown'
  | 'shutting-down'
  | 'unknown';

export type IosSimulatorDeviceEntry = {
  udid: string;
  name: string;
  runtimeKey: string;
  /** The raw device type, e.g. `…SimDeviceType.iPhone-16-Pro`; the exterior reads it. */
  deviceType: string;
  family: IosSimulatorDeviceFamily;
  state: IosSimulatorDeviceState;
  available: boolean;
  unavailableReason?: string;
  /** One Session controls a device across every client; nobody takes it over. */
  occupancy: IosSimulatorDevice['occupancy'];
};

export type IosSimulatorErrorCode =
  | NonNullable<IosSimulatorResponse['error']>
  /** The panel stopped waiting for a preview that never became ready. */
  | 'timeout';

export type IosSimulatorError = {
  code: IosSimulatorErrorCode;
  message?: string;
};

export type IosSimulatorPreparingStage = 'preparing' | 'booting' | 'connecting';

/** `local`: served by this machine's daemon; keeps working while the cloud is unreachable. */
export type IosSimulatorTransport = 'local' | 'remote';

export type IosSimulatorPanelStatus =
  | { phase: 'idle' }
  | {
      phase: 'preparing';
      udid: string;
      /** Unknown until the start request answers; Cancel needs it. */
      operationId?: string;
      stage: IosSimulatorPreparingStage;
    }
  | {
      phase: 'ready';
      udid: string;
      operationId: string;
      viewerUrl: string;
      /** Validated origin the viewer handshake is addressed to. */
      viewerOrigin: string;
      transport: IosSimulatorTransport;
    }
  | {
      phase: 'closed';
      udid: string;
      operationId: string;
      transport: IosSimulatorTransport;
      message?: string;
    }
  | { phase: 'failed'; udid?: string; operationId?: string; error: IosSimulatorError };

/** What the viewer page reports about its own stream, after the init handshake. */
export type IosSimulatorViewerState = 'connecting' | 'ready' | 'disconnected' | 'error';
