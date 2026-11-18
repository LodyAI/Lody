import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import { createNativeMachineCatalogIpc } from './native-machine-catalog-ipc';
import {
  MachineCatalogIpcError,
  machineCatalogIpcErrorCodeSchema,
} from '@lody/shared/machine-catalog-ipc';

type Options = Omit<Parameters<typeof createNativeMachineCatalogIpc>[0], 'transport' | 'listen'>;

/** Construction requires a main-owned selected-MF registration. Merely having
 * Electron IPC available does not enable native storage or select a backend. */
export function createElectronNativeMachineCatalog(options: Options) {
  const services = getIpcServices();
  if (!services) throw new Error('Machine catalog IPC unavailable');
  const catalog = services.machineCatalog;
  // Electron serializes the message, not custom Error properties. Accept only
  // our exact channel/code envelope; never expose a backend cause to settings.
  const invoke = async <T>(method: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const prefix = `Error invoking remote method 'machineCatalog.${method}': `;
      const detail = message.startsWith(prefix) ? message.slice(prefix.length) : '';
      const code = detail.match(
        /^(?:Error|MachineCatalogIpcError): machine_catalog_([a-z_]+)$/
      )?.[1];
      const parsed = machineCatalogIpcErrorCodeSchema.safeParse(code);
      throw new MachineCatalogIpcError(parsed.success ? parsed.data : 'operation_failed');
    }
  };
  return createNativeMachineCatalogIpc({
    ...options,
    transport: {
      readMachineCatalog: (request) => invoke('read', () => catalog.read(request)),
      beginMachineAgentConfigEdit: (request) =>
        invoke('beginAgentConfigEdit', () => catalog.beginAgentConfigEdit(request)),
      executeMachineCatalog: (request) => invoke('execute', () => catalog.execute(request)),
      uploadMachineCatalog: (request) => invoke('upload', () => catalog.upload(request)),
      observeMachineCatalog: (request) => invoke('observe', () => catalog.observe(request)),
      unobserveMachineCatalog: (request) => invoke('unobserve', () => catalog.unobserve(request)),
      cancelMachineCatalogObservation: (request) =>
        invoke('cancelObservation', () => catalog.cancelObservation(request)),
    },
    listen: (receive) => onIpcEvent('machineCatalog.event', receive),
  });
}
