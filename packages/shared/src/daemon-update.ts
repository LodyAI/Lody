import { z } from 'zod';
/** These choices are signed together with the operation ID and exact target version. */
export const ManagedDaemonUpgradeOptionsSchema = z
  .object({
    protocol: z.literal(1),
    channel: z.enum(['stable', 'next', 'nightly']),
    switchPolicy: z.enum(['when-idle', 'immediate']),
    confirmChannelChange: z.boolean(),
    confirmDowngrade: z.boolean(),
  })
  .strict();
export type ManagedDaemonUpgradeOptions = z.infer<typeof ManagedDaemonUpgradeOptionsSchema>;

/** Semver ordering for an explicit downgrade confirmation, including nightly→stable. */
export function isDaemonVersionDowngrade(current: string, target: string): boolean {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) throw new Error('Invalid daemon release version');
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
      pre: match[4]?.split('.'),
    };
  };
  const a = parse(current),
    b = parse(target);
  for (const i of [0, 1, 2] as const) if (a.core[i] !== b.core[i]) return b.core[i] < a.core[i];
  if (!a.pre) return !!b.pre;
  if (!b.pre) return false;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === y) continue;
    if (x === undefined) return false;
    if (y === undefined) return true;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) return Number(y) < Number(x);
    if (nx !== ny) return ny;
    return y < x;
  }
  return false;
}

export const ManagedDaemonUpdateStatusSchema = z
  .object({
    serviceInstanceId: z.string().min(1),
    requestId: z.string().min(1),
    phase: z.enum([
      'preparing',
      'prepared',
      'waiting',
      'switching',
      'observing',
      'applied',
      'rollback-stop',
      'rolled-back',
      'blocked',
      'failed',
      'unconfirmed',
    ]),
    targetVersion: z.string().min(1),
    previousVersion: z.string().min(1),
  })
  .strict();
export type ManagedDaemonUpdateStatus = z.infer<typeof ManagedDaemonUpdateStatusSchema>;
