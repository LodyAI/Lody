import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import inquirer from 'inquirer';
import { Cause, Effect, Exit } from 'effect';
import { getInstallationProfile, getLodyDataDir } from '@lody/shared/node/installation-profile';
import {
  acquireLocalCliHostLease,
  getLocalCliHostEndpoint,
} from '@lody/shared/node/local-cli-host-lease';
import type { WorkspaceId } from '@lody/shared';
import { getCliPlatformKind } from '@/lib/cli-platform';
import { AuthClient, performLogin } from '@/lib/auth';
import {
  getAuthContextOrThrow,
  runOneShotCommand,
  selectWorkspaceSummary,
} from '@/lib/command-runtime';
import { listWorkspacesForToken, registerMachineAccessForCliToken } from '@/lib/workspace';
import { createCloudStreamsTokenPort } from '@/lib/cloud-cli-port';
import { SessionAttachmentTransfer } from '@/lib/session-attachment-transfer';
import { fileLocksLegacy } from '@/utils/file-lock';
import { getLogger } from '@/utils/logger';
import { LODY_AUTH_URL, LODY_AUTH_SITE_URL, LODY_SERVER_URL } from '@/utils/const';
import { hashBytes, manifestSchema } from '@/lib/oss-migration/model';
import {
  exists,
  freezeSource,
  loadJournal,
  loadSourceCatalog,
  readJson,
} from '@/lib/oss-migration/source';
import { openMigrationTarget } from '@/lib/oss-migration/target';
import { migrateSnapshot, migrationStep, MigrationRuntime } from '@/lib/oss-migration/engine';

type Options = {
  fromOss: boolean;
  source?: string;
  workspace?: string;
  yes?: boolean;
  debug?: boolean;
};

// OS signals own the cancellation boundary; withLock joins the callback before
// releasing the filesystem lock, including Effect scope finalizers.
export async function withMigrationLock<T>(
  name: string,
  action: (signal: AbortSignal) => Promise<T>,
  signals: Pick<NodeJS.Process, 'on' | 'off'> = process
): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Migration interrupted'));
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', interrupt);
  try {
    return await fileLocksLegacy.withLock(name, action, { signal: controller.signal });
  } finally {
    signals.off('SIGINT', interrupt);
    signals.off('SIGTERM', interrupt);
  }
}

export const migrateCommand = new Command('migrate')
  .description('Import a frozen OSS snapshot into an existing cloud workspace')
  .requiredOption('--from-oss', 'Migrate local OSS records')
  .option('--source <directory>', 'OSS data root (defaults to ~/.lody-oss)')
  .option('--workspace <selector>', 'Explicit existing workspace id, slug or name')
  .option('--yes', 'Confirm upload without a prompt (requires --workspace)')
  .option('--debug', 'Enable debug output')
  .action(async (options: Options) => {
    // Guard before auth, file reads, or cloud construction, including programmatic callers.
    if (getCliPlatformKind() !== 'cloud')
      throw new Error('Migration requires the cloud CLI. OSS remains local-only.');
    if (options.yes && !options.workspace)
      throw new Error('--yes requires an explicit --workspace.');
    if (!options.workspace && !process.stdin.isTTY)
      throw new Error('Select a target with --workspace; there is no implicit target.');
    await runOneShotCommand('migrate', options, async () => {
      if (!LODY_AUTH_URL || !LODY_SERVER_URL)
        throw new Error('Cloud deployment is not configured.');
      const authBaseUrl = LODY_AUTH_URL;
      const serverBaseUrl = LODY_SERVER_URL;
      const logger = getLogger('migrate');
      const authClient = new AuthClient(logger);
      if (!authClient.getAuthInfo()) {
        if (!process.stdin.isTTY) throw new Error('Run lody login first.');
        const result = await performLogin(authClient, logger, {});
        if (!result.success) throw new Error('Cloud login failed.');
      }
      const auth = getAuthContextOrThrow('migrate');
      const candidates = (await listWorkspacesForToken(auth.token)).filter((w) =>
        ['owner', 'admin', 'member'].includes(w.role)
      );
      if (!candidates.length)
        throw new Error(
          'No writable workspaces. Create a workspace in Lody, then run migration again.'
        );
      const selector =
        options.workspace ??
        (
          await inquirer.prompt<{ workspace: string }>([
            {
              type: 'list',
              name: 'workspace',
              message: 'Choose the existing cloud workspace to import into:',
              choices: candidates.map((w) => ({
                name: `${w.name} (${w.slug ?? w.id})`,
                value: w.id,
              })),
            },
          ])
        ).workspace;
      const workspace = selectWorkspaceSummary(candidates, selector);
      const sourcePath = await fs.realpath(
        options.source ?? path.join(os.homedir(), getInstallationProfile('local').dataDirectoryName)
      );
      if (sourcePath === (await fs.realpath(getLodyDataDir())))
        throw new Error('Source and cloud data roots must be different.');
      const { catalog, workspace: sourceWorkspace } = await loadSourceCatalog(sourcePath);
      const migrationId = hashBytes(
        JSON.stringify([LODY_AUTH_URL, auth.userId, workspace.id, sourceWorkspace.workspaceId])
      ).slice(0, 32);
      const directory = path.join(getLodyDataDir(), 'migrations', migrationId);
      await withMigrationLock(`oss-migration-${migrationId}`, async (signal) => {
        const manifestPath = path.join(directory, 'manifest.json');
        const binding = {
          sourcePath,
          sourceWorkspaceId: sourceWorkspace.workspaceId,
          sourceMachineId: catalog.machine.machineId,
          sourceUserId: catalog.identity.userId,
          sourceName: sourceWorkspace.name,
          targetWorkspaceId: workspace.id,
          targetMachineId: auth.machineId,
          targetUserId: auth.userId,
          deployment: authBaseUrl,
          migrationId,
        };
        let manifest;
        if (await exists(manifestPath)) {
          manifest = manifestSchema.parse(await readJson(manifestPath));
          for (const [key, value] of Object.entries(binding)) {
            if (manifest[key as keyof typeof binding] !== value)
              throw new Error(
                'Migration source, account, machine or deployment changed. Refusing to reuse this journal.'
              );
          }
        } else {
          const host = await acquireLocalCliHostLease({
            instanceId: randomUUID(),
            mode: 'foreground',
            endpoint: getLocalCliHostEndpoint('local'),
          });
          if (host.status !== 'acquired')
            throw new Error(
              'Close Lody OSS and stop its CLI before migrating, so all records are saved. Your running app was not stopped.'
            );
          try {
            manifest = await freezeSource(binding, directory);
          } finally {
            await host.lease.close();
          }
        }
        console.log(
          `Account: ${auth.userEmail}\nSource: ${manifest.sourceName} (${sourcePath})\nTarget: ${workspace.name} (${workspace.id})\nSnapshot: ${manifest.createdAt}\nDocuments: ${manifest.documents.length}`
        );
        console.log(
          'Existing cloud records/settings are preserved. Imported sessions are stopped; schedules are disabled. Source data is retained.'
        );
        if (!options.yes) {
          if (!process.stdin.isTTY)
            throw new Error('Use --yes with --workspace to confirm this upload.');
          const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
            {
              type: 'confirm',
              name: 'confirmed',
              default: false,
              message: 'Upload this snapshot to the selected workspace?',
            },
          ]);
          if (!confirmed) {
            console.log('Canceled. No records uploaded.');
            return;
          }
        }
        const journal = await loadJournal(directory, migrationId);
        const tokenProvider = createCloudStreamsTokenPort({
          token: auth.token,
          authBaseUrl,
          authSiteUrl: LODY_AUTH_SITE_URL,
          logger,
        }).createTokenProvider({ workspaceId: workspace.id as WorkspaceId });
        if (!manifest.documents.length) {
          console.log('No records to migrate.');
          return;
        }
        await registerMachineAccessForCliToken({
          token: auth.token,
          workspaceId: workspace.id,
          machineId: auth.machineId,
        });
        const program = Effect.acquireRelease(
          migrationStep(() => openMigrationTarget(tokenProvider, workspace.id as WorkspaceId)),
          (target) => migrationStep(() => target.close()).pipe(Effect.orDie)
        ).pipe(
          Effect.flatMap((target) =>
            migrateSnapshot(manifest, journal, directory).pipe(
              Effect.provideService(MigrationRuntime, {
                target,
                transfer: new SessionAttachmentTransfer(auth.token, serverBaseUrl),
                progress: console.log,
              })
            )
          ),
          Effect.scoped
        );
        const exit = await Effect.runPromiseExit(program, { signal });
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        console.log(`Migration backup and resume journal: ${directory}`);
      });
    });
  });
