import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureEngineHost } from '@loro-dev/loro-repo-client/node';

/** Stop after this long with no connected client. */
export const NATIVE_REPO_HOST_IDLE_MS = 60_000;
const EXIT_POLL_MS = 500;

/** What `hardenHostProcess` put into effect (the engine's `HostHardening`). */
export interface NativeHostHardening {
  readonly coreDumpsDisabled: boolean;
  readonly dumpableCleared: boolean;
  readonly platform: string;
  readonly limitations: readonly string[];
}

/** The host's own log: one JSON line per start, kept beside the engine files. */
const HOST_LOG = 'host.log';
const HOST_LOG_MAX_BYTES = 256 * 1024;

/**
 * Records one start: process id, descriptors closed and hardening. The values are
 * booleans, counts and platform names only, never key material or paths.
 */
async function logHostStart(dataDir: string, entry: Record<string, unknown>) {
  const file = join(dataDir, HOST_LOG);
  const size = await stat(file).then(
    (info) => info.size,
    () => 0
  );
  if (size > HOST_LOG_MAX_BYTES) await rename(file, `${file}.1`).catch(() => {});
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * The separate host process. `files.lock` makes it unique: a second launch
 * attaches as a client and exits. It keeps no client of its own, so the engine
 * idles out after the last daemon or desktop connection closes.
 */
export async function runNativeRepoHost(
  dataDir: string,
  addon: Parameters<typeof ensureEngineHost>[0]['addon'] & {
    readonly closeInheritedDescriptors: () => number;
    readonly hardenHostProcess: () => NativeHostHardening;
  }
): Promise<void> {
  const closedDescriptors = addon.closeInheritedDescriptors();
  /** Before any key reaches this process: no core file, and on Linux no ptrace or memory reads. */
  const hardening = addon.hardenHostProcess();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await logHostStart(dataDir, {
    at: new Date().toISOString(),
    event: 'start',
    pid: process.pid,
    closedDescriptors,
    hardening,
  }).catch(() => {});
  const host = await ensureEngineHost({
    addon,
    dataDir,
    idleMs: NATIVE_REPO_HOST_IDLE_MS,
    clientOptions: { autoReconnect: false },
  });
  const engine = host.engine;
  await host.client.close();
  if (!engine) return;
  const stop = () => engine.stop();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!engine.exited) return;
      clearInterval(timer);
      resolve();
    }, EXIT_POLL_MS);
  });
}
