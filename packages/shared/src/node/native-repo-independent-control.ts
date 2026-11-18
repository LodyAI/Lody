import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  link,
  unlink,
  rename,
} from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import { z } from 'zod';

export const INDEPENDENT_REPO_FORMAT = 1 as const;
export const INDEPENDENT_REPO_VERSION = '0.1.0' as const;
export const CONTROL_FRAME_BYTES = 8 * 1024;
export const independentModeSchema = z
  .object({
    format: z.literal(1),
    mode: z.literal('independent'),
    sdkVersion: z.literal('0.1.0'),
    bindingSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const independentRunSchema = independentModeSchema
  .extend({
    controlId: z.string().uuid(),
    startupId: z.string().uuid(),
    token: z.string().min(32).max(128),
    socket: z.string().min(1),
    pid: z.number().int().positive(),
    engineRunId: z.string().min(1),
    handoff: z.literal('brokered-v1').optional(),
    launcherPid: z.number().int().positive().optional(),
    sdkArtifactId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type IndependentRepoRun = z.infer<typeof independentRunSchema>;
export const controlRequestSchema = z
  .object({
    op: z.enum(['acquire', 'activate', 'release', 'retire_workspace']),
    engineRunId: z.string().min(1).optional(),
    token: z.string().min(1).max(128),
    controlId: z.string().uuid(),
    startupId: z.string().uuid().optional(),
  })
  .strict();
export const controlReplySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('leased'),
      controlId: z.string().uuid(),
      engineRunId: z.string(),
      sdkArtifactId: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      bootstrap: z.boolean(),
      pid: z.number().int().positive(),
      handoff: z.literal('brokered-v1').optional(),
      launcherPid: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ type: z.literal('active') }).strict(),
  z.object({ type: z.literal('released'), hostStopped: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('error'),
      code: z.enum([
        'unauthorized',
        'starting',
        'draining',
        'protocol',
        'storage',
        'stop_failed',
        'capacity',
      ]),
    })
    .strict(),
]);
export type ControlReply = z.infer<typeof controlReplySchema>;
export class IndependentRepoControlError extends Error {
  constructor(readonly code: string) {
    super(`Independent native Repo control: ${code}`);
  }
}

export const independentBindingHash = (binding: string) =>
  createHash('sha256').update(z.string().min(1).parse(binding)).digest('hex');
export const independentRunPath = (dataDir: string) => path.join(dataDir, 'independent-run.json');

/** Same-user private directory/file boundary. Windows inherits the profile ACL. */
export async function assertIndependentPrivatePath(
  target: string,
  directory: boolean
): Promise<void> {
  const stat = await lstat(target);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())))
  ) {
    throw new IndependentRepoControlError('private_path_required');
  }
}

export async function readIndependentPrivateJson(target: string): Promise<unknown> {
  await assertIndependentPrivatePath(target, false);
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (stat.size > CONTROL_FRAME_BYTES)
      throw new IndependentRepoControlError('metadata_too_large');
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

/** Persistent fixed mode is published atomically; it never adopts an unmarked engine directory. */
export async function prepareIndependentRepoDirectory(
  dataDir: string,
  binding: string
): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await assertIndependentPrivatePath(dataDir, true);
  const canonical = await realpath(dataDir);
  const file = path.join(canonical, 'independent-mode.json');
  const expected = {
    format: INDEPENDENT_REPO_FORMAT,
    mode: 'independent' as const,
    sdkVersion: INDEPENDENT_REPO_VERSION,
    bindingSha256: independentBindingHash(binding),
  };
  try {
    const actual = independentModeSchema.parse(await readIndependentPrivateJson(file));
    if (actual.bindingSha256 !== expected.bindingSha256)
      throw new IndependentRepoControlError('binding_mismatch');
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const names = await readdir(canonical);
  if (names.some((name) => !/^\.independent-mode-[0-9a-f-]+\.tmp$/.test(name))) {
    // A concurrent creator may have published while readdir ran.
    try {
      const actual = independentModeSchema.parse(await readIndependentPrivateJson(file));
      if (actual.bindingSha256 === expected.bindingSha256) return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    throw new IndependentRepoControlError('unmarked_data_requires_migration');
  }
  const scratch = path.join(canonical, `.independent-mode-${randomUUID()}.tmp`);
  const handle = await open(scratch, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(expected));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(scratch, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await unlink(scratch);
  }
  const actual = independentModeSchema.parse(await readIndependentPrivateJson(file));
  if (actual.bindingSha256 !== expected.bindingSha256)
    throw new IndependentRepoControlError('binding_mismatch');
  return canonical;
}

export async function publishIndependentRun(
  dataDir: string,
  run: IndependentRepoRun
): Promise<void> {
  const scratch = path.join(dataDir, `.independent-run-${randomUUID()}.tmp`);
  const handle = await open(scratch, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(independentRunSchema.parse(run)));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(scratch, independentRunPath(dataDir));
  } catch (error) {
    await unlink(scratch).catch(() => {});
    throw error;
  }
  await chmod(independentRunPath(dataDir), 0o600);
}

export async function readIndependentRun(
  dataDir: string,
  binding: string
): Promise<IndependentRepoRun> {
  await assertIndependentPrivatePath(dataDir, true);
  const run = independentRunSchema.parse(
    await readIndependentPrivateJson(independentRunPath(dataDir))
  );
  if (run.bindingSha256 !== independentBindingHash(binding))
    throw new IndependentRepoControlError('binding_mismatch');
  return run;
}

/** One authenticated stream = one lease. Tokens never leave this Node-only module. */
export class IndependentRepoControlChannel {
  private buffer = '';
  private pending:
    | {
        resolve: (reply: ControlReply) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private ended = false;
  readonly lost: Promise<void>;
  private resolveLost: () => void = () => {};
  get isClosed(): boolean {
    return this.ended;
  }
  private constructor(
    private readonly socket: Socket,
    private readonly run: IndependentRepoRun
  ) {
    this.lost = new Promise<void>((resolve) => {
      this.resolveLost = resolve;
    });
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      if (Buffer.byteLength(this.buffer) > CONTROL_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const pending = this.pending;
      if (!pending) {
        socket.destroy();
        return;
      }
      this.pending = undefined;
      clearTimeout(pending.timer);
      try {
        const reply = controlReplySchema.parse(JSON.parse(line));
        if (reply.type === 'error') pending.reject(new IndependentRepoControlError(reply.code));
        else pending.resolve(reply);
      } catch (error) {
        pending.reject(error);
        socket.destroy();
      }
    });
    const closed = () => {
      this.ended = true;
      this.resolveLost();
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new IndependentRepoControlError('disconnected'));
      }
    };
    socket.on('close', closed);
    socket.on('error', () => socket.destroy());
  }

  static async open(
    run: IndependentRepoRun,
    signal?: AbortSignal
  ): Promise<IndependentRepoControlChannel> {
    const socket = connect(run.socket);
    const channel = new IndependentRepoControlChannel(socket, run);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new IndependentRepoControlError('connect_timeout'));
      }, 1_000);
      const abort = () => {
        socket.destroy();
        finish(new IndependentRepoControlError('cancelled'));
      };
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        socket.off('connect', connected);
        socket.off('error', failed);
        error ? reject(error) : resolve();
      };
      const connected = () => finish();
      const failed = (error: Error) => finish(error);
      socket.once('connect', connected);
      socket.once('error', failed);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }).catch((error) => {
      channel.destroy();
      throw error;
    });
    return channel;
  }

  request(
    op: 'acquire' | 'activate' | 'release' | 'retire_workspace',
    startupId?: string
  ): Promise<ControlReply> {
    if (this.ended) return Promise.reject(new IndependentRepoControlError('disconnected'));
    if (this.pending) return Promise.reject(new IndependentRepoControlError('request_in_progress'));
    return new Promise<ControlReply>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending = undefined;
          this.socket.destroy();
          reject(new IndependentRepoControlError('request_timeout'));
        },
        op === 'release' || op === 'retire_workspace' ? 7_000 : 1_000
      );
      this.pending = { resolve, reject, timer };
      this.socket.write(
        JSON.stringify({
          op,
          token: this.run.token,
          controlId: this.run.controlId,
          ...(op === 'retire_workspace' ? { engineRunId: this.run.engineRunId } : {}),
          ...(startupId === undefined ? {} : { startupId }),
        }) + '\n'
      );
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}
