import { getIpcServices, onIpcEvent } from '../lib/electron-ipc-client';
import {
  rendererFlockGroupAckSchema,
  rendererFlockGroupKey,
  rendererFlockGroupRegistrationSchema,
  rendererFlockGroupRequestSchema,
  type RendererFlockGroupRegistration,
} from '@lody/shared/renderer-flock-room-group';
import type { RendererFlockRoomGroupFreeze } from './renderer-flock-room-group-freeze';

/** Startup-only: install before constructing a legacy Repo or its Meta writer.
 * Main derives the complete room set. Install both listeners before ready may
 * start the all-window freeze; a late response only retires its exact ticket. */
export async function startElectronRendererWorkspaceMeta(options: {
  accountId: string;
  workspaceId: string;
  signal?: AbortSignal;
  create(owner: RendererFlockGroupRegistration): RendererFlockRoomGroupFreeze;
}) {
  if (typeof window === 'undefined' || window.__LODY_ELECTRON__ !== true) return null;
  const services = getIpcServices();
  if (!services) return null;
  let registration: RendererFlockGroupRegistration | undefined;
  let gate: RendererFlockRoomGroupFreeze | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const detach = onIpcEvent('localPlatform.workspaceMetaMigration', (value) => {
    const parsed = rendererFlockGroupRequestSchema.safeParse(value);
    if (!parsed.success || parsed.data.registrationId !== registration?.registrationId || !gate)
      return;
    const request = parsed.data;
    const work = (async () => {
      let ack;
      try {
        if (closed) throw new Error('Meta registration retired');
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
      await services.localPlatform.acknowledgeWorkspaceMeta(rendererFlockGroupAckSchema.parse(ack));
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => {});
  });
  const detachOwner = onIpcEvent('localPlatform.workspaceMetaOwner', (value) => {
    const parsed = rendererFlockGroupRegistrationSchema.safeParse(value);
    if (closed || !parsed.success || parsed.data.registrationId !== registration?.registrationId)
      return;
    gate?.published(parsed.data);
  });
  const acquisition = services.localPlatform.registerWorkspaceMeta().then((value) => {
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
      if (owner) await services.localPlatform.retireWorkspaceMeta(owner.registrationId);
      const settled = await Promise.allSettled([...pending, ...(gate ? [gate.close()] : [])]);
      const errors = settled.flatMap((value) =>
        value.status === 'rejected' ? [value.reason] : []
      );
      if (errors.length) throw new AggregateError(errors, 'Meta renderer release unconfirmed');
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
    if (closed) throw options.signal?.reason ?? new Error('Meta renderer registration retired');
    if (
      owner.group.domain !== 'meta' ||
      owner.group.accountId !== options.accountId ||
      owner.group.workspaceId !== options.workspaceId
    )
      throw new Error('Meta startup binding mismatch');
    gate = options.create(owner);
    gate.bindRegistration(owner.registrationId);
    await gate.startup();
    const ready = rendererFlockGroupRegistrationSchema.parse(
      await services.localPlatform.readyWorkspaceMeta(owner.registrationId)
    );
    if (
      closed ||
      ready.registrationId !== owner.registrationId ||
      rendererFlockGroupKey(ready.group) !== rendererFlockGroupKey(owner.group)
    )
      throw new Error('Meta ready binding retired');
    if (ready.owner !== 'native')
      throw new Error('Meta startup requires the completed native owner');
    // A frozen recovery can become native during ready; main publication already
    // supplies the exact frozen revision, never a fresh legacy admission.
    if (ready.owner === 'native' && gate.ownerKind() !== 'native') gate.published(ready);
    return { gate, registrationId: owner.registrationId, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Meta renderer startup/release failed');
    }
    throw error;
  }
}
