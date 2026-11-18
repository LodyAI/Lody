import { createHash } from 'node:crypto';
import type { SessionMeta } from '../schema';
import type { SessionId } from '../ids';
import type { WorkspaceId } from '../ids';
import { NativeSessionIpcError } from '../native-session-ipc';
import type { NativeSessionDomainPort } from '../native-session-domain';
import type {
  NativeSessionDocumentFactory,
  NativeSessionDocumentOwner,
} from './native-session-document';
import { NativeSessionOwnerCleanupError } from './native-session-document-owner';
import {
  createNativeSessionDomainService,
  type NativeSessionSnapshotRegistry,
} from './native-session-domain-service';

/** Supplied by the actual whole-workspace native Meta grant. It is private to
 * Node composition: a renderer receipt or a daemon proxy is not this owner. */
export type NativeSessionMetadataOwner = {
  readonly owner: 'native';
  readonly binding: { readonly accountId: string; readonly workspaceId: WorkspaceId };
  readonly generation: string;
  assertCurrent(): void;
  document(roomId: string): {
    read(): Promise<Record<string, unknown> | undefined>;
    patch(fields: Record<string, unknown | undefined>): Promise<void>;
    update(
      transform: (current: Record<string, unknown>) => Record<string, unknown> | undefined
    ): Promise<void>;
    flush(): Promise<void>;
  };
};
/** Creates one real Session lease for main. Body and Meta stay separate domain
 * owners on the shared engine; this grant never opens a legacy Repo or sqlite. */
export async function acquireNativeSessionDomainGrant(options: {
  readonly factory: NativeSessionDocumentFactory;
  readonly metadata: NativeSessionMetadataOwner;
  readonly sessionId: SessionId;
  /** Main derives this from its trusted window registration/workspace epoch. */
  readonly scopeGeneration: string;
  /** Immutable captures belong to the authorization scope, independent of source/engine lifetime. */
  readonly snapshotRealm?: string;
  readonly snapshotScope?: { windowId: number; registrationId: string };
  readonly principalId: string;
  readonly snapshots: NativeSessionSnapshotRegistry;
  assertCurrent(): void;
}): Promise<{
  readonly generation: string;
  readonly domain: NativeSessionDomainPort;
  assertCurrent(): void;
  release(): Promise<void>;
}> {
  const { factory, metadata } = options;
  const snapshotRealm = options.snapshotRealm ?? options.scopeGeneration;
  if (options.snapshotScope)
    options.snapshots.bindRealm(snapshotRealm, {
      ...options.snapshotScope,
      workspaceId: factory.binding.workspaceId,
    });
  if (
    metadata.owner !== 'native' ||
    factory.binding.accountId !== metadata.binding.accountId ||
    factory.binding.workspaceId !== metadata.binding.workspaceId
  )
    throw new NativeSessionIpcError('access_denied');
  let body: NativeSessionDocumentOwner | undefined;
  const metaGeneration = metadata.generation;
  const check = () => {
    options.assertCurrent();
    metadata.assertCurrent();
    body?.assertCurrent();
    if (metadata.generation !== metaGeneration) throw new NativeSessionIpcError('restart_required');
  };
  check();
  if (!(await factory.ownsRoom(`session-${options.sessionId}`)))
    throw new NativeSessionIpcError('access_denied');
  check();
  const facet = metadata.document(`session-${options.sessionId}`);
  const activeMetadata = await facet.read();
  check();
  if (!activeMetadata || activeMetadata.historyBackend === 'roost')
    throw new NativeSessionIpcError('access_denied');
  try {
    body = await factory(
      options.sessionId,
      {
        read: async () => {
          check();
          const row = await facet.read();
          check();
          return row as SessionMeta | undefined;
        },
        patch: async (fields) => {
          check();
          await facet.patch(fields);
          check();
        },
        update: async (transform) => {
          check();
          await facet.update((current) => {
            check();
            return transform(current as SessionMeta);
          });
          check();
        },
        flush: async () => {
          check();
          await facet.flush();
          check();
        },
      },
      { historyBackend: 'loro' }
    );
    check();
    if (!body) throw new NativeSessionIpcError('restart_required');
    await body.initialize(undefined, { skipAutoRead: true, remoteSync: false });
    check();
  } catch (error) {
    if (body) {
      try {
        await body.close();
      } catch (cleanup) {
        throw new NativeSessionOwnerCleanupError([error, cleanup], () => body!.close());
      }
    }
    throw error;
  }
  const owned = body;
  if (!owned) throw new NativeSessionIpcError('restart_required');
  const generation = createHash('sha256')
    .update(JSON.stringify([options.scopeGeneration, owned.generation, metaGeneration]))
    .digest('hex');
  let retired = false;
  const assertCurrent = () => {
    if (retired) throw new NativeSessionIpcError('restart_required');
    check();
  };
  const domain = createNativeSessionDomainService({
    owner: owned,
    generation,
    principalId: options.principalId,
    snapshots: options.snapshots,
    snapshotRealm,
    assertCurrent,
  });
  let closing: Promise<void> | undefined;
  const grant = {
    generation,
    domain,
    assertCurrent,
    release(): Promise<void> {
      retired = true;
      if (closing) return closing;
      closing = (async () => {
        const failures: unknown[] = [];
        try {
          domain.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await owned.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length)
          throw new NativeSessionOwnerCleanupError(failures, () => grant.release());
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    },
  };
  return grant;
}
