import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import type { SessionOwnerTransport } from './shared-session-client';

/** Composition selects this once; owner failures never create an independent writer. */
export async function getElectronSessionOwnerTransport(): Promise<
  SessionOwnerTransport | undefined
> {
  const service = getIpcServices()?.sessionOwner;
  if (!service) return undefined;
  const config = await service.config();
  if (!config.enabled) return undefined;
  return {
    request: async (request) => {
      const result = await service.request(request);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    subscribe: (listener) => onIpcEvent('sessionOwner.event', listener),
  };
}
