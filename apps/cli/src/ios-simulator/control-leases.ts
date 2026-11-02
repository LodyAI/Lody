import { DeviceControlLeases } from '../device-preview/control-leases';
/** Compatibility boundary: iOS UUIDs are case insensitive; other device IDs are not. */
export class SimulatorControlLeases extends DeviceControlLeases {
  constructor(normalize: (id: string) => string = (id) => id.toUpperCase()) {
    super(normalize);
  }
}
export const simulatorControlLeases = new SimulatorControlLeases();
