import { z } from 'zod/v4';

export const SessionPreviewParams = z
  .object({
    sessionId: z.string().min(1),
    userId: z.string(),
    action: z.enum(['create', 'revoke']).optional(),
  })
  .meta({ id: 'SessionPreviewParams' });

export const SessionPreviewResult = z
  .object({
    url: z.string().min(1).optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    status: z.number().int().optional(),
  })
  .meta({ id: 'SessionPreviewResult' });

const operationId = z.string().min(1);

export const IosSimulatorControlParams = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    userId: z.string(),
    command: z.discriminatedUnion('action', [
      z.object({ action: z.literal('list') }),
      z.object({ action: z.literal('exterior'), udid: z.string().min(1) }),
      z.object({ action: z.literal('start'), udid: z.string().min(1) }),
      z.object({
        action: z.literal('status'),
        operationId: operationId.optional(),
      }),
      z.object({ action: z.literal('stop'), operationId }),
    ]),
  })
  .meta({ id: 'IosSimulatorControlParams' });

const rect = {
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
};

export const IosSimulatorControlResult = z
  .object({
    type: z.string().optional(),
    sessionId: z.string().optional(),
    success: z.boolean().optional(),
    devices: z
      .array(
        z.object({
          udid: z.string().min(1),
          name: z.string(),
          runtime: z.string(),
          deviceType: z.string(),
          state: z.string(),
          available: z.boolean(),
          unavailableReason: z.string().optional(),
          occupancy: z.enum(['available', 'this-session', 'other-session']),
        }),
      )
      .optional(),
    exterior: z
      .object({
        geometry: z.object({
          width: z.number(),
          height: z.number(),
          screen: z.object({ ...rect, radius: z.number() }),
          buttons: z.array(
            z.object({
              ...rect,
              button: z.enum([
                'home',
                'lock',
                'volume-up',
                'volume-down',
                'action',
              ]),
            }),
          ),
        }),
        pngBase64: z.string(),
      })
      .optional(),
    preview: z
      .object({
        operationId,
        udid: z.string().min(1),
        phase: z.enum([
          'preparing',
          'booting',
          'connecting',
          'ready',
          'closed',
          'failed',
        ]),
        transport: z.enum(['local', 'remote']),
        viewerUrl: z.string().min(1).optional(),
        message: z.string().optional(),
      })
      .optional(),
    error: z.string().optional(),
    status: z.number().int().optional(),
    message: z.string().optional(),
    capabilities: z.record(z.string(), z.number().int()).optional(),
  })
  .meta({ id: 'IosSimulatorControlResult' });
