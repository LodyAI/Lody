import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import {
  rendererSessionBodyRequestSchema,
  type RendererSessionBodyAck,
} from '@lody/shared/renderer-session-body-migration';
import { RendererSessionBodyFreeze } from './renderer-session-body-migration';
/** Register before any legacy Session store, body bootstrap or transport opens. */
export async function startElectronRendererSessionBodyMigration(options: {
  registrationId: string;
  gate: RendererSessionBodyFreeze;
  deferReady?: boolean;
  onFailure?(error: unknown): void;
}) {
  const services = getIpcServices();
  if (!services) throw new Error('Session body migration unavailable');
  const migration = services.sessionBodyMigration;
  const registration = await migration.register({ registrationId: options.registrationId });
  options.gate.bind(registration);
  let retired = false,
    closing: Promise<void> | undefined,
    confirmed = false;
  const active = new Set<Promise<unknown>>();
  const detach = onIpcEvent('sessionBodyMigration.request', (input) => {
    if (retired || input.registrationId !== options.registrationId) return;
    const request = rendererSessionBodyRequestSchema.parse(input);
    const work = (async () => {
      let ack: RendererSessionBodyAck;
      try {
        ack = await options.gate.handle(request);
      } catch (error) {
        options.onFailure?.(error);
        ack = {
          ...request,
          failure: retired
            ? 'owner_retired'
            : request.phase === 'capture'
              ? 'capture_failed'
              : 'drain_failed',
        };
      }
      await migration.acknowledge(ack);
    })();
    active.add(work);
    void work.finally(() => active.delete(work)).catch((error) => options.onFailure?.(error));
  });
  const close = () => {
    retired = true;
    options.gate.retire();
    detach();
    if (confirmed) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => {
      const settled = await Promise.allSettled([...active]);
      if (settled.some((result) => result.status === 'rejected'))
        throw new Error('Session body freeze cleanup unconfirmed');
      const receipt = await migration.retire({ registrationId: options.registrationId });
      if (receipt.retired !== true) throw new Error('Session migration retirement unconfirmed');
      confirmed = true;
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  let readiness: Promise<void> | undefined;
  const ready = () => {
    if (retired) return Promise.reject(new Error('Session migration registration retired'));
    readiness ??= migration.ready({ registrationId: options.registrationId }).then((receipt) => {
      if (retired || receipt.ready !== true)
        throw new Error('Session migration readiness unconfirmed');
    });
    return readiness;
  };
  try {
    if (!options.deferReady) await ready();
    return { gate: options.gate, registration, ready, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Session migration startup cleanup unconfirmed');
    }
    throw error;
  }
}
