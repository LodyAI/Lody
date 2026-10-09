import { toShared } from '@/platform/process-options';
import * as fs from 'node:fs/promises';
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
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { startProcess } from '@lody/shared/node/process';

import type { NodeProcessApi } from '@lody/shared/node/process';
import type { TerminationPolicy } from '@lody/shared/node/process';

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

export const DAEMON_UPGRADE_INTENT_FILE = path.join(getLodyDataDir(), 'daemon-upgrade-intent.json');

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

/**
 * A timed-out or cancelled install is ended as a tree: npm's lifecycle scripts
 * and their children go with it. SIGKILL after 2 s, exit proven within 5 s more.
 */
const UPGRADE_TERMINATION_POLICY: TerminationPolicy = { graceMs: 2_000, killWaitMs: 5_000 };

const runCommand = async (args: {
  command: string;
  commandArgs: readonly string[];
  timeoutMs: number;
  nodeProcess?: NodeProcessApi;
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
  let stdout = '';
  let stderr = '';
  const append = (current: string, chunk: Buffer): string =>
    `${current}${chunk.toString()}`.slice(-64 * 1024);
  const install = startProcess(
    {
      command: args.command,
      args: args.commandArgs,
      options: { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
      processGroup: true,
      onSpawned: (child) => {
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout = append(stdout, chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
      },
    },
    toShared({ nodeProcess: args.nodeProcess })
  );
  const child = install.child;

  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let processError: Error | null = null;
    let terminationStarted = false;
    const requestTermination = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      void install.terminate(UPGRADE_TERMINATION_POLICY).then(
        // The whole tree is gone; do not wait on a pipe some escaped process
        // may still hold open.
        () =>
          install.exited.then(({ code }) => {
            cleanup();
            if (processError) reject(processError);
            else resolve({ code, stdout, stderr, timedOut, aborted });
          }),
        (error: unknown) => {
          cleanup();
          reject(new Error('Upgrade process did not confirm exit after SIGKILL', { cause: error }));
        }
      );
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
      args.signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (error) => {
      processError = error;
    });
    child.once('close', (code) => {
      // Once termination starts it owns the result: the root can close while
      // the rest of its tree is still being ended.
      if (terminationStarted) return;
      cleanup();
      if (processError) {
        reject(processError);
        return;
      }
      resolve({ code, stdout, stderr, timedOut, aborted });
    });
  });
};

export type DaemonUpgradeInstallation = { bin: string; version: string };

const InstalledLodyPackageSchema = z.object({
  name: z.literal(LODY_NPM_PACKAGE_NAME),
  version: z.string().regex(SEMVER_TARGET_RE),
  bin: z.union([z.string().min(1), z.object({ lody: z.string().min(1) })]),
});

/** Resolve the install destination through the same npm used to install, never PATH's lody. */
async function resolveUpgradedInstallation(args: {
  npmExecutable: string;
  targetVersion: string;
  timeoutMs: number;
  nodeProcess?: NodeProcessApi;
  signal?: AbortSignal;
}): Promise<DaemonUpgradeInstallation> {
  const run = async (command: string, commandArgs: string[]) => {
    const result = await runCommand({ ...args, command, commandArgs });
    if (result.aborted || args.signal?.aborted) {
      throw new DOMException('Daemon upgrade canceled', 'AbortError');
    }
    if (result.timedOut || result.code !== 0) {
      throw new Error(
        `Upgrade verification failed (${commandArgs.join(' ')}): ${result.timedOut ? 'timed out' : `exit ${result.code}`}`
      );
    }
    return result.stdout.trim();
  };
  const root = await run(args.npmExecutable, ['root', '-g']);
  if (!path.isAbsolute(root) || /[\r\n]/.test(root)) {
    throw new Error('npm root -g did not return one absolute installation directory');
  }
  const packageRoot = await fs.realpath(path.join(root, LODY_NPM_PACKAGE_NAME));
  const installed = InstalledLodyPackageSchema.parse(
    JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  );
  if (args.targetVersion !== 'latest' && installed.version !== args.targetVersion) {
    throw new Error(
      `Installed Lody version ${installed.version} does not match requested ${args.targetVersion}`
    );
  }
  const entry = typeof installed.bin === 'string' ? installed.bin : installed.bin.lody;
  const bin = await fs.realpath(path.resolve(packageRoot, entry));
  const relative = path.relative(packageRoot, bin);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Installed Lody entry must be inside its package directory');
  }
  const actualVersion = await run(process.execPath, [bin, '--version']);
  if (actualVersion !== installed.version) {
    throw new Error(
      `Installed Lody entry reports ${actualVersion || 'no version'}; expected ${installed.version}`
    );
  }
  return { bin, version: installed.version };
}

/** Installation success is not upgrade completion; the caller must verify the runner handoff. */
export const runDaemonUpgradeFromIntent = async (args: {
  logger: LifecycleLogger;
  timeoutMs?: number;
  /** OS process seam of the process layer; tests substitute a fake. */
  nodeProcess?: NodeProcessApi;
  signal?: AbortSignal;
}): Promise<DaemonUpgradeInstallation | null> => {
  const intent = await readDaemonUpgradeIntent();
  if (!intent) {
    args.logger.warn?.('[daemon-upgrade] no upgrade intent found; respawning without upgrade');
    return null;
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
      nodeProcess: args.nodeProcess,
      signal: args.signal,
    });
    if (result.aborted) {
      throw new DOMException('Daemon upgrade canceled', 'AbortError');
    }
    if (result.timedOut) {
      args.logger.error?.(
        `[daemon-upgrade] npm install timed out after ${args.timeoutMs ?? MACHINE_UPGRADE_TIMEOUT_MS}ms`
      );
      return null;
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || 'no output').replace(/\s+/g, ' ').trim();
      args.logger.error?.(
        `[daemon-upgrade] npm install failed with code ${result.code}: ${detail.slice(0, 500)}`
      );
      return null;
    }
    args.logger.info?.(
      `[daemon-upgrade] npm install completed for ${LODY_NPM_PACKAGE_NAME}@${targetVersion}`
    );
    try {
      const installation = await resolveUpgradedInstallation({
        npmExecutable,
        targetVersion,
        timeoutMs: args.timeoutMs ?? MACHINE_UPGRADE_TIMEOUT_MS,
        nodeProcess: args.nodeProcess,
        signal: args.signal,
      });
      args.logger.info?.(
        `[daemon-upgrade] verified ${installation.version} at ${installation.bin}`
      );
      return installation;
    } catch (error) {
      if (args.signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
        throw error;
      args.logger.error?.(
        `[daemon-upgrade] ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  } finally {
    await clearDaemonUpgradeIntent();
  }
};
