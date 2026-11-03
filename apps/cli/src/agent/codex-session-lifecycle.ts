import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { startProcessLegacy } from '@lody/shared/node/process';
import { toShared } from '@/platform/process-options';
import type { Logger } from '@/utils/logger';
import { version } from '@/pkg';

const ResponseSchema = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number() }).optional(),
});
const ThreadSchema = z.object({
  thread: z.object({ id: z.string(), path: z.string().min(1) }),
});

function inside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Native lifecycle operations never resume a thread or start an agent turn. */
export async function setCodexThreadArchived(options: {
  command: string;
  args?: string[];
  env: NodeJS.ProcessEnv;
  threadId: string;
  archived: boolean;
  signal?: AbortSignal;
  logger?: Logger;
  onSpawned?: (pid: number | undefined) => void;
  shouldApply?: () => Promise<boolean>;
}): Promise<void> {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  signal.throwIfAborted();
  const home = options.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  if (!home.trim()) throw new Error('Codex home is empty');
  let sequence = 0;
  let terminalError: Error | undefined;
  let rejectGuard: ((error: Error) => void) | undefined;
  let pending:
    | { id: number; resolve: (result: unknown) => void; reject: (error: Error) => void }
    | undefined;
  const fail = (error: Error) => {
    terminalError = error;
    pending?.reject(error);
    pending = undefined;
    rejectGuard?.(error);
  };
  const process = startProcessLegacy(
    {
      command: options.command,
      args: [...(options.args ?? []), 'app-server', '--listen', 'stdio://'],
      options: { cwd: os.homedir(), env: options.env, stdio: ['pipe', 'pipe', 'pipe'] },
      processGroup: true,
      onSpawned: (child) => {
        child.on('error', () => fail(new Error('Codex lifecycle process failed to start')));
        child.on('exit', () => fail(new Error('Codex lifecycle process exited before replying')));
        options.onSpawned?.(child.pid);
      },
    },
    toShared({ logger: options.logger })
  );
  const abort = () => fail(new Error('Codex lifecycle operation cancelled or timed out'));
  signal.addEventListener('abort', abort, { once: true });
  let failure: unknown;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    const { stdin, stdout, stderr } = process.child;
    if (!stdin || !stdout || !stderr) throw new Error('Codex lifecycle pipes are unavailable');
    stdin.on('error', () => fail(new Error('Codex lifecycle input failed')));
    stdout.on('error', () => fail(new Error('Codex lifecycle output failed')));
    stderr.on('error', () => fail(new Error('Codex lifecycle diagnostics failed')));
    stderr.resume();
    lines = createInterface({ input: stdout });
    lines.on('line', (line) => {
      try {
        const response = ResponseSchema.parse(JSON.parse(line));
        if (!pending || response.id !== pending.id) return;
        const request = pending;
        pending = undefined;
        if (response.error) {
          request.reject(new Error(`Codex lifecycle request failed (code ${response.error.code})`));
        } else if (Object.hasOwn(response, 'result')) {
          request.resolve(response.result);
        } else {
          request.reject(new Error('Codex lifecycle response has no result'));
        }
      } catch {
        // Native output can contain private conversation data; never echo parser input.
        fail(new Error('Codex lifecycle returned an invalid response'));
      }
    });
    const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      signal.throwIfAborted();
      if (terminalError) throw terminalError;
      const id = ++sequence;
      try {
        return await new Promise<unknown>((resolve, reject) => {
          pending = { id, resolve, reject };
          stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
            if (error) fail(new Error('Codex lifecycle request could not be written'));
          });
        });
      } catch (error) {
        throw new Error(`Codex ${method} failed`, { cause: error });
      }
    };
    await request('initialize', { clientInfo: { name: 'lody_session_lifecycle', version } });
    stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const parsed = ThreadSchema.safeParse(
      await request('thread/read', { threadId: options.threadId, includeTurns: false })
    );
    if (!parsed.success) throw new Error('Codex thread metadata is unavailable');
    if (parsed.data.thread.id !== options.threadId)
      throw new Error('Codex thread identity mismatch');
    const file = parsed.data.thread.path;
    const archived = inside(path.join(home, 'archived_sessions'), file);
    if (!archived && !inside(path.join(home, 'sessions'), file)) {
      throw new Error('Codex thread belongs to a different session store');
    }
    if (archived !== options.archived) {
      const shouldApply = options.shouldApply;
      if (shouldApply) {
        try {
          const applies = await new Promise<boolean>((resolve, reject) => {
            rejectGuard = reject;
            shouldApply().then(resolve, reject);
          });
          if (!applies) return;
        } finally {
          rejectGuard = undefined;
        }
      }
      await request(options.archived ? 'thread/archive' : 'thread/unarchive', {
        threadId: options.threadId,
      });
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    lines?.close();
    try {
      await process.terminate({ graceMs: 0, killWaitMs: 2_000 });
    } catch (error) {
      if (failure) throw new AggregateError([failure, error], 'Codex lifecycle and cleanup failed');
      throw error;
    }
  }
}
