import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { afterEach } from 'vitest';

// This is an environment/hang watchdog, not an expected protocol refusal or a
// throughput assertion. Every caller still checks the actual exit and state.
const WATCHDOG_MS = 120_000;
const owned = new Set<{ child: ChildProcess; closed: Promise<void> }>();

afterEach(async () => {
  const retained = [...owned];
  for (const { child } of retained) child.kill('SIGKILL');
  await Promise.allSettled(retained.map(({ closed }) => closed));
});

export async function runNativeChild(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    onSpawn?: (child: ChildProcess) => void;
  } = {}
) {
  const { signal, onSpawn, ...nativeOptions } = options;
  const child = spawn(command, args, { ...nativeOptions, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '',
    error: Error | undefined,
    status: number | null = null,
    exitSignal: NodeJS.Signals | null = null;
  const closed = new Promise<void>((resolve) => {
    child.once('error', (failure) => {
      error = failure;
    });
    child.once('close', (code, nextSignal) => {
      status = code;
      exitSignal = nextSignal;
      resolve();
    });
  });
  const owner = { child, closed };
  owned.add(owner);
  const stop = (reason: string) => {
    error ??= new Error(`Native child harness failure: ${reason}`);
    child.kill('SIGKILL');
  };
  const abort = () => stop('cancelled by its test owner');
  const watchdog = setTimeout(() => stop('watchdog expired before actual close'), WATCHDOG_MS);
  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (stream === 'stdout') stdout += chunk.toString();
    else stderr += chunk.toString();
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024)
      stop('output exceeds the fixture budget');
  };
  child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    onSpawn?.(child);
    await closed;
    if (error) throw error;
    return { status, signal: exitSignal, stdout, stderr };
  } catch (failure) {
    child.kill('SIGKILL');
    await closed;
    throw failure;
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', abort);
    owned.delete(owner);
  }
}

export async function execNativeChild(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {}
) {
  const result = await runNativeChild(command, args, options);
  if (result.status !== 0 || result.signal !== null)
    throw new Error(`Native child failed (${result.status ?? result.signal}): ${result.stderr}`);
  return result.stdout;
}
