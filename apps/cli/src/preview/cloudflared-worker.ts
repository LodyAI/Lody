import { z } from 'zod';
import { CloudflaredError, startCloudflaredNative } from './cloudflared-native';

// This child is an ownership boundary, not a watchdog. The IPC pipe is its lease.
const controller = new AbortController();
const stop = () => controller.abort(new Error('cloudflared owner disconnected'));
process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
const requestStop = (message: unknown) => {
  const command = z
    .object({ type: z.literal('stop') })
    .strict()
    .safeParse(message);
  if (!command.success) {
    process.exitCode = 1;
    void send({
      type: 'error',
      stage: 'stop',
      message: 'Invalid cloudflared lifecycle request',
    }).catch(stop);
  }
  stop();
};
process.on('message', requestStop);

async function send(message: object): Promise<void> {
  if (!process.connected || !process.send) return;
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      // Loss of the owner races normal reporting; it still mandates cleanup.
      if (error && !controller.signal.aborted) reject(error);
      else resolve();
    });
  });
}

try {
  if (!process.connected) throw new Error('cloudflared worker requires a live IPC owner');
  const [binary, proxyOrigin] = z
    .tuple([z.string().min(1), z.string().url()])
    .parse(process.argv.slice(2));
  const child = await startCloudflaredNative({
    binary,
    proxyOrigin,
    signal: controller.signal,
    onDiagnostic: (message) => {
      void send({ type: 'diagnostic', message }).catch(stop);
    },
  });
  try {
    controller.signal.throwIfAborted();
    await send({ type: 'origin', origin: child.origin });
    const aborted = new Promise<null>((resolve) => {
      if (controller.signal.aborted) resolve(null);
      else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    const error = await Promise.race([child.closed, aborted]);
    if (error) throw error;
  } finally {
    await child.stop();
  }
} catch (error) {
  // Cancellation is expected; actual startup/exit/cleanup failures remain explicit.
  if (error !== controller.signal.reason) {
    process.exitCode = 1;
    await send({
      type: 'error',
      stage: error instanceof CloudflaredError ? error.stage : 'stop',
      message: error instanceof Error ? error.message : 'cloudflared worker failed',
    });
  }
} finally {
  process.removeListener('disconnect', stop);
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
  process.removeListener('message', requestStop);
  if (process.connected) process.disconnect();
}
