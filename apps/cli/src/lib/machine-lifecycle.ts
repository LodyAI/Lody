import type { ChildProcess, SpawnOptions } from 'node:child_process';
import spawn from 'cross-spawn';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
export const MACHINE_UPGRADE_TIMEOUT_MS = 120_000;
export const LODY_DAEMON_SUPERVISED_ENV = 'LODY_DAEMON_SUPERVISED';

const LODY_NPM_PACKAGE_NAME = 'lody';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const SEMVER_TARGET_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type MachineLifecycleAction = 'restart' | 'upgrade';

export type MachineProcessLifecycleAction =
  | { action: 'restart'; exitCode: typeof EXIT_CODE_REMOTE_RESTART; requestId: string }
  | { action: 'upgrade'; exitCode: typeof EXIT_CODE_REMOTE_UPGRADE; requestId: string };

export const resolveMachineLifecycleCapability = (
  launchMode: 'daemon' | 'electron' | undefined
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
      canRemoteRestart: true,
      canRemoteUpgrade: true,
    };
  }

  return {
    launchMode: 'foreground',
    canRemoteRestart: false,
    canRemoteUpgrade: false,
    reason: 'not_daemon',
  };
};

type LifecycleLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

const MachineLifecycleVerifyResponseSchema = z
  .object({
    valid: z.literal(true),
    requesterUserId: z.string().trim().min(1),
  })
  .strict();

const DaemonUpgradeIntentSchema = z
  .object({
    version: z.literal(1),
    action: z.literal('upgrade'),
    requestId: z.string().trim().min(1),
    requesterUserId: z.string().trim().min(1),
    targetVersion: z.string().trim().min(1),
    currentVersion: z.string().trim().min(1).optional(),
    requestedAtMs: z.number().finite().nonnegative(),
  })
  .strict();

export type DaemonUpgradeIntent = z.infer<typeof DaemonUpgradeIntentSchema>;

export const DAEMON_UPGRADE_INTENT_FILE = path.join(
  os.homedir(),
  '.lody',
  'daemon-upgrade-intent.json'
);

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
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true } | { ok: false; error: string; status?: number; retriable?: boolean }> => {
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
      body: JSON.stringify({
        workspaceId: args.workspaceId,
        machineId: args.machineId,
        action: args.action,
        requesterUserId: args.requesterUserId,
        requestId: args.requestId,
        requestToken: args.requestToken,
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
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      retriable: true,
    };
  }
};

export const writeDaemonUpgradeIntent = async (intent: Omit<DaemonUpgradeIntent, 'version'>) => {
  const value: DaemonUpgradeIntent = { version: 1, ...intent };
  const parsed = DaemonUpgradeIntentSchema.parse(value);
  const dir = path.dirname(DAEMON_UPGRADE_INTENT_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(DAEMON_UPGRADE_INTENT_FILE)}.${process.pid}.tmp`
  );
  await fs.writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(tmpPath, DAEMON_UPGRADE_INTENT_FILE);
};

export const readDaemonUpgradeIntent = async (): Promise<DaemonUpgradeIntent | null> => {
  try {
    const raw = await fs.readFile(DAEMON_UPGRADE_INTENT_FILE, 'utf8');
    const parsed = DaemonUpgradeIntentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const clearDaemonUpgradeIntent = async (): Promise<void> => {
  try {
    await fs.unlink(DAEMON_UPGRADE_INTENT_FILE);
  } catch {
    // best effort
  }
};

export const resolveNpmExecutable = (platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32' ? 'npm.cmd' : 'npm';

export const buildLodyUpgradeInstallArgs = (targetVersion: string): string[] => [
  'install',
  '-g',
  `${LODY_NPM_PACKAGE_NAME}@${normalizeMachineUpgradeTargetVersion(targetVersion)}`,
  `--registry=${NPM_REGISTRY_URL}`,
];

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

const runCommand = async (args: {
  command: string;
  commandArgs: readonly string[];
  timeoutMs: number;
  spawnImpl: SpawnLike;
  signal?: AbortSignal;
}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}> => {
  if (args.signal?.aborted) {
    throw new DOMException('Daemon upgrade canceled', 'AbortError');
  }
  const child = args.spawnImpl(args.command, args.commandArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let stdout = '';
  let stderr = '';
  const append = (current: string, chunk: Buffer): string =>
    `${current}${chunk.toString()}`.slice(-64 * 1024);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });

  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let processError: Error | null = null;
    let terminationStarted = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitConfirmationTimer: ReturnType<typeof setTimeout> | null = null;
    const requestTermination = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceKillTimer.unref?.();
      exitConfirmationTimer = setTimeout(() => {
        cleanup();
        reject(new Error('Upgrade process did not confirm exit after SIGKILL'));
      }, 7_000);
      exitConfirmationTimer.unref?.();
    };
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      requestTermination();
    };
    args.signal?.addEventListener('abort', onAbort, { once: true });
    if (args.signal?.aborted) onAbort();
    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, args.timeoutMs);
    timeout.unref?.();

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (exitConfirmationTimer) clearTimeout(exitConfirmationTimer);
      args.signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (error) => {
      processError = error;
    });
    child.once('close', (code) => {
      cleanup();
      if (processError) {
        reject(processError);
        return;
      }
      resolve({ code, stdout, stderr, timedOut, aborted });
    });
  });
};

/** Returns true only when the upgrade intent existed and npm install succeeded. */
export const runDaemonUpgradeFromIntent = async (args: {
  logger: LifecycleLogger;
  timeoutMs?: number;
  spawnImpl?: SpawnLike;
  signal?: AbortSignal;
}): Promise<boolean> => {
  const intent = await readDaemonUpgradeIntent();
  if (!intent) {
    args.logger.warn?.('[daemon-upgrade] no upgrade intent found; respawning without upgrade');
    return false;
  }

  try {
    const targetVersion = normalizeMachineUpgradeTargetVersion(intent.targetVersion);
    const npmExecutable = resolveNpmExecutable();
    const installArgs = buildLodyUpgradeInstallArgs(targetVersion);
    args.logger.info?.(
      `[daemon-upgrade] installing ${LODY_NPM_PACKAGE_NAME}@${targetVersion} for request ${intent.requestId}`
    );
    const result = await runCommand({
      command: npmExecutable,
      commandArgs: installArgs,
      timeoutMs: args.timeoutMs ?? MACHINE_UPGRADE_TIMEOUT_MS,
      spawnImpl: args.spawnImpl ?? spawn,
      signal: args.signal,
    });
    if (result.aborted) {
      throw new DOMException('Daemon upgrade canceled', 'AbortError');
    }
    if (result.timedOut) {
      args.logger.error?.(
        `[daemon-upgrade] npm install timed out after ${args.timeoutMs ?? MACHINE_UPGRADE_TIMEOUT_MS}ms`
      );
      return false;
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || 'no output').replace(/\s+/g, ' ').trim();
      args.logger.error?.(
        `[daemon-upgrade] npm install failed with code ${result.code}: ${detail.slice(0, 500)}`
      );
      return false;
    }
    args.logger.info?.(
      `[daemon-upgrade] npm install completed for ${LODY_NPM_PACKAGE_NAME}@${targetVersion}`
    );
    return true;
  } finally {
    await clearDaemonUpgradeIntent();
  }
};
