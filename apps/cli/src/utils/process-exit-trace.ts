import { appendDailyLogSync, formatDailyLogLine } from '@lody/shared/node/daily-log-file';
import { LODY_LOG_DIR } from './log-retention';

/**
 * Synchronous last words for the daily log.
 *
 * The file logger is an asynchronous winston stream, and `process.exit()` runs
 * before it drains, so the lines explaining an exit can be lost. These beacons
 * append directly. A process that has no `[process-exit]` line was killed by a
 * signal or crashed natively (V8 OOM, segfault) — that absence is evidence too.
 */

export type ProcessExitTraceOptions = {
  scope: string;
  logDir?: string;
  now?: () => Date;
};

/** `cli:start`, `cli:daemon-runner`, `cli:lody-mcp-http-host`, … for lines that name no scope. */
export function describeCliProcessScope(argv: readonly string[] = process.argv): string {
  const command = argv.slice(2).find((arg) => !arg.startsWith('-') && arg !== '__internal');
  return `cli:${command ?? 'main'}`;
}

function describeProcess(): string {
  const memory = process.memoryUsage();
  return `pid=${process.pid} ppid=${process.ppid} uptimeMs=${Math.round(
    process.uptime() * 1_000
  )} rssMiB=${Math.round(memory.rss / 1024 / 1024)} heapUsedMiB=${Math.round(
    memory.heapUsed / 1024 / 1024
  )}`;
}

export function registerProcessExitTrace(options: ProcessExitTraceOptions): () => void {
  const logDir = options.logDir ?? LODY_LOG_DIR;
  const now = options.now ?? (() => new Date());
  const onExit = (code: number) => {
    appendDailyLogSync(
      logDir,
      formatDailyLogLine({
        time: now(),
        level: code === 0 ? 'INFO' : 'WARN',
        scope: options.scope,
        message: `[process-exit] exiting with code=${code} ${describeProcess()}`,
      })
    );
  };
  process.on('exit', onExit);
  return () => {
    process.off('exit', onExit);
  };
}

/**
 * Records an uncaught exception before cleanup, which may itself hang or be
 * killed. Every CLI process writes here, including helpers such as the MCP HTTP
 * host that otherwise log to their own file.
 */
export function traceFatalErrorSync(
  kind: 'uncaughtException',
  error: unknown,
  scope: string = describeCliProcessScope(),
  logDir: string = LODY_LOG_DIR
): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}${
          'code' in error && error.code !== undefined ? ` (code=${String(error.code)})` : ''
        }\n${error.stack ?? ''}`
      : String(error);
  appendDailyLogSync(
    logDir,
    formatDailyLogLine({
      time: new Date(),
      level: 'ERROR',
      scope,
      message: `[process-fatal] ${kind} ${describeProcess()}: ${detail}`,
    })
  );
}
