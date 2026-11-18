import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import {
  rendererFlockGroupAckSchema,
  rendererFlockGroupKey,
  rendererFlockGroupRegistrationSchema,
  rendererFlockGroupRequestSchema,
  type RendererFlockGroupRegistration,
} from '@lody/shared/renderer-flock-room-group';
import type { RendererFlockRoomGroupFreeze } from './renderer-flock-room-group-freeze';

/** Main derives the complete room set. Install both listeners before ready may
 * start the all-window freeze; a late response only retires its exact ticket. */
export type RendererFlockRoomGroupIpcOptions = {
  accountId: string;
  workspaceId: string;
  signal?: AbortSignal;
  create(owner: RendererFlockGroupRegistration): RendererFlockRoomGroupFreeze;
};
export const startElectronRendererMachineFlock = (options: RendererFlockRoomGroupIpcOptions) =>
  startElectronRendererFlockRoomGroup('machine', options);
export const startElectronRendererScheduleRegistry = (options: RendererFlockRoomGroupIpcOptions) =>
  startElectronRendererFlockRoomGroup('schedule', options);
async function startElectronRendererFlockRoomGroup(
  domain: 'machine' | 'schedule',
  options: RendererFlockRoomGroupIpcOptions
) {
  if (typeof window === 'undefined' || window.__LODY_ELECTRON__ !== true) return null;
  const services = getIpcServices();
  if (!services) return null;
  const protocol =
    domain === 'machine'
      ? {
          request: 'localPlatform.machineFlockMigration' as const,
          owner: 'localPlatform.machineFlockOwner' as const,
          register: () => services.localPlatform.registerMachineFlock(),
          ready: (id: string) => services.localPlatform.readyMachineFlock(id),
          acknowledge: (
            ack: Parameters<typeof services.localPlatform.acknowledgeMachineFlock>[0]
          ) => services.localPlatform.acknowledgeMachineFlock(ack),
          retire: (id: string) => services.localPlatform.retireMachineFlock(id),
        }
      : {
          request: 'localPlatform.scheduleRegistryMigration' as const,
          owner: 'localPlatform.scheduleRegistryOwner' as const,
          register: () => services.localPlatform.registerScheduleRegistry(),
          ready: (id: string) => services.localPlatform.readyScheduleRegistry(id),
          acknowledge: (
            ack: Parameters<typeof services.localPlatform.acknowledgeScheduleRegistry>[0]
          ) => services.localPlatform.acknowledgeScheduleRegistry(ack),
          retire: (id: string) => services.localPlatform.retireScheduleRegistry(id),
        };
  let registration: RendererFlockGroupRegistration | undefined;
  let gate: RendererFlockRoomGroupFreeze | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const detach = onIpcEvent(protocol.request, (value) => {
    const parsed = rendererFlockGroupRequestSchema.safeParse(value);
    if (!parsed.success || parsed.data.registrationId !== registration?.registrationId || !gate)
      return;
    const request = parsed.data;
    const work = (async () => {
      let ack;
      try {
        if (closed) throw new Error('Room group registration retired');
        ack = await gate!.handle(request);
      } catch {
        ack = {
          ...request,
          failure: closed
            ? ('owner_retired' as const)
            : request.phase === 'freeze'
              ? ('drain_failed' as const)
              : ('capture_failed' as const),
        };
      }
      await protocol.acknowledge(rendererFlockGroupAckSchema.parse(ack));
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
  });
  const detachOwner = onIpcEvent(protocol.owner, (value) => {
    const parsed = rendererFlockGroupRegistrationSchema.safeParse(value);
    if (closed || !parsed.success || parsed.data.registrationId !== registration?.registrationId)
      return;
    gate?.published(parsed.data);
  });
  const acquisition = protocol.register().then((value) => {
    if (value === null) return null;
    registration = rendererFlockGroupRegistrationSchema.parse(value);
    return registration;
  });
  const close = () => {
    if (closing) return closing;
    closed = true;
    detach();
    detachOwner();
    options.signal?.removeEventListener('abort', abort);
    closing = (async () => {
      const owner = await acquisition;
      if (owner) await protocol.retire(owner.registrationId);
      const settled = await Promise.allSettled([...pending, ...(gate ? [gate.close()] : [])]);
      const errors = settled.flatMap((value) =>
        value.status === 'rejected' ? [value.reason] : []
      );
      if (errors.length)
        throw new AggregateError(errors, 'Room group renderer release unconfirmed');
    })().catch((error) => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
  const abort = () => {
    void close().catch(() => {});
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const owner = await acquisition;
    if (!owner) {
      await close();
      return null;
    }
    if (closed)
      throw options.signal?.reason ?? new Error('Room group renderer registration retired');
    if (
      owner.group.domain !== domain ||
      owner.group.accountId !== options.accountId ||
      owner.group.workspaceId !== options.workspaceId
    )
      throw new Error('Room group startup binding mismatch');
    gate = options.create(owner);
    gate.bindRegistration(owner.registrationId);
    await gate.startup();
    const ready = rendererFlockGroupRegistrationSchema.parse(
      await protocol.ready(owner.registrationId)
    );
    if (
      closed ||
      ready.registrationId !== owner.registrationId ||
      rendererFlockGroupKey(ready.group) !== rendererFlockGroupKey(owner.group)
    )
      throw new Error('Room group ready binding retired');
    // A frozen recovery can become native during ready; main publication already
    // supplies the exact frozen revision, never a fresh legacy admission.
    if (ready.owner === 'native' && gate.ownerKind() !== 'native') gate.published(ready);
    return { gate, registrationId: owner.registrationId, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Room group renderer startup/release failed');
    }
    throw error;
  }
}
