import { ManagedDaemonUpgradeOptionsSchema, type ManagedDaemonUpgradeOptions } from '@lody/shared';
import { z } from 'zod';
export const ManagedPrepareRequestSchema = z
  .object({
    type: z.literal('lody/managed-prepare'),
    requestId: z.string().min(1),
    target: z.string().min(1),
    supervisorToken: z.string().min(32),
    upgrade: ManagedDaemonUpgradeOptionsSchema.optional(),
  })
  .strict();
const PreparedSchema = z
  .object({
    type: z.literal('lody/managed-prepared'),
    requestId: z.string(),
    ok: z.boolean(),
    version: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
/** Only the existing authenticated supervisor IPC can prepare a managed update. */
export function requestManagedPreparation(
  requestId: string,
  target: string,
  supervisorToken: string,
  upgrade?: ManagedDaemonUpgradeOptions
): Promise<string> {
  if (!process.send || !process.connected)
    return Promise.reject(new Error('Managed supervisor unavailable'));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      process.off('message', receive);
      process.off('disconnect', disconnected);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const receive = (message: unknown) => {
      const result = PreparedSchema.safeParse(message);
      if (!result.success || result.data.requestId !== requestId) return;
      finish(
        result.data.ok && result.data.version
          ? undefined
          : new Error(result.data.error ?? 'Managed preparation failed'),
        result.data.version
      );
    };
    const disconnected = () => finish(new Error('Managed supervisor disconnected'));
    const timer = setTimeout(
      () => finish(new Error('Managed preparation outcome unknown; query the existing operation')),
      10 * 60_000
    );
    process.on('message', receive);
    process.once('disconnect', disconnected);
    process.send?.(
      {
        type: 'lody/managed-prepare',
        requestId,
        target,
        supervisorToken,
        ...(upgrade ? { upgrade } : {}),
      },
      (error) => {
        if (error) finish(error);
      }
    );
  });
}
