import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import {
  CONTROL_FRAME_BYTES,
  assertIndependentPrivatePath,
  controlRequestSchema,
  independentModeSchema,
  independentRunPath,
  publishIndependentRun,
  readIndependentPrivateJson,
  type ControlReply,
  type IndependentRepoRun,
} from './native-repo-independent-control';

const workerReadySchema = z
  .object({
    type: z.literal('ready'),
    engineRunId: z.string().min(1),
    version: z.literal('0.1.0'),
    protocol: z.literal(2),
    sdkArtifactId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

/** Node control-I/O adapter. The process owns its native Worker, never its launcher's lifetime. */
export async function runIndependentNativeRepoController(args: {
  readonly dataDir: string;
  readonly startupId: string;
  readonly workerEntry: string;
  readonly brokeredHandoff?: true;
}): Promise<void> {
  if (process.platform === 'win32' && !args.brokeredHandoff)
    throw new Error('Windows independent process handoff is unavailable');
  await assertIndependentPrivatePath(args.dataDir, true);
  const mode = independentModeSchema.parse(
    await readIndependentPrivateJson(path.join(args.dataDir, 'independent-mode.json'))
  );
  z.string().uuid().parse(args.startupId);
  const worker = new Worker(args.workerEntry, { workerData: { dataDir: args.dataDir } });
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const ready = await new Promise<z.infer<typeof workerReadySchema>>((resolve, reject) => {
    const failure = () => reject(new Error('Independent native engine did not start'));
    worker.once('error', failure);
    worker.once('exit', failure);
    worker.on('message', (value: unknown) => {
      const parsed = workerReadySchema.safeParse(value);
      if (!parsed.success) return;
      clearTimeout(readyTimer);
      worker.off('error', failure);
      worker.off('exit', failure);
      resolve(parsed.data);
    });
    readyTimer = setTimeout(
      () => reject(new Error('Independent native engine start timed out')),
      10_000
    );
  }).catch((error) => {
    clearTimeout(readyTimer);
    // The process entry reports failure and exits; no second engine is started
    // from this controller while the Worker might still own its native lock.
    throw error;
  });
  const controlId = randomUUID();
  let socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\lody-repo-control-${controlId}`
      : path.join(args.dataDir, 'sock', `c${controlId.replaceAll('-', '').slice(0, 6)}`);
  // Persistent profile paths routinely exceed macOS's Unix socket limit.
  // An exclusive 0700 random directory keeps the short endpoint private;
  // authenticated discovery remains in the original bound data directory.
  let shortSocketDirectory: string | undefined;
  if (process.platform !== 'win32' && Buffer.byteLength(socketPath, 'utf8') > 96) {
    shortSocketDirectory = await mkdtemp('/tmp/lody-repo-control-');
    await chmod(shortSocketDirectory, 0o700);
    await assertIndependentPrivatePath(shortSocketDirectory, true);
    socketPath = path.join(shortSocketDirectory, 's');
  }
  if (process.platform !== 'win32')
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const run: IndependentRepoRun = {
    ...mode,
    controlId,
    startupId: args.startupId,
    token: randomBytes(32).toString('base64url'),
    socket: socketPath,
    pid: process.pid,
    engineRunId: ready.engineRunId,
    ...(args.brokeredHandoff ? { handoff: 'brokered-v1' as const, launcherPid: process.ppid } : {}),
    ...(ready.sdkArtifactId ? { sdkArtifactId: ready.sdkArtifactId } : {}),
  };
  const sockets = new Set<Socket>();
  const leases = new Set<Socket>();
  const retiringLeases = new Set<Socket>();
  let phase: 'starting' | 'active' | 'draining' = 'starting';
  let bootstrap: Socket | undefined;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let shutdownPromise: Promise<void> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const reply = (socket: Socket, value: ControlReply, close = false) => {
    const frame = JSON.stringify(value) + '\n';
    if (close) socket.end(frame, () => socket.destroy());
    else socket.write(frame);
  };
  const fatal = () => {
    // No leases may remain when the controller requests shutdown. This is a
    // bounded self-termination fallback, not authority to signal another owner.
    process.stderr.write('Independent native Repo host stop failed\n');
    process.exit(70);
  };
  const server = createServer((socket) => {
    if (sockets.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setTimeout(1_000, () => socket.destroy());
    let buffer = '';
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      retiringLeases.delete(socket);
      if (!leases.delete(socket)) return;
      const abandonedBootstrap = bootstrap === socket;
      if (abandonedBootstrap) bootstrap = undefined;
      if (leases.size === 0 && (phase === 'active' || (args.brokeredHandoff && abandonedBootstrap)))
        void shutdown().catch(fatal);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > CONTROL_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const parsed = (() => {
        try {
          return controlRequestSchema.safeParse(JSON.parse(frame));
        } catch {
          return undefined;
        }
      })();
      if (!parsed?.success || buffer.length !== 0) {
        reply(socket, { type: 'error', code: 'protocol' }, true);
        return;
      }
      const request = parsed.data;
      const actual = Buffer.from(request.token);
      const expected = Buffer.from(run.token);
      if (
        request.controlId !== run.controlId ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        reply(socket, { type: 'error', code: 'unauthorized' }, true);
        return;
      }
      if (request.op === 'acquire') {
        if (leases.size >= 64) {
          reply(socket, { type: 'error', code: 'capacity' }, true);
          return;
        }
        if (phase === 'draining') {
          reply(socket, { type: 'error', code: 'draining' }, true);
          return;
        }
        if (
          leases.has(socket) ||
          (phase === 'starting' && (request.startupId !== run.startupId || bootstrap !== undefined))
        ) {
          reply(socket, { type: 'error', code: 'starting' }, true);
          return;
        }
        const isBootstrap = phase === 'starting';
        leases.add(socket);
        socket.setTimeout(0);
        if (isBootstrap) bootstrap = socket;
        reply(socket, {
          type: 'leased',
          controlId,
          engineRunId: run.engineRunId,
          ...(run.sdkArtifactId ? { sdkArtifactId: run.sdkArtifactId } : {}),
          bootstrap: isBootstrap,
          pid: process.pid,
          ...(args.brokeredHandoff
            ? { handoff: 'brokered-v1' as const, launcherPid: run.launcherPid }
            : {}),
        });
      } else if (request.op === 'retire_workspace') {
        // A private authenticated Node owner retires this exact run, including
        // foreign observer leases. Never resolve a successor's discovery here.
        if (request.engineRunId !== run.engineRunId || phase !== 'active') {
          reply(socket, { type: 'error', code: 'protocol' }, true);
          return;
        }
        phase = 'draining';
        for (const lease of leases) retiringLeases.add(lease);
        leases.clear();
        void shutdown(socket).catch(fatal);
      } else if (request.op === 'activate') {
        if (
          !leases.has(socket) ||
          bootstrap !== socket ||
          request.startupId !== run.startupId ||
          phase !== 'starting'
        ) {
          reply(socket, { type: 'error', code: 'protocol' }, true);
          return;
        }
        phase = 'active';
        clearTimeout(startupTimer);
        bootstrap = undefined;
        reply(socket, { type: 'active' });
      } else {
        if (phase === 'draining' && retiringLeases.delete(socket)) {
          // Retirement already surrendered this exact authenticated lease.
          // Its ordinary release may race the asynchronous engine shutdown.
          reply(socket, { type: 'released', hostStopped: false }, true);
          return;
        }
        if (!leases.delete(socket)) {
          reply(socket, { type: 'error', code: 'protocol' }, true);
          return;
        }
        const abandonedBootstrap = bootstrap === socket;
        if (abandonedBootstrap) bootstrap = undefined;
        if (
          leases.size === 0 &&
          (phase === 'active' || (args.brokeredHandoff && abandonedBootstrap))
        )
          void shutdown(socket).catch(fatal);
        else reply(socket, { type: 'released', hostStopped: false }, true);
      }
    });
  });
  const shutdown = (last?: Socket): Promise<void> =>
    (shutdownPromise ??= (async () => {
      phase = 'draining';
      clearTimeout(startupTimer);
      // Retire discovery before releasing the native writer lock. Random control
      // socket names cannot accidentally unlink a successor's listener.
      await unlink(independentRunPath(args.dataDir));
      server.close(() => finish());
      for (const socket of sockets) if (socket !== last) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        const watchdog = setTimeout(fatal, 5_000);
        const message = (value: unknown) => {
          if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'stopped')
            return;
          clearTimeout(watchdog);
          worker.off('message', message);
          resolve();
        };
        const failed = () => {
          clearTimeout(watchdog);
          reject(new Error('Independent native engine stop was not acknowledged'));
        };
        worker.once('error', failed);
        worker.on('message', message);
        worker.postMessage({ type: 'stop' });
      });
      if (last) reply(last, { type: 'released', hostStopped: true }, true);
      if (sockets.size === 0) finish();
    })());
  worker.on('error', fatal);
  worker.on('exit', () => {
    if (phase !== 'draining') fatal();
  });
  server.on('error', fatal);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  await publishIndependentRun(args.dataDir, run);
  startupTimer = setTimeout(() => {
    if (phase === 'starting') void shutdown().catch(fatal);
  }, 15_000);
  await finished;
  if (shortSocketDirectory) await rmdir(shortSocketDirectory);
}
