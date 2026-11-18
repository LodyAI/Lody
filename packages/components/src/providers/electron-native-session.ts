import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import {
  NativeSessionIpcError,
  nativeSessionIpcErrorCodeSchema,
} from '@lody/shared/native-session-ipc';
import type { NativeSessionDomainTransport } from '@lody/shared/native-session-domain';
import { createNativeSessionStoreOwner } from './native-session-store';

type StoreOptions = Parameters<typeof createNativeSessionStoreOwner>[0];
type Options = Omit<StoreOptions, 'transport' | 'route'> & {
  readonly route?: StoreOptions['route'];
};
/** A main-owned registration and explicit persistent route are required.
 * Electron availability alone cannot enable native bodies or migrate a room. */
export function createElectronNativeSessionStoreOwner(options: Options) {
  const services = getIpcServices();
  if (!services) throw new NativeSessionIpcError('unavailable');
  const sessions = services.nativeSession;
  const invoke = async <A>(method: string, operation: () => Promise<A>): Promise<A> => {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const prefix = `Error invoking remote method 'nativeSession.${method}': `;
      const detail = message.startsWith(prefix) ? message.slice(prefix.length) : '';
      const code = detail.match(/^(?:Error|NativeSessionIpcError): native_session_([a-z_]+)$/)?.[1];
      const parsed = nativeSessionIpcErrorCodeSchema.safeParse(code);
      throw new NativeSessionIpcError(parsed.success ? parsed.data : 'operation_failed');
    }
  };
  const transport: NativeSessionDomainTransport = {
    read: (request) => invoke('read', () => sessions.read(request)),
    execute: (request) => invoke('execute', () => sessions.execute(request)),
    observe: (request) => invoke('observe', () => sessions.observe(request)),
    unobserve: (request) => invoke('unobserve', () => sessions.unobserve(request)),
    cancelObservation: (request) =>
      invoke('cancelObservation', () => sessions.cancelObservation(request)),
    subscribe: (listener) => onIpcEvent('nativeSession.event', listener),
  };
  return createNativeSessionStoreOwner({
    ...options,
    transport,
    route:
      options.route ??
      (async (sessionId) =>
        (
          await invoke('route', () =>
            sessions.route({
              registrationId: options.registrationId,
              requestId: options.requestId(),
              sessionId,
            })
          )
        ).owner),
  });
}
