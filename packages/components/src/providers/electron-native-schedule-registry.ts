import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import { createNativeScheduleRegistryIpc } from './native-schedule-registry-ipc';
import {
  ScheduleRegistryIpcError,
  scheduleRegistryIpcErrorCodeSchema,
} from '@lody/shared/schedule-registry-ipc';
type Options = Omit<Parameters<typeof createNativeScheduleRegistryIpc>[0], 'transport' | 'listen'>;
/** Only a trusted main-selected SR registration admits this source. */
export function createElectronNativeScheduleRegistry(options: Options) {
  const services = getIpcServices();
  if (!services) throw new ScheduleRegistryIpcError('unavailable');
  const registry = services.scheduleRegistry;
  const invoke = async <A>(method: string, work: () => Promise<A>): Promise<A> => {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const prefix = `Error invoking remote method 'scheduleRegistry.${method}': `;
      const detail = message.startsWith(prefix) ? message.slice(prefix.length) : '';
      const parsed = scheduleRegistryIpcErrorCodeSchema.safeParse(
        detail.match(/^(?:Error|ScheduleRegistryIpcError): schedule_registry_([a-z_]+)$/)?.[1]
      );
      throw new ScheduleRegistryIpcError(parsed.success ? parsed.data : 'operation_failed');
    }
  };
  return createNativeScheduleRegistryIpc({
    ...options,
    transport: {
      read: (request) => invoke('read', () => registry.read(request)),
      execute: (request) => invoke('execute', () => registry.execute(request)),
      flush: (request) => invoke('flush', () => registry.flush(request)),
      observe: (request) => invoke('observe', () => registry.observe(request)),
      unobserve: (request) => invoke('unobserve', () => registry.unobserve(request)),
      cancelObservation: (request) =>
        invoke('cancelObservation', () => registry.cancelObservation(request)),
    },
    listen: (receive) => onIpcEvent('scheduleRegistry.event', receive),
  });
}
