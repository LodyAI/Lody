import {
  NativeDocumentDomainIpcError,
  nativeDocumentDomainErrorCodeSchema,
  type NativeDocumentDomainTarget,
} from '@lody/shared/native-document-domain-ipc';
import type { ScheduleDefinitionResolver } from '@lody/shared';
import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import { createNativeDocumentDomainClient } from './native-document-domain-ipc';

export function createElectronNativeDocumentDomainClient(options: {
  registrationId: string;
  target: NativeDocumentDomainTarget;
}) {
  const services = getIpcServices();
  if (!services) throw new NativeDocumentDomainIpcError('unavailable');
  const service = services.documentDomains;
  const invoke = async <A>(method: string, work: () => Promise<A>): Promise<A> => {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const prefix = `Error invoking remote method 'documentDomains.${method}': `;
      const code = (message.startsWith(prefix) ? message.slice(prefix.length) : '').match(
        /^(?:Error|NativeDocumentDomainIpcError): native_document_domain_([a-z_]+)$/
      )?.[1];
      const parsed = nativeDocumentDomainErrorCodeSchema.safeParse(code);
      throw new NativeDocumentDomainIpcError(parsed.success ? parsed.data : 'unavailable');
    }
  };
  return createNativeDocumentDomainClient({
    ...options,
    transport: {
      readNativeDocumentDomainRoute: (request) => invoke('route', () => service.route(request)),
      readNativeDocumentDomain: (request) => invoke('read', () => service.read(request)),
      executeNativeDocumentDomain: (request) => invoke('execute', () => service.execute(request)),
      observeNativeDocumentDomain: (request) => invoke('observe', () => service.observe(request)),
      async unobserveNativeDocumentDomain(request) {
        const receipt = await invoke('unobserve', () => service.unobserve(request));
        if (receipt.released !== true)
          throw new NativeDocumentDomainIpcError('cleanup_unconfirmed');
      },
      cancelNativeDocumentDomain: (request) => invoke('cancel', () => service.cancel(request)),
    },
    listen: (listener) => onIpcEvent('documentDomains.event', listener),
  });
}
/** Every open obtains a positive passive route. Failed or missing native reads
 * never cause a legacy Mirror/SDK fallback. Nonobserving command ports hold no
 * renderer listener, native SDK handle or saved credential. */
export function createElectronNativeScheduleDefinitionResolver(options: {
  registrationId: string;
}): ScheduleDefinitionResolver {
  return {
    async resolve(scheduleId) {
      const source = createElectronNativeDocumentDomainClient({
        ...options,
        target: { domain: 'schedule_definition', id: scheduleId },
      });
      const owner = await source.route();
      if (owner === 'legacy') {
        await source.close();
        return undefined;
      }
      if (owner !== 'native') {
        await source.close();
        throw new NativeDocumentDomainIpcError('restart_required');
      }
      return source.definition;
    },
  };
}
