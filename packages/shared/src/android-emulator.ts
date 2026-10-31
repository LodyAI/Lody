import { z } from 'zod';
import {
  IosSimulatorDeviceSchema,
  IosSimulatorPreviewSchema,
  IosSimulatorResponseSchema,
} from './ios-simulator';
import { RpcSecretEnvelopeSchema } from './rpc-secret';
const id = z.string().min(1).max(200);
export const AndroidAvdNameSchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/);
export const AndroidEmulatorCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('start'), id: AndroidAvdNameSchema }).strict(),
  z.object({ action: z.literal('status'), operationId: id.optional() }).strict(),
  z.object({ action: z.literal('stop'), operationId: id }).strict(),
]);
export const AndroidEmulatorRequestSchema = z
  .object({ sessionId: id, requestedByUserId: id, command: AndroidEmulatorCommandSchema })
  .strict();
export const AndroidEmulatorDeviceSchema = IosSimulatorDeviceSchema.omit({ udid: true })
  .extend({ id: AndroidAvdNameSchema })
  .strict();
export const AndroidEmulatorPreviewSchema = IosSimulatorPreviewSchema.omit({ udid: true })
  .extend({ id: AndroidAvdNameSchema })
  .strict();
export const AndroidEmulatorResponseSchema = IosSimulatorResponseSchema.omit({ exterior: true })
  .extend({
    type: z.literal('android-emulator/control_response'),
    devices: z.array(AndroidEmulatorDeviceSchema).optional(),
    preview: AndroidEmulatorPreviewSchema.optional(),
  })
  .strict();
export const AndroidEmulatorRemoteResponseSchema = AndroidEmulatorResponseSchema.extend({
  preview: AndroidEmulatorPreviewSchema.omit({ viewerUrl: true })
    .extend({ viewerUrlEnvelope: RpcSecretEnvelopeSchema.optional() })
    .strict()
    .refine((p) => p.phase !== 'ready' || p.viewerUrlEnvelope !== undefined)
    .optional(),
}).strict();
export type AndroidEmulatorCommand = z.infer<typeof AndroidEmulatorCommandSchema>;
export type AndroidEmulatorRequest = z.infer<typeof AndroidEmulatorRequestSchema>;
export type AndroidEmulatorResponse = z.infer<typeof AndroidEmulatorResponseSchema>;
export type AndroidEmulatorRemoteResponse = z.infer<typeof AndroidEmulatorRemoteResponseSchema>;
