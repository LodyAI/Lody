import { z } from 'zod';
import { RpcSecretEnvelopeSchema } from './rpc-secret';

const id = z.string().min(1).max(200);
/** Private preview plane only: text and deep links must never enter workspace RPC streams. */
export const IosSimulatorDeviceControlSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('button'),
      button: z.enum(['home', 'app-switcher', 'lock', 'volume-up', 'volume-down', 'action']),
    })
    .strict(),
  z.object({ kind: z.literal('rotate'), direction: z.enum(['left', 'right']) }).strict(),
  z.object({ kind: z.literal('shake') }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(16000) }).strict(),
  z.object({ kind: z.literal('appearance'), appearance: z.enum(['light', 'dark']) }).strict(),
  z
    .object({
      kind: z.literal('open-url'),
      url: z
        .string()
        .min(1)
        .max(8192)
        .refine((value) => {
          for (const char of value) {
            if (char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) return false;
          }
          try {
            return !['javascript:', 'vbscript:', 'data:', 'file:', 'blob:', 'about:'].includes(
              new URL(value).protocol
            );
          } catch {
            return false;
          }
        }),
    })
    .strict(),
]);
export type IosSimulatorDeviceControl = z.infer<typeof IosSimulatorDeviceControlSchema>;
export const IosSimulatorDeviceControlRequestSchema = z
  .object({
    operationId: id,
    requestId: id,
    control: IosSimulatorDeviceControlSchema,
  })
  .strict();
export const IosSimulatorDeviceControlResultSchema = z
  .object({
    success: z.boolean(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    error: z.enum(['unavailable', 'unsupported', 'failed', 'busy']).optional(),
  })
  .strict();
export type IosSimulatorDeviceControlResult = z.infer<typeof IosSimulatorDeviceControlResultSchema>;
export const IosSimulatorUdidSchema = z.string().uuid();
/** Lifecycle commands are separate from media/input. No caller-supplied ports or commands. */
export const IosSimulatorCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('start'), udid: IosSimulatorUdidSchema }).strict(),
  z.object({ action: z.literal('status'), operationId: id.optional() }).strict(),
  z.object({ action: z.literal('stop'), operationId: id }).strict(),
]);
export const IosSimulatorRequestSchema = z
  .object({
    sessionId: id,
    requestedByUserId: id,
    command: IosSimulatorCommandSchema,
  })
  .strict();
export const IosSimulatorDeviceSchema = z
  .object({
    udid: IosSimulatorUdidSchema,
    name: z.string(),
    runtime: z.string(),
    deviceType: z.string(),
    state: z.string(),
    available: z.boolean(),
    unavailableReason: z.string().optional(),
    occupancy: z.enum(['available', 'this-session', 'other-session']),
  })
  .strict();
export const IosSimulatorPreviewSchema = z
  .object({
    operationId: id,
    udid: IosSimulatorUdidSchema,
    phase: z.enum(['preparing', 'booting', 'connecting', 'ready', 'closed', 'failed']),
    transport: z.enum(['local', 'remote']),
    viewerUrl: z.string().url().optional(),
    message: z.string().optional(),
  })
  .strict();
export const IosSimulatorResponseSchema = z
  .object({
    type: z.literal('ios-simulator/control_response'),
    sessionId: id,
    success: z.boolean(),
    devices: z.array(IosSimulatorDeviceSchema).optional(),
    preview: IosSimulatorPreviewSchema.optional(),
    error: z
      .enum(['unsupported', 'environment', 'occupied', 'unavailable', 'denied', 'failed'])
      .optional(),
    message: z.string().optional(),
  })
  .strict();
export type IosSimulatorCommand = z.infer<typeof IosSimulatorCommandSchema>;
export type IosSimulatorRequest = z.infer<typeof IosSimulatorRequestSchema>;
export type IosSimulatorDevice = z.infer<typeof IosSimulatorDeviceSchema>;
export type IosSimulatorPreview = z.infer<typeof IosSimulatorPreviewSchema>;
export type IosSimulatorResponse = z.infer<typeof IosSimulatorResponseSchema>;

/** Workspace streams are shared: never put a bearer viewer URL in a remote result. */
export const IosSimulatorRemoteResponseSchema = IosSimulatorResponseSchema.extend({
  preview: IosSimulatorPreviewSchema.omit({ viewerUrl: true })
    .extend({
      viewerUrlEnvelope: RpcSecretEnvelopeSchema.optional(),
    })
    .strict()
    .refine((p) => p.phase !== 'ready' || p.viewerUrlEnvelope !== undefined)
    .optional(),
}).strict();
export type IosSimulatorRemoteResponse = z.infer<typeof IosSimulatorRemoteResponseSchema>;
