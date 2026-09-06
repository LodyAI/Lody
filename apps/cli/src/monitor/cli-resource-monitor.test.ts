import { expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';
import { CliResourceMonitor } from './cli-resource-monitor';

it('reads history without probing and records unavailable samples without private errors', async () => {
  const listMonitorSessions = vi.fn(async () => {
    throw new Error('private diagnostics');
  });
  const monitor = new CliResourceMonitor(
    'machine' as MachineId,
    { listMonitorSessions } as never,
    {} as never,
    { getLatest: async () => ({}) } as never,
    { debug: () => {} } as never
  );
  expect(monitor.getHistory().samples).toEqual([]);
  expect(listMonitorSessions).not.toHaveBeenCalled();
  await expect(monitor.sample()).rejects.toThrow('private diagnostics');
  const history = monitor.getHistory();
  expect(history.samples[0]?.source).toBe('unavailable');
  expect(JSON.stringify(history)).not.toContain('private diagnostics');
  expect(listMonitorSessions).toHaveBeenCalledOnce();
});
