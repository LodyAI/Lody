import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkspaceId } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { IndependentNativeRepoHostLegacy } from '@lody/shared/node/native-repo-independent-legacy';
import { resolveLocalIndependentRepo } from '@lody/shared/node/native-repo-independent-paths';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { NativeLocalSessionOwnerLegacy } from '@lody/shared/node/native-session';
import type { NativeLocalWorkspaceMetaLegacy } from './native-workspace-meta-owner';
import { getCliNodeExecutable } from '../managed-daemon-release';
import { toShared } from '@/platform/process-options';

/** Compose a body factory over the already selected authoritative Meta owner.
 * Selection remains per room in the durable journal. Constructing this factory
 * neither migrates a body nor opens a second legacy replica. */
export async function createNativeLocalSessionFactoryLegacy(options: {
  accountId: string;
  workspaceId: string;
  metadata: NativeLocalWorkspaceMetaLegacy['metadata'];
  dataRoot?: string;
  launch?: { executable: string; entry: string };
  onBackgroundFailure(error: unknown): void;
}) {
  options.metadata.assertCurrent();
  if (
    options.metadata.binding.accountId !== options.accountId ||
    options.metadata.binding.workspaceId !== options.workspaceId
  )
    throw new Error('Native Session metadata binding mismatch');
  const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
  if (!proof?.setValue) throw new Error('Verified native Session SDK unavailable');
  options.metadata.assertCurrent();
  const dataRoot = options.dataRoot ?? getLodyDataDir('local');
  const descriptor = resolveLocalIndependentRepo({
    platform: 'local',
    dataRoot,
    accountId: options.accountId,
    workspaceId: options.workspaceId,
  });
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
  const owner = new NativeLocalSessionOwnerLegacy({
    accountId: options.accountId,
    workspaceId: options.workspaceId as WorkspaceId,
    dataRoot,
    compatibility: proof,
    host,
    writer: `cli-session:${process.pid}`,
    closeTimeoutMs: 5000,
    editingLeaseMs: 30000,
    now: Date.now,
    onBackgroundFailure: options.onBackgroundFailure,
  });
  return owner.factory;
}
