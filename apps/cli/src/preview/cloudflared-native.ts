import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export class CloudflaredError extends Error {
  constructor(
    readonly stage: 'start' | 'connection' | 'stop',
    message: string,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'CloudflaredError';
  }
}

export type CloudflaredProcess = {
  /** Address allocation alone is not readiness; the manager probes the public route. */
  origin: string;
  closed: Promise<CloudflaredError | null>;
  diagnostic(): string | undefined;
  stop(): Promise<void>;
};

type SpawnCloudflared = (
  binary: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

const LogLine = z.object({
  message: z.string(),
  level: z.string().optional(),
  error: z.string().optional(),
});
const QUICK_ORIGIN = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;
const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 3_000;
const MAX_LOG_LINE_BYTES = 64 * 1024;

export function parseQuickTunnelOrigin(message: string): string | undefined {
  // Fixed cloudflared release's LogTable row, not an arbitrary URL elsewhere in logs.
  const row = /^\|\s+(https:\/\/\S+)\s+\|$/.exec(message.trim());
  if (!row) return undefined;
  const origin = row[1];
  if (!origin || !QUICK_ORIGIN.test(origin)) {
    throw new CloudflaredError('start', 'cloudflared returned an invalid Quick Tunnel origin');
  }
  return origin;
}

function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // No TUNNEL_*, CF_*, Lody tokens, or ambient configuration is inherited.
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/** Thin process boundary. One owner calls stop and waits for confirmed process exit. */
export async function startCloudflaredNative(options: {
  binary: string;
  proxyOrigin: string;
  signal: AbortSignal;
  spawn?: SpawnCloudflared;
  env?: NodeJS.ProcessEnv;
  onDiagnostic?: (message: string) => void;
}): Promise<CloudflaredProcess> {
  options.signal.throwIfAborted();
  const proxy = new URL(options.proxyOrigin);
  if (
    proxy.protocol !== 'http:' ||
    proxy.hostname !== '127.0.0.1' ||
    !proxy.port ||
    proxy.pathname !== '/' ||
    proxy.search ||
    proxy.hash ||
    proxy.username ||
    proxy.password
  ) {
    throw new CloudflaredError('start', 'cloudflared requires an owned loopback proxy origin');
  }
  const configDir = await mkdtemp(join(tmpdir(), 'lody-cloudflared-'));
  const configFile = join(configDir, 'config.yaml');
  let child: ChildProcessWithoutNullStreams;
  try {
    await writeFile(configFile, '{}\n', { mode: 0o600 });
    options.signal.throwIfAborted();
    child = (options.spawn ?? spawn)(
      options.binary,
      [
        'tunnel',
        '--config',
        configFile,
        '--no-autoupdate',
        '--output',
        'json',
        '--metrics',
        '127.0.0.1:0',
        '--protocol',
        'auto',
        '--url',
        proxy.origin,
      ],
      { cwd: configDir, env: childEnvironment(options.env ?? process.env), windowsHide: true }
    );
  } catch (error) {
    await rm(configDir, { recursive: true });
    throw new CloudflaredError('start', 'Unable to start cloudflared', error);
  }

  let stopping = false;
  let exited = false;
  let exitError: CloudflaredError | null = null;
  let lastDiagnostic = '';
  let resolveExit: (error: CloudflaredError | null) => void = () => {};
  const closed = new Promise<CloudflaredError | null>((resolve) => {
    resolveExit = resolve;
  });
  let resolveOrigin: (origin: string) => void = () => {};
  let rejectOrigin: (error: unknown) => void = () => {};
  const originPromise = new Promise<string>((resolve, reject) => {
    resolveOrigin = resolve;
    rejectOrigin = reject;
  });
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      if (!exited) {
        child.kill('SIGTERM');
        const force = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, STOP_GRACE_MS);
        force.unref();
        try {
          await closed;
        } finally {
          clearTimeout(force);
        }
      }
      await rm(configDir, { recursive: true });
    })();
    return stopPromise;
  };
  const abort = () => {
    rejectOrigin(options.signal.reason);
    // The caller's failure path owns awaiting cleanup; this listener only signals.
    if (!exited) child.kill('SIGTERM');
  };
  options.signal.addEventListener('abort', abort, { once: true });
  child.once('error', (error) => {
    exitError = new CloudflaredError('start', 'cloudflared could not be started', error);
    rejectOrigin(exitError);
  });
  child.once('close', (code, signal) => {
    exited = true;
    options.signal.removeEventListener('abort', abort);
    if (!stopping && !exitError) {
      exitError = new CloudflaredError(
        'connection',
        `cloudflared exited (${signal ?? code ?? 'unknown'})${lastDiagnostic ? `: ${lastDiagnostic}` : ''}`
      );
    }
    rejectOrigin(
      exitError ?? new CloudflaredError('start', 'cloudflared stopped before creating a tunnel')
    );
    resolveExit(exitError);
  });

  const consume = (stream: NodeJS.ReadableStream) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_LOG_LINE_BYTES) {
        rejectOrigin(new CloudflaredError('start', 'cloudflared log line exceeded its size limit'));
        child.kill('SIGTERM');
        pending = '';
        return;
      }
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const log = LogLine.parse(JSON.parse(line));
          const origin = parseQuickTunnelOrigin(log.message);
          if (origin) resolveOrigin(origin);
          if (log.level === 'error' || log.level === 'fatal') {
            // Never retain arbitrary URLs, tokens or the full process log.
            lastDiagnostic = [log.message, log.error]
              .filter(Boolean)
              .join(': ')
              .replace(/https?:\/\/\S+/g, '[url]')
              .slice(0, 300);
            options.onDiagnostic?.(lastDiagnostic);
          }
        } catch (error) {
          rejectOrigin(new CloudflaredError('start', 'Invalid cloudflared JSON output', error));
          child.kill('SIGTERM');
        }
      }
    });
  };
  consume(child.stdout);
  consume(child.stderr);
  const timer = setTimeout(
    () =>
      rejectOrigin(
        new CloudflaredError(
          'start',
          'Timed out creating a Quick Tunnel; check connectivity to Cloudflare and outbound port 7844'
        )
      ),
    START_TIMEOUT_MS
  );
  timer.unref();
  try {
    if (options.signal.aborted) abort();
    const origin = await originPromise;
    options.signal.throwIfAborted();
    if (exited) throw exitError ?? new CloudflaredError('start', 'cloudflared already exited');
    return { origin, closed, stop, diagnostic: () => lastDiagnostic || undefined };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
