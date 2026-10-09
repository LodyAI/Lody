import { startProcess } from '@lody/shared/node/process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { SimulatorHostControl } from './host-controls';

export type BaguetteProcess = {
  port: number;
  closed: Promise<void>;
  stop(): Promise<void>;
  control(udid: string, control: SimulatorHostControl): Promise<void>;
};
export async function startBaguetteProcess(
  binary: string,
  signal: AbortSignal,
  workerPath = fileURLToPath(new URL('./baguette-worker.js', import.meta.url))
): Promise<BaguetteProcess> {
  signal.throwIfAborted();
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'DEVELOPER_DIR', 'ELECTRON_RUN_AS_NODE'])
    if (process.env[key]) env[key] = process.env[key];
  const { child: worker } = startProcess({
    command: process.execPath,
    args: [workerPath, binary],
    processGroup: false,
    options: { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  });
  const stop = () => {
    if (worker.connected) worker.disconnect();
  };
  let resolveReady: (port: number) => void = () => {};
  let rejectReady: (reason: unknown) => void = () => {};
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let sequence = 0;
  let pending: { id: number; resolve(): void; reject(reason: Error): void } | undefined;
  const closed = new Promise<void>((resolve) => {
    const end = () => {
      signal.removeEventListener('abort', stop);
      rejectReady(new Error('Simulator capture process stopped.'));
      pending?.reject(new Error('Simulator control stopped.'));
      pending = undefined;
      resolve();
    };
    worker.once('exit', end);
    worker.once('error', () => {
      if (!worker.pid) end();
      else stop();
    });
  });
  worker.on('message', (raw: unknown) => {
    const result = z
      .object({
        type: z.literal('control-result'),
        id: z.number().int().positive(),
        success: z.boolean(),
      })
      .strict()
      .safeParse(raw);
    if (result.success && pending?.id === result.data.id) {
      if (result.data.success) pending.resolve();
      else pending.reject(new Error('Simulator control failed.'));
      pending = undefined;
      return;
    }
    const parsed = z
      .object({ type: z.literal('ready'), port: z.number().int().min(1).max(65535) })
      .strict()
      .safeParse(raw);
    if (parsed.success) resolveReady(parsed.data.port);
    else {
      rejectReady(new Error('Invalid simulator worker response.'));
      stop();
    }
  });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    const port = await ready;
    signal.throwIfAborted();
    return {
      port,
      closed,
      control: (udid, control) =>
        new Promise<void>((resolve, reject) => {
          if (pending || !worker.connected) {
            reject(new Error('Simulator control unavailable.'));
            return;
          }
          const id = ++sequence;
          pending = { id, resolve, reject };
          worker.send({ type: 'control', id, udid, control }, (error) => {
            if (error) stop();
          });
        }),
      stop: async () => {
        stop();
        await closed;
      },
    };
  } catch (error) {
    stop();
    await closed;
    throw error;
  }
}
