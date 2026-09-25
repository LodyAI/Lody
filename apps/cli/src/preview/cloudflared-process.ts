import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CloudflaredError, type CloudflaredProcess } from './cloudflared-native';

export { CloudflaredError, type CloudflaredProcess } from './cloudflared-native';

const WorkerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('origin'),
    origin: z.string().regex(/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/),
  }),
  z.object({ type: z.literal('diagnostic'), message: z.string() }),
  z.object({
    type: z.literal('error'),
    stage: z.enum(['start', 'connection', 'stop']),
    message: z.string(),
  }),
]);

function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'ELECTRON_RUN_AS_NODE',
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

/** IPC shutdown/disconnect releases ownership; never kill the owner before it reaps cloudflared. */
export async function startCloudflaredProcess(options: {
  binary: string;
  proxyOrigin: string;
  signal: AbortSignal;
  /** Explicit entry for source-based integration fixtures; production uses only its bundle. */
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CloudflaredProcess> {
  options.signal.throwIfAborted();
  const worker = spawn(
    process.execPath,
    [
      options.workerPath ?? fileURLToPath(new URL('./cloudflared-worker.js', import.meta.url)),
      options.binary,
      options.proxyOrigin,
    ],
    {
      env: workerEnvironment(options.env ?? process.env),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    }
  );
  let failure: CloudflaredError | null = null;
  let diagnostic: string | undefined;
  let stopping = false;
  let resolveOrigin: (origin: string) => void = () => {};
  let rejectOrigin: (error: unknown) => void = () => {};
  const origin = new Promise<string>((resolve, reject) => {
    resolveOrigin = resolve;
    rejectOrigin = reject;
  });
  const release = () => {
    if (stopping) return;
    stopping = true;
    if (worker.connected) {
      worker.send({ type: 'stop' }, (error) => {
        if (!error) return;
        // A concurrent exit may close IPC first. Revoke the lease and use the
        // terminal error/exit code below, never mistake the send for cleanup.
        if (worker.connected) worker.disconnect();
      });
    }
  };
  const abort = () => {
    rejectOrigin(options.signal.reason);
    release();
  };
  const closed = new Promise<CloudflaredError | null>((resolve) => {
    worker.once('error', (cause) => {
      failure = new CloudflaredError(
        'start',
        'Unable to start cloudflared lifecycle worker',
        cause
      );
      rejectOrigin(failure);
      if (worker.pid === undefined) {
        options.signal.removeEventListener('abort', abort);
        resolve(failure);
      }
    });
    // No piped stdio needs draining. IPC disconnect requests release; the OS
    // exit notification, not a signal sent, is the cleanup barrier.
    worker.once('exit', (code, signal) => {
      options.signal.removeEventListener('abort', abort);
      if (!failure && (!stopping || code !== 0)) {
        failure = new CloudflaredError(
          stopping ? 'stop' : 'connection',
          `cloudflared lifecycle worker exited (${signal ?? code ?? 'unknown'})`
        );
      }
      rejectOrigin(
        failure ?? new CloudflaredError('start', 'cloudflared stopped before creating a tunnel')
      );
      resolve(failure);
    });
  });
  worker.on('message', (raw: unknown) => {
    const result = WorkerMessage.safeParse(raw);
    if (!result.success) {
      failure = new CloudflaredError(
        'connection',
        'Invalid cloudflared lifecycle message',
        result.error
      );
      rejectOrigin(failure);
      release();
      return;
    }
    const message = result.data;
    if (message.type === 'origin') resolveOrigin(message.origin);
    else if (message.type === 'diagnostic') diagnostic = message.message;
    else {
      failure = new CloudflaredError(message.stage, message.message);
      rejectOrigin(failure);
    }
  });
  const stop = async () => {
    release();
    const error = await closed;
    if (error?.stage === 'stop') throw error;
  };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal.aborted) abort();
    const allocated = await origin;
    options.signal.throwIfAborted();
    if (failure) throw failure;
    return { origin: allocated, closed, stop, diagnostic: () => diagnostic };
  } catch (error) {
    await stop();
    throw error;
  }
}
