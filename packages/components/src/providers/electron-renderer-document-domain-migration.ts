import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import {
  rendererDocumentDomainRequestSchema,
  type RendererDocumentDomainAck,
} from '@lody/shared/renderer-document-domain-migration';
import {
  nativeDocumentDomainCreateScheduleSchema,
  nativeDocumentDomainEnsurePreviewSchema,
  parseNativeDocumentDomainInput,
  type NativeDocumentDomainTarget,
} from '@lody/shared/native-document-domain-ipc';
import type { ScheduleSaveInput } from '@lody/shared';
import type { SessionId } from '@lody/shared/ids';
import { RendererDocumentDomainFreeze } from './renderer-document-domain-migration';
/** Bind before opening any old Preview/Schedule store, Repo or room transport. */
export async function startElectronRendererDocumentDomainMigration(options: {
  registrationId: string;
  gate: RendererDocumentDomainFreeze;
  deferReady?: boolean;
  onFailure?(error: unknown): void;
}) {
  const services = getIpcServices();
  if (!services) throw new Error('Document domain migration unavailable');
  const service = services.documentDomainMigration;
  const registration = await service.register({ registrationId: options.registrationId });
  options.gate.bind(registration);
  let retired = false,
    confirmed = false,
    closing: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const detach = onIpcEvent('documentDomainMigration.request', (input) => {
    if (retired || input.registrationId !== options.registrationId) return;
    const request = rendererDocumentDomainRequestSchema.parse(input);
    const work = (async () => {
      let ack: RendererDocumentDomainAck;
      try {
        ack = await options.gate.handle(request);
      } catch (error) {
        if (typeof window !== 'undefined' && '__LODY_E2E_BOOT__' in window) {
          const codes = new Map([
            ['Legacy Meta Flock is unavailable in external metadata mode', 'legacy_meta_forbidden'],
            ['Legacy document author is frozen', 'legacy_room_frozen'],
            ['Unsupported document IndexedDB layout', 'source_layout'],
            ['Complete document source exceeds budget', 'source_budget'],
          ]);
          const code =
            error instanceof Error
              ? error.name === 'ResourceBusyError'
                ? 'resource_busy'
                : (codes.get(error.message) ?? 'unavailable')
              : 'unavailable';
          console.warn(`[native-document-domain-window] phase=${request.phase} code=${code}`);
        }
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
      const receipt = await service.acknowledge(ack);
      if (receipt.acknowledged !== true)
        throw new Error('Document freeze acknowledgement unconfirmed');
    })();
    active.add(work);
    void work.finally(() => active.delete(work)).catch((error) => options.onFailure?.(error));
  });
  const close = (): Promise<void> => {
    retired = true;
    options.gate.retire();
    detach();
    if (confirmed) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => {
      const results = await Promise.allSettled([...active]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Document freeze cleanup unconfirmed');
      const receipt = await service.retire({ registrationId: options.registrationId });
      if (receipt.retired !== true) throw new Error('Document migration retirement unconfirmed');
      confirmed = true;
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  let readiness: Promise<void> | undefined;
  const ready = () => {
    if (retired) return Promise.reject(new Error('Document migration retired'));
    readiness ??= service.ready({ registrationId: options.registrationId }).then((receipt) => {
      if (retired || receipt.ready !== true)
        throw new Error('Document migration readiness unconfirmed');
    });
    return readiness;
  };
  const migrate = async (target: NativeDocumentDomainTarget) => {
    if (retired) throw new Error('Document migration retired');
    const receipt = await service.migrate({ registrationId: options.registrationId, target });
    if (retired || receipt.migrated !== true)
      throw new Error('Document migration completion unconfirmed');
  };
  try {
    if (!options.deferReady) await ready();
    const ensurePreview = async (sessionId: SessionId) => {
      if (retired || registration.creationEnabled !== true)
        throw new Error('Native leaf creation unavailable');
      const receipt = await service.ensurePreview(
        parseNativeDocumentDomainInput(nativeDocumentDomainEnsurePreviewSchema, {
          registrationId: options.registrationId,
          requestId: crypto.randomUUID(),
          target: { domain: 'preview_comments', id: sessionId },
        })
      );
      if (retired || receipt.created !== true)
        throw new Error('Native Preview creation unconfirmed');
    };
    const createSchedule = async (input: ScheduleSaveInput) => {
      if (retired || registration.creationEnabled !== true)
        throw new Error('Native leaf creation unavailable');
      const receipt = await service.createSchedule(
        parseNativeDocumentDomainInput(nativeDocumentDomainCreateScheduleSchema, {
          registrationId: options.registrationId,
          requestId: crypto.randomUUID(),
          target: { domain: 'schedule_definition', id: input.scheduleId },
          draft: input.draft,
          now: input.now,
          activationId: input.activationId,
          activityId: input.activityId,
        })
      );
      if (retired || receipt.created !== true)
        throw new Error('Native Schedule creation unconfirmed');
    };
    return {
      gate: options.gate,
      registration,
      ready,
      migrate,
      ensurePreview,
      createSchedule,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Document migration startup cleanup unconfirmed');
    }
    throw error;
  }
}
