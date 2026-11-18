import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalUserId, isLocalWorkspaceId } from '@lody/shared/platform-kind';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { createNativeWorkspaceMeta } from '@lody/shared/node/native-workspace-meta';
import { createNativeWorkspaceDirectory } from '@lody/shared/node/native-workspace-directory';
import { getCliNodeExecutable } from '../managed-daemon-release';
import { toShared } from '@/platform/process-options';
import { readLocalFlockGroupOwner } from './native-schedule-registry-owner';
import { LoroRepo, type LoroRepoOptions } from 'loro-repo';
const selection = { domain: 'meta' as const, room: { kind: 'meta' as const, id: 'meta' } };
export type NativeLocalWorkspaceMetaLegacy = NonNullable<
  Awaited<ReturnType<typeof openNativeLocalWorkspaceMetaLegacy>>
>;
export const readLocalWorkspaceMetaOwner = (options: {
  dataRoot: string;
  accountId: string;
  workspaceId: string;
}) => readLocalFlockGroupOwner(options, selection);

/** Named SDK factory proof, never an unknown option on legacy create(). */
export function assertLegacyRepoExternalMetadataCapability(): void {
  if (
    Reflect.get(LoroRepo, 'externalMetadataCapability') !== 'loro-external-metadata-v1' ||
    typeof Reflect.get(LoroRepo, 'createWithExternalMetadata') !== 'function'
  )
    throw new Error('Explicit external Repo metadata capability is unavailable');
}
export async function createRepoWithNativeWorkspaceMetaLegacy(
  options: LoroRepoOptions,
  owner: { externalMetadata: ReturnType<typeof createNativeWorkspaceMeta>['externalMetadata'] }
): Promise<LoroRepo> {
  assertLegacyRepoExternalMetadataCapability();
  const factory: unknown = Reflect.get(LoroRepo, 'createWithExternalMetadata');
  if (typeof factory !== 'function') throw new Error('External Repo factory is unavailable');
  const repo: unknown = await Reflect.apply(factory, LoroRepo, [options, owner.externalMetadata]);
  if (!(repo instanceof LoroRepo)) throw new Error('Invalid external Repo factory result');
  if (Reflect.get(repo, 'metadataMode') !== 'external') {
    const failure = new Error('Repo did not select external metadata ownership');
    try {
      await repo.destroy();
    } catch (cleanup) {
      throw new AggregateError([failure, cleanup], 'Unexpected Repo cleanup unconfirmed');
    }
    throw failure;
  }
  return repo;
}

function assertStorage(dataDir: string, workspaceId: string) {
  const db = new Database(
    join(dataDir, 'namespaces', `ns_${Buffer.from(workspaceId).toString('hex')}.sqlite3`),
    { readonly: true, fileMustExist: true, timeout: 0 }
  );
  try {
    const version = db.prepare("SELECT v FROM v2_meta WHERE k='schema_version'").get() as
      | { v: number }
      | undefined;
    const room = db
      .prepare('SELECT encryption FROM v2_rooms WHERE room_kind=3 AND room_id=?')
      .get('meta') as { encryption: number } | undefined;
    if (version?.v !== 1 || room?.encryption !== 0)
      throw new Error('Published Meta storage requires recovery');
  } finally {
    db.close();
  }
}
/** Trusted daemon/one-shot whole Meta composition. The returned full adapter
 * contains opaque/private metadata and must never be exposed to a renderer. */
export async function openNativeLocalWorkspaceMetaLegacy(options: {
  accountId: string;
  workspaceId: string;
  encrypted: boolean;
  cloud: boolean;
  dataRoot?: string;
  launch?: { executable: string; entry: string };
}) {
  if (!isLocalUserId(options.accountId) || !isLocalWorkspaceId(options.workspaceId)) return null;
  const dataRoot = options.dataRoot ?? getLodyDataDir('local');
  const binding = { accountId: options.accountId, workspaceId: options.workspaceId };
  const state = readLocalWorkspaceMetaOwner({ ...binding, dataRoot });
  if (state === 'legacy') return null;
  if (state !== 'native' || options.encrypted || options.cloud)
    throw new Error('Native Meta migration is pending or unsupported');
  const descriptor = resolveLocalIndependentRepo({ platform: 'local', dataRoot, ...binding });
  // Never let a published-but-missing room be recreated as empty by host startup.
  assertStorage(descriptor.dataDir, options.workspaceId);
  const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
  if (!proof?.flockStateEntries)
    throw new Error('Complete native Meta SDK capability is unavailable');
  const host = new IndependentNativeRepoHostLegacy(
    {
      dataDir: descriptor.dataDir,
      binding: descriptor.binding,
      requiredSdkArtifactId: proof.artifactId,
      ...(options.launch ?? {
        executable: getCliNodeExecutable(),
        entry: join(dirname(fileURLToPath(import.meta.url)), 'native-repo-independent-host.js'),
      }),
    },
    toShared()
  );
  let closed = false;
  let metadata: ReturnType<typeof createNativeWorkspaceMeta> | undefined;
  let directory: ReturnType<typeof createNativeWorkspaceDirectory> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed = true;
    if (closing) return closing;
    const work = (async () => {
      const results = await Promise.allSettled([
        metadata?.close(),
        directory?.close(),
        host.close(),
      ]);
      const failures: unknown[] = results[2].status === 'rejected' ? [results[2].reason] : [];
      if (results[0].status === 'rejected') {
        try {
          await metadata?.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (results[1].status === 'rejected') {
        try {
          await directory?.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Native Meta owner cleanup unconfirmed');
    })();
    closing = work;
    void work
      .finally(() => {
        if (closing === work) closing = undefined;
      })
      .catch(() => {});
    return work;
  };
  try {
    const client = await host.client();
    const lease = await host.leaseInfo(client);
    const current = () => {
      if (closed || readLocalWorkspaceMetaOwner({ ...binding, dataRoot }) !== 'native')
        throw new Error('Native Meta owner restart required');
      assertStorage(descriptor.dataDir, options.workspaceId);
    };
    current();
    metadata = createNativeWorkspaceMeta({
      binding,
      generation: JSON.stringify([lease.engineRunId, lease.clientGeneration, lease.sdkArtifactId]),
      client,
      sdkCompatibility: proof,
      sdkArtifactId: lease.sdkArtifactId,
      assertCurrent: current,
    });
    directory = createNativeWorkspaceDirectory({
      namespace: options.workspaceId,
      getClient: async () => {
        current();
        return client;
      },
      sdkCompatibility: proof,
      getClientArtifactId: async (expected) => (await host.leaseInfo(expected)).sdkArtifactId,
      assertAccess: current,
      authority: {
        get: () => ({ synced: true, generation: metadata!.generation }),
        subscribe: () => () => {},
      },
    });
    await metadata.externalMetadata.read();
    return { metadata, directory, externalMetadata: metadata.externalMetadata, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native Meta startup cleanup unconfirmed');
    }
    throw error;
  }
}
