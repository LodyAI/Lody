import { z } from 'zod';
import { IosSimulatorDeviceControlSchema } from './ios-simulator';

/** Private input plane shared by device viewers; lifecycle RPC never carries input text. */
export const DevicePreviewControlSchema = z.union([
  IosSimulatorDeviceControlSchema,
  z.object({ kind: z.literal('button'), button: z.literal('back') }).strict(),
]);
export type DevicePreviewControl = z.infer<typeof DevicePreviewControlSchema>;
export const DevicePreviewControlRequestSchema = z
  .object({
    operationId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    control: DevicePreviewControlSchema,
  })
  .strict();
