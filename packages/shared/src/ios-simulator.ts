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
  z.object({ action: z.literal('exterior'), udid: IosSimulatorUdidSchema }).strict(),
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
/** DeviceKit geometry only; private viewer messages carry the PNG separately. */
const ExteriorSize = z.number().finite().positive().max(16384);
const ExteriorPosition = z.number().finite().min(0).max(16384);
export const IosSimulatorExteriorSchema = z
  .object({
    width: ExteriorSize,
    height: ExteriorSize,
    screen: z
      .object({
        x: ExteriorPosition,
        y: ExteriorPosition,
        width: ExteriorSize,
        height: ExteriorSize,
        radius: ExteriorPosition,
      })
      .strict(),
    buttons: z
      .array(
        z
          .object({
            button: z.enum(['home', 'lock', 'volume-up', 'volume-down', 'action']),
            x: ExteriorPosition,
            y: ExteriorPosition,
            width: ExteriorSize,
            height: ExteriorSize,
          })
          .strict()
      )
      .max(16),
  })
  .strict()
  .refine((value) => {
    const inside = (r: { x: number; y: number; width: number; height: number }) =>
      r.x + r.width <= value.width && r.y + r.height <= value.height;
    return (
      inside(value.screen) &&
      value.buttons.every(inside) &&
      value.screen.radius <= Math.min(value.screen.width, value.screen.height) / 2
    );
  });
export type IosSimulatorExterior = z.infer<typeof IosSimulatorExteriorSchema>;
export const IOS_SIMULATOR_BEZEL_MAX_BYTES = 4 * 1024 * 1024;

/** Reject compressed images with dimensions unrelated to the bounded DeviceKit layout. */
export function isIosSimulatorBezelPng(bytes: Uint8Array, geometry: IosSimulatorExterior): boolean {
  if (bytes.byteLength < 24 || bytes.byteLength > IOS_SIMULATOR_BEZEL_MAX_BYTES) return false;
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(12) === 0x49484452 &&
    view.getUint32(16) === geometry.width &&
    view.getUint32(20) === geometry.height &&
    geometry.width * geometry.height <= 16 * 1024 * 1024
  );
}

/** Immutable native artwork, never screen pixels, credentials or upstream URLs. */
export const IosSimulatorExteriorAssetSchema = z
  .object({
    geometry: IosSimulatorExteriorSchema,
    pngBase64: z
      .string()
      .min(32)
      .max(350_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type IosSimulatorExteriorAsset = z.infer<typeof IosSimulatorExteriorAssetSchema>;

export const IosSimulatorResponseSchema = z
  .object({
    type: z.literal('ios-simulator/control_response'),
    sessionId: id,
    success: z.boolean(),
    devices: z.array(IosSimulatorDeviceSchema).optional(),
    exterior: IosSimulatorExteriorAssetSchema.optional(),
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
