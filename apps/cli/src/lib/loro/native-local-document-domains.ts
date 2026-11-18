import { createScheduleDefinitionRegistryAdapter } from '@lody/shared/node/native-schedule-definition';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceId } from '@lody/shared';
import type { ScheduleRegistryPort } from '@lody/shared';
import { isLocalUserId, isLocalWorkspaceId } from '@lody/shared/platform-kind';
import { createNativeDocumentDomains } from '@lody/shared/node/native-document-domains';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import type { NativeLocalWorkspaceMetaLegacy } from './native-workspace-meta-owner';
import { getCliNodeExecutable } from '../managed-daemon-release';
import { toShared } from '@/platform/process-options';

/** Compose only previously migrated local plaintext definition rooms. The
 * persistent per-document journal is independent of Session body/MF/SR owners;
 * no flag or missing database can create a new native document. */
export async function openNativeLocalDocumentDomainsLegacy(options: {
  accountId: string;
  workspaceId: WorkspaceId;
  encrypted: boolean;
  cloud: boolean;
  metadata?: NativeLocalWorkspaceMetaLegacy['metadata'];
  registry: ScheduleRegistryPort;
  dataRoot?: string;
  launch?: { executable: string; entry: string };
}) {
  // Cloud identities have no independent local descriptor and keep their owner.
  if (!isLocalUserId(options.accountId) || !isLocalWorkspaceId(options.workspaceId)) return null;
  const dataRoot = options.dataRoot ?? getLodyDataDir('local');
  const selected = resolveLocalIndependentRepo({
    platform: 'local',
    dataRoot,
    accountId: options.accountId,
    workspaceId: options.workspaceId,
  });
  const journalPath = join(selected.directory, 'document-routes.sqlite3');
  if (!existsSync(journalPath)) return null;
  const metadata = options.metadata;
  if (!metadata) throw new Error('Native document Meta owner required');
  if (
    options.encrypted ||
    options.cloud ||
    !isLocalUserId(options.accountId) ||
    !isLocalWorkspaceId(options.workspaceId)
  )
    throw new Error('Native document domains require local plaintext authority');
  metadata.assertCurrent();
  if (
    metadata.binding.accountId !== options.accountId ||
    metadata.binding.workspaceId !== options.workspaceId ||
    options.registry.workspaceId !== options.workspaceId
  )
    throw new Error('Native document domain binding mismatch');
  const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
  if (!proof?.setValue || !proof.losslessWireI64)
    throw new Error('Native document domain SDK proof unavailable');
  metadata.assertCurrent();
  const host = new IndependentNativeRepoHostLegacy(
    {
      dataDir: selected.dataDir,
      binding: selected.binding,
      requiredSdkArtifactId: proof.artifactId,
      ...(options.launch ?? {
        executable: getCliNodeExecutable(),
        entry: join(dirname(fileURLToPath(import.meta.url)), 'native-repo-independent-host.js'),
      }),
    },
    toShared()
  );
  let closed = false,
    closing: Promise<void> | undefined;
  const assertCurrent = () => {
    if (closed) throw new Error('Native document domains are closed');
    metadata.assertCurrent();
  };
  const domains = createNativeDocumentDomains({
    accountId: options.accountId,
    workspaceId: options.workspaceId,
    journalPath,
    dataDir: selected.dataDir,
    compatibility: proof,
    writer: `cli-definition:${process.pid}`,
    assertCurrent,
    async authorize(family, id) {
      assertCurrent();
      const roomId = family === 'preview_comments' ? `preview-comment-${id}` : `schedule-${id}`;
      const own = await metadata.document(roomId).read();
      assertCurrent();
      if (!own) throw new Error('Native document metadata is unavailable');
      if (family === 'preview_comments') {
        const parent = await metadata.document(`session-${id}`).read();
        assertCurrent();
        if (!parent) throw new Error('Preview parent Session is unavailable');
        // Parent historyBackend deliberately does not grant comment ownership.
      }
    },
    async getClient() {
      assertCurrent();
      const client = await host.client();
      const info = await host.leaseInfo(client);
      assertCurrent();
      return {
        client,
        generation: JSON.stringify([info.engineRunId, info.clientGeneration, info.sdkArtifactId]),
        sdkArtifactId: info.sdkArtifactId ?? '',
      };
    },
    registry: createScheduleDefinitionRegistryAdapter(options.registry, assertCurrent),
    // Native applyDocPatch acknowledges the engine's SQLite commit. There is
    // no second legacy store or fire-and-forget durability operation here.
    flushDefinition: async () => {
      assertCurrent();
    },
  });
  const close = (): Promise<void> => {
    closed = true;
    if (closing) return closing;
    const work = (async () => {
      let primary: unknown;
      try {
        await domains.close();
      } catch (error) {
        primary = error;
      }
      // Release only this borrowed host connection. A sibling data lease stays alive.
      try {
        await host.close();
      } catch (error) {
        throw new AggregateError(
          primary ? [primary, error] : [error],
          'Native document domain host cleanup failed'
        );
      }
      if (primary) await domains.retryCleanup();
    })();
    closing = work;
    void work.catch(() => {
      if (closing === work) closing = undefined;
    });
    return work;
  };
  return { ...domains, close, retryCleanup: close };
}
