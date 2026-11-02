import { DeviceH264Flow } from '../device-preview/h264-flow';
import { createBaguetteH264Parser } from './h264-parser';
export { SIMULATOR_AVC_MAGIC } from '../device-preview/h264-flow';
/** Compatibility entry for Baguette protocol tests. Production uses the platform parser. */
export class SimulatorH264Flow extends DeviceH264Flow {
  private readonly parse = createBaguetteH264Parser();
  override offer(message: Buffer, now: number): void;
  override offer(message: Parameters<DeviceH264Flow['offer']>[0], now: number): void;
  override offer(message: Buffer | Parameters<DeviceH264Flow['offer']>[0], now: number) {
    if (!Buffer.isBuffer(message)) return super.offer(message, now);
    for (const packet of this.parse(message)) super.offer(packet, now);
  }
}
