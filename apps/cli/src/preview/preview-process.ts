import { readFile } from 'node:fs/promises';
import { Effect } from 'effect';
import { isLoopbackPreviewHost, type PreviewTarget } from '@lody/shared';
import {
  NodeProcess,
  pidTree,
  processLayer,
  runCommand,
  terminateTree,
} from '@lody/shared/node/process';
import type { Logger } from '@/utils/logger';

const ALLOWED_LISTEN_HOSTS = new Set([
  '127.0.0.1',
  '::1',
  '[::1]',
  'localhost',
  '*',
  '0.0.0.0',
  '::',
  '[::]',
]);

const PROCESS_TERMINATION_POLICY = {
  graceMs: 3_000,
  killWaitMs: 2_000,
} as const;

const isAllowedListenAddress = (address: string, port: number): boolean => {
  const trimmed = address.trim().toLowerCase();
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0) return false;
  const host = trimmed.slice(0, lastColon);
  const parsedPort = Number(trimmed.slice(lastColon + 1));
  if (!Number.isInteger(parsedPort) || parsedPort !== port) return false;
  return ALLOWED_LISTEN_HOSTS.has(host);
};

/**
 * Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pun` output into deduplicated
 * listening PIDs owned by `uid` (when provided) on loopback/wildcard `port`.
 */
export function parseLsofListeningPids(
  output: string,
  options: { port: number; uid?: number }
): number[] {
  const matched = new Set<number>();
  let currentPid: number | null = null;
  let currentUid: number | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      const parsed = Number(value);
      currentPid = Number.isSafeInteger(parsed) && parsed > 1 ? parsed : null;
      currentUid = null;
    } else if (tag === 'u') {
      const parsed = Number(value);
      currentUid = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    } else if (tag === 'n' && currentPid !== null) {
      if (options.uid !== undefined && currentUid !== options.uid) continue;
      // Ignore connected addresses (`a->b`), only match listen sockets.
      if (value.includes('->')) continue;
      if (isAllowedListenAddress(value, options.port)) {
        matched.add(currentPid);
      }
    }
  }

  return [...matched];
}

/**
 * Parse Linux `ss -H -ltnp` output into deduplicated listening PIDs for `port`.
 */
export function parseSsListeningPids(output: string, port: number): number[] {
  const matched = new Set<number>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split(/\s+/);
    const localAddress = columns[3];
    if (!localAddress || !isAllowedListenAddress(localAddress, port)) continue;
    for (const match of line.matchAll(/\bpid=(\d+)\b/g)) {
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed) && parsed > 1) {
        matched.add(parsed);
      }
    }
  }
  return [...matched];
}

/** Parse numeric PIDs returned by Windows `Get-NetTCPConnection`. */
export function parseWindowsListeningPids(output: string): number[] {
  const matched = new Set<number>();
  for (const rawLine of output.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed) && parsed > 4) {
      matched.add(parsed);
    }
  }
  return [...matched];
}

async function execCommandText(
  command: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 5_000
): Promise<{ code: number | null; stdout: string } | null> {
  try {
    const result = await Effect.runPromise(
      Effect.provide(
        runCommand({
          command,
          args,
          timeout,
          maxOutputBytes: 1024 * 1024,
        }),
        processLayer({})
      ),
      { signal }
    );
    return { code: result.code, stdout: result.stdout.toString('utf8') };
  } catch {
    return null;
  }
}

async function collectProtectedPids(signal?: AbortSignal): Promise<Set<number>> {
  const protectedPids = new Set<number>([process.pid]);
  if (process.ppid > 1) protectedPids.add(process.ppid);
  if (process.platform === 'win32') return protectedPids;

  let cursor = process.ppid;
  for (let depth = 0; depth < 16 && cursor > 1; depth += 1) {
    const res = await execCommandText('ps', ['-o', 'ppid=', '-p', String(cursor)], signal, 2_000);
    if (!res || res.code !== 0) break;
    const nextParent = Number(res.stdout.trim());
    if (!Number.isSafeInteger(nextParent) || nextParent <= 1 || protectedPids.has(nextParent)) {
      break;
    }
    protectedPids.add(nextParent);
    cursor = nextParent;
  }
  return protectedPids;
}

async function filterPidsByUidLinux(pids: number[], uid: number): Promise<number[]> {
  const owned: number[] = [];
  for (const pid of pids) {
    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const match = /^Uid:\s+(\d+)/m.exec(status);
      if (match && Number(match[1]) === uid) {
        owned.push(pid);
      }
    } catch {
      // Process exited or belongs to another user.
    }
  }
  return owned;
}

async function findListeningPids(port: number, signal?: AbortSignal): Promise<number[]> {
  if (process.platform === 'win32') {
    const script = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
    const res = await execCommandText(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      signal
    );
    return res && res.code === 0 ? parseWindowsListeningPids(res.stdout) : [];
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const lsofArgs = ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pun'];
  const lsof =
    (await execCommandText('lsof', lsofArgs, signal)) ??
    (process.platform === 'darwin'
      ? await execCommandText('/usr/sbin/lsof', lsofArgs, signal)
      : null);
  if (lsof) {
    // lsof exits 1 when no process matches the port filter.
    return lsof.code === 0 ? parseLsofListeningPids(lsof.stdout, { port, uid }) : [];
  }

  if (process.platform === 'linux') {
    const ss = await execCommandText('ss', ['-H', '-ltnp'], signal);
    if (ss && ss.code === 0) {
      const pids = parseSsListeningPids(ss.stdout, port);
      return uid !== undefined ? filterPidsByUidLinux(pids, uid) : pids;
    }
  }

  return [];
}

/**
 * Stop the user-owned loopback server process(es) listening on an approved
 * preview target port. Never signals Lody's own daemon, parent/Electron host,
 * ancestor processes, or non-loopback targets.
 */
export async function stopPreviewTargetProcess(
  target: PreviewTarget,
  options?: { logger?: Logger; signal?: AbortSignal }
): Promise<{ stoppedPids: number[] }> {
  if (
    !isLoopbackPreviewHost(target.host) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535
  ) {
    throw new Error('Refusing to stop process for non-loopback or invalid preview target.');
  }

  const [listeningPids, protectedPids] = await Promise.all([
    findListeningPids(target.port, options?.signal),
    collectProtectedPids(options?.signal),
  ]);
  const targetPids = listeningPids.filter((pid) => !protectedPids.has(pid));
  if (targetPids.length === 0) {
    return { stoppedPids: [] };
  }

  const failures: unknown[] = [];
  const stoppedPids: number[] = [];
  for (const pid of targetPids) {
    try {
      await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(NodeProcess, (np) =>
            terminateTree(pidTree(np, pid), PROCESS_TERMINATION_POLICY)
          ),
          processLayer({})
        ),
        { signal: options?.signal }
      );
      stoppedPids.push(pid);
    } catch (error) {
      failures.push(error);
      options?.logger?.warn(
        `Failed to stop preview server process ${pid} on port ${target.port}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (failures.length > 0 && stoppedPids.length === 0) {
    throw new Error(`Unable to stop the server process listening on port ${target.port}.`);
  }

  return { stoppedPids };
}
