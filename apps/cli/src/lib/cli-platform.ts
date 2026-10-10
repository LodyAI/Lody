import { fileLocksLegacy } from '@/utils/file-lock';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Effect } from 'effect';
import {
  LOCAL_USER_ID_PREFIX,
  LOCAL_WORKSPACE_ID_PREFIX,
  resolvePlatformKind,
  type PlatformKind,
} from '@lody/platform';
import { getServerNow } from '@lody/shared';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { loadEnv } from '@/utils/const';
import type { Logger } from '@/utils/logger';
import type { LocalWorkspaceCatalogService } from '@/lib/local-workspace-catalog';

/**
 * CLI-side platform selection (specs/platform-providers.md). `local` is the
 * open-source no-account mode and the public workspace default.
 * Unrecognized values throw so a misconfigured local build fails loudly
 * instead of silently talking to the cloud.
 */
export function getCliPlatformKind(): PlatformKind {
  return resolvePlatformKind(process.env.LODY_PLATFORM);
}

/**
 * Defense in depth for the local platform's zero-cloud-I/O invariant: blank
 * every cloud endpoint env before modules read them. Cloud behavior is owned
 * by the injected CloudPort; this scrub prevents legacy environment readers
 * from becoming an accidental second composition root. A cloud operation
 * reached from local mode must still fail through the unavailable port.
 */
export function applyLocalPlatformEnv(): void {
  delete process.env.LODY_AUTH_URL;
  delete process.env.LODY_AUTH_SITE_URL;
  delete process.env.LODY_SERVER_URL;
  delete process.env.SITE_URL;
  delete process.env.LODY_POSTHOG_KEY;
  delete process.env.POSTHOG_API_KEY;
  delete process.env.POSTHOG_HOST;
  delete process.env.VITE_PUBLIC_POSTHOG_KEY;
  delete process.env.VITE_PUBLIC_POSTHOG_HOST;
  loadEnv();
}

const LOCAL_IDENTITY_FILE = 'local-identity.json';

export type LocalCliIdentity = {
  userId: string;
  createdAt: string;
};

export function getLocalIdentityPath(): string {
  return path.join(getLodyDataDir('local'), LOCAL_IDENTITY_FILE);
}

/**
 * The synthetic identity every local-platform write is authored under.
 * Generated once per install and persisted; the `local:` prefix keeps it
 * disjoint from cloud user ids so cloud-mode processes refuse local state
 * (and vice versa).
 */
export async function loadOrCreateLocalIdentity(
  logger: Logger,
  options: { filePath?: string } = {}
): Promise<LocalCliIdentity> {
  const identityPath = options.filePath ?? getLocalIdentityPath();
  try {
    const raw = await fs.readFile(identityPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LocalCliIdentity>;
    if (
      typeof parsed.userId === 'string' &&
      parsed.userId.startsWith(LOCAL_USER_ID_PREFIX) &&
      typeof parsed.createdAt === 'string'
    ) {
      return { userId: parsed.userId, createdAt: parsed.createdAt };
    }
    logger.warn('[platform] Local identity file is malformed; regenerating');
  } catch {
    // Missing file: first run.
  }
  const identity: LocalCliIdentity = {
    userId: `${LOCAL_USER_ID_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`,
    createdAt: new Date(getServerNow()).toISOString(),
  };
  await fs.mkdir(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  logger.info(`[platform] Created local identity ${identity.userId}`);
  return identity;
}

export const LOCAL_WORKSPACE_NAME = 'Lody';
export const LOCAL_WORKSPACE_SLUG = 'local';

export type LocalWorkspaceListItem = {
  id: string;
  name: string;
  slug: string | null;
  role: string;
};

/**
 * Idempotently provisions the single implicit local workspace (D-O14). The
 * catalog is the same store the cloud reconcile writes; on the local platform
 * this function is its only writer, and the workspace id keeps the `lw_`
 * prefix so migration tooling (D-O13) can recognize local-born data.
 */
export async function ensureImplicitLocalWorkspace(options: {
  catalog: LocalWorkspaceCatalogService;
  identity: LocalCliIdentity;
  machineId: string;
  machineName: string;
  logger: Logger;
}): Promise<LocalWorkspaceListItem> {
  const { catalog, identity, machineId, machineName, logger } = options;
  const snapshot = await Effect.runPromise(catalog.read());
  const existing =
    snapshot.identity?.userId === identity.userId
      ? snapshot.workspaces.find(
          (workspace) =>
            workspace.workspaceId.startsWith(LOCAL_WORKSPACE_ID_PREFIX) &&
            workspace.state === 'active'
        )
      : undefined;
  if (existing) {
    return {
      id: existing.workspaceId,
      name: existing.name,
      slug: existing.slug,
      role: existing.role,
    };
  }

  const workspace: LocalWorkspaceListItem = {
    id: `${LOCAL_WORKSPACE_ID_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`,
    name: LOCAL_WORKSPACE_NAME,
    slug: LOCAL_WORKSPACE_SLUG,
    role: 'owner',
  };
  await fileLocksLegacy.runPromise(
    catalog.cacheRemoteWorkspaces({
      identity: { userId: identity.userId },
      machine: { machineId, machineName },
      workspaces: [workspace],
    })
  );
  logger.info(`[platform] Provisioned implicit local workspace ${workspace.id}`);
  return workspace;
}
