import type { ManagedDaemonUpgradeOptions } from '@lody/shared';
import { z } from 'zod';
import {
  deriveConvexSiteUrl,
  type MachineLifecycleCapability,
  normalizeBaseUrl,
  type MachineId,
  type WorkspaceId,
} from '@lody/shared';
import {
  CLI_EXIT_CODE_AUTH_FAILURE,
  CLI_EXIT_CODE_REMOTE_RESTART,
  CLI_EXIT_CODE_REMOTE_UPGRADE,
  CLI_EXIT_CODE_RETRYABLE_STARTUP,
  CLI_EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH,
} from '@lody/shared/node/local-cli-supervisor';
import { LODY_AUTH_SITE_URL, LODY_AUTH_URL } from '@/utils/const';

// The reserved Worker exit codes are part of the shared Supervisor<->Worker
// contract; Electron consumes the same values from @lody/shared.
export const EXIT_CODE_RETRYABLE_STARTUP = CLI_EXIT_CODE_RETRYABLE_STARTUP;
export const EXIT_CODE_REMOTE_RESTART = CLI_EXIT_CODE_REMOTE_RESTART;
export const EXIT_CODE_REMOTE_UPGRADE = CLI_EXIT_CODE_REMOTE_UPGRADE;
export const EXIT_CODE_AUTH_FAILURE = CLI_EXIT_CODE_AUTH_FAILURE;
export const EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH = CLI_EXIT_CODE_SUPERVISOR_CONTRACT_MISMATCH;
export const DEFAULT_MACHINE_UPGRADE_TARGET_VERSION = 'latest';
export const LODY_DAEMON_SUPERVISED_ENV = 'LODY_DAEMON_SUPERVISED';

const SEMVER_TARGET_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type MachineLifecycleAction = 'restart' | 'upgrade';

export type MachineProcessLifecycleAction =
  | { action: 'restart'; exitCode: typeof EXIT_CODE_REMOTE_RESTART; requestId: string }
  | {
      action: 'upgrade';
      exitCode: typeof EXIT_CODE_REMOTE_UPGRADE;
      requestId: string;
      switchPolicy?: 'when-idle' | 'immediate';
      expiresAtMs?: number;
      revalidate?: () => Promise<boolean>;
      /** Release this request's per-workspace fence when the Worker stays alive. */
      onAbandoned?: () => void;
    };

export const resolveMachineLifecycleCapability = (
  launchMode: 'daemon' | 'electron' | undefined,
  support: { managed?: boolean; encrypted?: boolean; platform?: string } = {}
): MachineLifecycleCapability => {
  if (launchMode === 'electron') {
    return {
      launchMode: 'electron',
      canRemoteRestart: false,
      canRemoteUpgrade: false,
      reason: 'electron',
    };
  }

  if (launchMode === 'daemon') {
    return {
      launchMode: 'daemon',
      canRemoteRestart: !support.encrypted,
      canRemoteUpgrade:
        support.managed === true &&
        !support.encrypted &&
        (support.platform ?? process.platform) !== 'win32',
      ...(!support.managed ||
      support.encrypted ||
      (support.platform ?? process.platform) === 'win32'
        ? { reason: 'unsupported_install' as const }
        : {}),
    };
  }

  return {
    launchMode: 'foreground',
    canRemoteRestart: false,
    canRemoteUpgrade: false,
    reason: 'not_daemon',
  };
};

const MachineLifecycleVerifyResponseSchema = z
  .object({
    valid: z.literal(true),
    requesterUserId: z.string().trim().min(1),
    executionToken: z.string().min(1).optional(),
    executionExpiresAtMs: z.number().finite().positive().optional(),
  })
  .strict();

const resolveConvexSiteUrl = (): string | null => {
  if (LODY_AUTH_SITE_URL) {
    return normalizeBaseUrl(LODY_AUTH_SITE_URL);
  }
  if (LODY_AUTH_URL) {
    return normalizeBaseUrl(deriveConvexSiteUrl(normalizeBaseUrl(LODY_AUTH_URL)));
  }
  return null;
};

export const normalizeMachineUpgradeTargetVersion = (targetVersion?: string): string => {
  const target = targetVersion?.trim() || DEFAULT_MACHINE_UPGRADE_TARGET_VERSION;
  if (target === DEFAULT_MACHINE_UPGRADE_TARGET_VERSION || SEMVER_TARGET_RE.test(target)) {
    return target;
  }
  throw new Error('Upgrade target must be "latest" or an exact semver version.');
};

export const verifyMachineLifecycleRequest = async (args: {
  token: string;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  action: MachineLifecycleAction;
  requesterUserId: string;
  requestId: string;
  requestToken: string;
  targetVersion?: string;
  upgrade?: ManagedDaemonUpgradeOptions;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; executionToken?: string; executionExpiresAtMs?: number }
  | { ok: false; error: string; status?: number; retriable?: boolean }
> => {
  const siteUrl = resolveConvexSiteUrl();
  if (!siteUrl) {
    return { ok: false, error: 'Lody auth URL is not configured on this machine.' };
  }

  try {
    const response = await (args.fetchImpl ?? fetch)(`${siteUrl}/api/machine-lifecycle/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.token}`,
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        workspaceId: args.workspaceId,
        machineId: args.machineId,
        action: args.action,
        requesterUserId: args.requesterUserId,
        requestId: args.requestId,
        requestToken: args.requestToken,
        ...(args.upgrade ? { upgrade: args.upgrade } : {}),
        ...(args.action === 'upgrade'
          ? { targetVersion: normalizeMachineUpgradeTargetVersion(args.targetVersion) }
          : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Machine lifecycle verification failed with status ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        status: response.status,
        retriable: response.status >= 500,
      };
    }

    const parsed = MachineLifecycleVerifyResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: 'Machine lifecycle verification returned an invalid response.' };
    }
    if (parsed.data.requesterUserId !== args.requesterUserId) {
      return { ok: false, error: 'Machine lifecycle verification requester mismatch.' };
    }
    return {
      ok: true,
      executionToken: parsed.data.executionToken,
      executionExpiresAtMs: parsed.data.executionExpiresAtMs,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retriable: true,
    };
  }
};
