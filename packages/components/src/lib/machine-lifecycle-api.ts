import { DaemonReleaseSchema } from '@lody/shared';
import type { ManagedDaemonUpgradeOptions } from '@lody/shared';
import { DEFAULT_RUNTIME_ARTIFACTS_BASE_URL } from '@lody/platform';
import { z } from 'zod';
import { requireCloudAuthBaseUrl } from './cloud-http-port';

const MachineLifecycleRequestTokenResponseSchema = z.object({
  requestToken: z.string().min(1),
  requesterUserId: z.string().min(1),
});

const LatestCliVersionResponseSchema = z.object({
  packageName: z.literal('lody'),
  latestVersion: z.string().trim().min(1),
  cacheTtlMs: z.number().finite().positive().optional(),
});

export type MachineLifecycleAction = 'restart' | 'upgrade';

export type MintMachineLifecycleRequestTokenResult =
  | { ok: true; requestToken: string; requesterUserId: string }
  | { ok: false; error: string };

export type FetchLatestCliVersionResult =
  | { ok: true; latestVersion: string; cacheTtlMs?: number }
  | { ok: false; error: string };

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

function parseSemver(value: string): ParsedSemver | null {
  const match = value.trim().match(SEMVER_RE);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function isCliVersionOutdated(currentVersion?: string, latestVersion?: string): boolean {
  if (!currentVersion || !latestVersion) return false;
  const current = parseSemver(currentVersion);
  const latest = parseSemver(latestVersion);
  if (!current || !latest) return false;
  for (const key of ['major', 'minor', 'patch'] as const) {
    const delta = latest[key] - current[key];
    if (delta > 0) return true;
    if (delta < 0) return false;
  }
  return comparePrerelease(current.prerelease, latest.prerelease) < 0;
}

export async function mintMachineLifecycleRequestToken({
  workspaceId,
  machineId,
  action,
  requestId,
  targetVersion,
  upgrade,
  restoreMachineId,
  sessionToken,
  authBaseUrl,
}: {
  workspaceId: string;
  machineId: string;
  action: MachineLifecycleAction;
  restoreMachineId?: string;
  requestId: string;
  targetVersion?: string;
  upgrade?: ManagedDaemonUpgradeOptions;
  sessionToken: string;
  authBaseUrl?: string;
}): Promise<MintMachineLifecycleRequestTokenResult> {
  authBaseUrl = requireCloudAuthBaseUrl('remoteMachines', authBaseUrl);
  const trimmedToken = sessionToken.trim();
  if (!trimmedToken) {
    return { ok: false, error: 'not_authenticated' };
  }
  if (!authBaseUrl) {
    return { ok: false, error: 'missing_auth_site_url' };
  }

  try {
    const response = await fetch(
      `${authBaseUrl.replace(/\/+$/, '')}/api/machine-lifecycle/request-token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trimmedToken}`,
        },
        body: JSON.stringify({
          workspaceId,
          machineId,
          action,
          requestId,
          ...(action === 'upgrade' && targetVersion ? { targetVersion } : {}),
          ...(action === 'upgrade' && upgrade ? { upgrade } : {}),
          ...(restoreMachineId ? { restoreMachineId } : {}),
        }),
      }
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `Machine lifecycle request failed with status ${response.status}.`,
      };
    }
    const parsed = MachineLifecycleRequestTokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: 'Machine lifecycle request returned an invalid response.' };
    }
    return {
      ok: true,
      requestToken: parsed.data.requestToken,
      requesterUserId: parsed.data.requesterUserId,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchLatestCliVersion({
  authBaseUrl,
}: {
  authBaseUrl?: string;
} = {}): Promise<FetchLatestCliVersionResult> {
  authBaseUrl = requireCloudAuthBaseUrl('remoteMachines', authBaseUrl);
  if (!authBaseUrl) {
    return { ok: false, error: 'missing_auth_site_url' };
  }

  try {
    const response = await fetch(`${authBaseUrl.replace(/\/+$/, '')}/api/cli/latest-version`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `Latest CLI version request failed with status ${response.status}.`,
      };
    }
    const parsed = LatestCliVersionResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: 'Latest CLI version request returned an invalid response.' };
    }
    return {
      ok: true,
      latestVersion: parsed.data.latestVersion,
      cacheTtlMs: parsed.data.cacheTtlMs,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Public release hint only. The target daemon independently checks the release manifest and artifacts. */
export async function fetchLatestDaemonVersion(
  channel: 'stable' | 'next' | 'nightly'
): Promise<FetchLatestCliVersionResult> {
  if (!requireCloudAuthBaseUrl('remoteMachines'))
    return { ok: false, error: 'missing_cloud_capability' };
  try {
    // Every channel moves only after all platform assets exist. This representative
    // checksummed platform manifest supplies the common version, not execution authority.
    const response = await fetch(
      `${DEFAULT_RUNTIME_ARTIFACTS_BASE_URL}/api/runtimes/${channel === 'next' ? 'lody-cloud-next-daemon' : 'lody-cloud-daemon'}/channels/darwin-arm64/${channel}.json`,
      { signal: AbortSignal.timeout(15000), cache: 'no-store' }
    );
    if (!response.ok) throw new Error(`Daemon channel unavailable: ${response.status}`);
    const manifest = DaemonReleaseSchema.parse(await response.json());
    const distribution = channel === 'next' ? 'lody-cloud-next-daemon' : 'lody-cloud-daemon';
    if (
      manifest.product !== 'lody-cloud' ||
      manifest.distribution !== distribution ||
      manifest.channel !== channel ||
      manifest.platform !== 'darwin-arm64'
    )
      throw new Error('Daemon channel identity mismatch');
    return { ok: true, latestVersion: manifest.version, cacheTtlMs: 60000 };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
