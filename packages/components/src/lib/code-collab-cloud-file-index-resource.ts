import {
  CloudFileIndexIpcError,
  cloudFileIndexEventSchema,
  cloudFileIndexObservedSchema,
  cloudFileIndexCanceledSchema,
  cloudFileIndexReleasedSchema,
  type CloudFileIndexEvent,
  type CloudFileIndexRelease,
} from '@lody/shared/cloud-file-index-ipc';
import type { CloudFileIndexIpc } from '../../../../apps/electron/src/main/ipc/services/cloud-file-index-ipc';
import { getIpcServices, onIpcEvent } from './electron-ipc-client';
import { jsonValueEqual } from './json-value-equal';
import type {
  CodeCollabFileIndexLoadState,
  CodeCollabFileIndexOwnedResource,
} from './code-collab-file-index-cache';

type Transport = Pick<CloudFileIndexIpc, 'observe' | 'cancel' | 'unobserve'> & {
  onSnapshot(listener: (event: CloudFileIndexEvent) => void): () => void;
};
export class CloudFileIndexCleanupError extends CloudFileIndexIpcError {
  constructor(readonly retryCleanup: () => Promise<void>) {
    super('cleanup_unconfirmed');
  }
}
/** Ordinary Cloud only. Main selects the authenticated whole FI/FIS pair; the
 * renderer holds a read-only snapshot and never imports a native SDK or Flock. */
export async function openCloudCodeCollabFileIndexResource(options: {
  workspaceId: string;
  ownerSessionId: string;
  onFailure(): void;
  transport?: Transport;
  timeoutMs?: number;
}): Promise<CodeCollabFileIndexOwnedResource | null> {
  const transport: Transport | undefined =
    options.transport ??
    (() => {
      const service = getIpcServices()?.cloudFileIndex;
      return service
        ? {
            observe: (input) => service.observe(input),
            cancel: (input) => service.cancel(input),
            unobserve: (input) => service.unobserve(input),
            onSnapshot: (listener) => onIpcEvent('cloudFileIndex.snapshot', listener),
          }
        : undefined;
    })();
  if (!transport) throw new CloudFileIndexIpcError();
  const request = {
    workspaceId: options.workspaceId,
    ownerSessionId: options.ownerSessionId,
    requestId: crypto.randomUUID(),
  };
  const resourceKey = {};
  let revision = 0;
  let firstSnapshot = false;
  let state: CodeCollabFileIndexLoadState = { status: 'loading' };
  let released = false;
  let retired = false;
  let native: CloudFileIndexRelease | undefined;
  let pending: CloudFileIndexEvent | undefined;
  let closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: CodeCollabFileIndexLoadState) => {
    if (retired) return;
    state = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* One view cannot break other index borrowers. */
      }
    }
  };
  const fail = (
    code:
      | 'access_denied'
      | 'restart_required'
      | 'unavailable'
      | 'invalid_request'
      | 'cleanup_unconfirmed'
  ) => {
    options.onFailure();
    publish({ status: 'error', error: new CloudFileIndexIpcError(code) });
  };
  const apply = (event: CloudFileIndexEvent) => {
    if (
      retired ||
      !native ||
      event.leaseId !== native.leaseId ||
      event.generation !== native.generation
    )
      return;
    if (event.state.status === 'error') {
      firstSnapshot = false;
      fail(event.state.code);
      return;
    }
    if (event.state.status === 'loading') {
      firstSnapshot = false;
      publish({ status: 'loading' });
      return;
    }
    firstSnapshot = true;
    if (
      state.status === 'ready' &&
      jsonValueEqual(state.snapshot.fileIndex, event.state.fileIndex) &&
      jsonValueEqual(state.snapshot.generations, event.state.generations)
    )
      return;
    publish({
      status: 'ready',
      snapshot: {
        resourceKey,
        fileIndex: event.state.fileIndex,
        generations: event.state.generations,
        updatedAtMs: event.state.updatedAtMs,
        revision: ++revision,
      },
    });
  };
  const stop = transport.onSnapshot((value) => {
    const parsed = cloudFileIndexEventSchema.safeParse(value);
    if (!parsed.success) return;
    const event = parsed.data;
    if (
      event.requestId !== request.requestId ||
      event.workspaceId !== request.workspaceId ||
      event.ownerSessionId !== request.ownerSessionId ||
      retired
    )
      return;
    if (!native) pending = event;
    else apply(event);
  });
  async function bounded<T>(work: Promise<T>, opening = false): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                opening
                  ? new CloudFileIndexIpcError('unavailable')
                  : new CloudFileIndexCleanupError(dispose)
              ),
            options.timeoutMs ?? 10000
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function dispose(): Promise<void> {
    retired = true;
    stop();
    listeners.clear();
    pending = undefined;
    if (released) return;
    if (closing) return closing;
    closing = bounded(
      (async () => {
        // cancel fences an acquisition whose reply was lost or is still pending.
        if (native) cloudFileIndexReleasedSchema.parse(await transport!.unobserve(native));
        else cloudFileIndexCanceledSchema.parse(await transport!.cancel(request));
        released = true;
      })()
    )
      .catch(() => {
        throw new CloudFileIndexCleanupError(dispose);
      })
      .finally(() => {
        closing = undefined;
      });
    return closing;
  }
  try {
    const reply = cloudFileIndexObservedSchema.parse(
      await bounded(transport.observe(request), true)
    );
    if (reply.backend === 'legacy') {
      released = true;
      retired = true;
      stop();
      return null;
    }
    if (
      reply.requestId !== request.requestId ||
      reply.workspaceId !== request.workspaceId ||
      reply.ownerSessionId !== request.ownerSessionId
    )
      throw new CloudFileIndexIpcError('access_denied');
    native = { ...request, leaseId: reply.leaseId, generation: reply.generation };
    if (pending) {
      apply(pending);
      pending = undefined;
    }
    return {
      backend: 'native',
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      seed(fileIndex, updatedAtMs) {
        if (firstSnapshot || retired || state.status === 'error') return;
        publish({
          status: 'ready',
          snapshot: { resourceKey, fileIndex, updatedAtMs, revision: ++revision },
        });
      },
      dispose,
    };
  } catch (error) {
    options.onFailure();
    await dispose();
    throw error instanceof CloudFileIndexIpcError ? error : new CloudFileIndexIpcError();
  }
}
