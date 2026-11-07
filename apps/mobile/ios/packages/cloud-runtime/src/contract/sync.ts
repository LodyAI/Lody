import { z } from 'zod/v4';

export const MachinePresence = z
  .object({
    state: z.enum(['live', 'unknown']),
    onlineMachineIds: z.array(z.string().min(1)),
  })
  .meta({ id: 'MachinePresence' });

export const SyncedEvent = z
  .object({
    revision: z.number().int().nonnegative(),
    streams: z.number().int().nonnegative(),
  })
  .meta({ id: 'SyncedEvent' });

export const SyncErrorEvent = z
  .object({
    reason: z.enum([
      'catalog_limit',
      'stream_closed',
      'stalled_cursor',
      'network_or_auth',
    ]),
    stream: z.string().min(1),
  })
  .meta({ id: 'SyncErrorEvent' });

export const DiagnosticEvent = z
  .object({
    stage: z.string().min(1),
    stream: z.string().min(1),
  })
  .meta({ id: 'DiagnosticEvent' });
