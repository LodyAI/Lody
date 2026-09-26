import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  MCP_HTTP_PREFERRED_PORT_ENV,
  MCP_HTTP_TOKEN_ENV,
  McpHttpHostHandshakeSchema,
  type LodyMcpHttpEndpoint,
} from './lody-mcp-http-protocol';

/**
 * Daemon-side supervisor for the shared MCP HTTP host subprocess
 * (`lody __internal lody-mcp-http-host`, see `lody-mcp-http-host.ts`).
 *
 * The host is one subprocess per daemon — NOT in-daemon (MCP tools do
 * synchronous SQLite and one-shot workspace-manager work that must never
 * share the daemon event loop; `operation-store.ts` makes that contract
 * explicit) and NOT per-session (that is the 250–410MB-per-session shape this
 * replaces).
 *
 * The supervisor owns the bearer token and preferred port so a crashed host
 * restarts with the SAME endpoint identity: agent sessions bake the URL and
 * token into their MCP config at ACP session creation and cannot be updated
 * afterwards. While the host is down (or gave up), `getLodyMcpHttpEndpoint()`
 * returns null and new sessions fall back to the per-session stdio MCP entry.
 *
 * Startup is deliberately not awaited into the daemon's local-ready path:
 * sessions racing the first ~1s of host boot simply get stdio.
 */

const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_RESTART_ATTEMPTS = 10;
/** An exit after this much uptime resets the restart budget. */
const STABLE_UPTIME_MS = 30_000;
const SIGTERM_GRACE_MS = 5_000;
/**
 * Host exit codes that mean "this environment can never serve HTTP MCP"
 * (missing token wiring, unreadable /proc/net/tcp). Restarting cannot help.
 */
const PERMANENT_EXIT_CODES = new Set([2, 3]);

class McpHttpHostSupervisor {
  private readonly token = randomBytes(32).toString('base64url');
  private child: ChildProcess | null = null;
  private endpoint: LodyMcpHttpEndpoint | null = null;
  private lastPort = 0;
  private attempts = 0;
  private stopping = false;
  private wakeBackoffSleep: (() => void) | null = null;

  constructor(private readonly logger: Logger) {}

  getEndpoint(): LodyMcpHttpEndpoint | null {
    return this.endpoint;
  }

  async run(): Promise<void> {
    const cliEntrypoint = process.argv[1];
    if (!cliEntrypoint) {
      this.logger.warn('[mcp-http] no CLI entrypoint to spawn the host; stdio MCP only');
      return;
    }
    while (!this.stopping) {
      const startedAtMs = Date.now();
      let handshaked = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let hostPid: number | undefined;
      try {
        const child = this.spawnChild(cliEntrypoint);
        this.child = child;
        hostPid = child.pid;
        const port = await this.readHandshake(child);
        handshaked = true;
        this.lastPort = port;
        this.endpoint = { url: `http://127.0.0.1:${port}/mcp`, token: this.token };
        this.logger.info(`[mcp-http] host serving on ${this.endpoint.url} (pid=${hostPid})`);
        const [code, signal] = (await once(child, 'exit')) as [
          number | null,
          NodeJS.Signals | null,
        ];
        exitCode = code;
        exitSignal = signal;
      } catch (error) {
        if (!this.stopping) {
          this.logger.warn(`[mcp-http] host start failed: ${formatErrorMessage(error)}`);
        }
        const failed = this.child;
        // A handshake timeout or invalid handshake SIGKILLs the host and rejects
        // at once: wait for its real exit, so the trace below reports how it
        // ended and the next host never overlaps a dying one. A child that never
        // spawned (no pid) emits no 'exit'.
        if (failed?.pid !== undefined && failed.exitCode === null && failed.signalCode === null) {
          await once(failed, 'exit');
        }
        exitCode = failed?.exitCode ?? null;
        exitSignal = failed?.signalCode ?? null;
      }
      if (!this.stopping) {
        this.logger.warn(
          `[mcp-http] host pid=${hostPid ?? '?'} ended (code=${exitCode} signal=${
            exitSignal ?? 'none'
          } handshaked=${handshaked} uptimeMs=${Date.now() - startedAtMs})`
        );
      }
      this.endpoint = null;
      this.child = null;
      if (this.stopping) {
        return;
      }
      if (!handshaked && exitCode !== null && PERMANENT_EXIT_CODES.has(exitCode)) {
        this.logger.warn(
          `[mcp-http] host reported a permanent environment failure (exit ${exitCode}); stdio MCP only`
        );
        return;
      }
      this.attempts = Date.now() - startedAtMs >= STABLE_UPTIME_MS ? 1 : this.attempts + 1;
      if (this.attempts > MAX_RESTART_ATTEMPTS) {
        this.logger.error(
          `[mcp-http] host failed ${MAX_RESTART_ATTEMPTS} consecutive times; stdio MCP only`
        );
        return;
      }
      const backoffMs = Math.min(1_000 * 2 ** (this.attempts - 1), 30_000);
      this.logger.info(
        `[mcp-http] host exited (code=${exitCode}); restarting in ${backoffMs}ms (attempt ${this.attempts})`
      );
      await this.interruptibleSleep(backoffMs);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeBackoffSleep?.();
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return;
    }
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const outcome = await Promise.race([
      exited.then(() => 'exited' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SIGTERM_GRACE_MS)),
    ]);
    if (outcome === 'timeout' && child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }

  private spawnChild(cliEntrypoint: string): ChildProcess {
    const child = spawn(process.execPath, [cliEntrypoint, '__internal', 'lody-mcp-http-host'], {
      // stdin held open as the daemon-death signal; fd 3 is the handshake
      // pipe. The token goes through the environment (owner-readable only),
      // never through argv.
      stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        [MCP_HTTP_TOKEN_ENV]: this.token,
        [MCP_HTTP_PREFERRED_PORT_ENV]: String(this.lastPort),
      },
      windowsHide: true,
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        this.logger.debug(`[mcp-http] host stderr: ${text.slice(0, 2_000)}`);
      }
    });
    return child;
  }

  private async readHandshake(child: ChildProcess): Promise<number> {
    const handshakePipe = child.stdio[3] as Readable | null | undefined;
    if (!handshakePipe) {
      throw new Error('host handshake pipe missing');
    }
    return await new Promise<number>((resolve, rejectPromise) => {
      let buffer = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        handshakePipe.removeListener('data', onData);
        child.removeListener('exit', onExit);
        fn();
      };
      const armedAtMs = Date.now();
      const timer = setTimeout(() => {
        // A timer that fires far past its deadline means THIS event loop was
        // blocked: timers run before pending pipe I/O, so the host may already
        // have answered. Record the lateness so a stalled parent is not misread
        // as a broken host.
        const elapsedMs = Date.now() - armedAtMs;
        child.kill('SIGKILL');
        settle(() =>
          rejectPromise(
            new Error(
              `host handshake timed out (pid=${child.pid ?? '?'} elapsedMs=${elapsedMs} timeoutMs=${HANDSHAKE_TIMEOUT_MS} timerLateMs=${
                elapsedMs - HANDSHAKE_TIMEOUT_MS
              } partialHandshakeBytes=${buffer.length}); killed with SIGKILL`
            )
          )
        );
      }, HANDSHAKE_TIMEOUT_MS);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(() =>
          rejectPromise(
            new Error(`host exited before handshake (code=${code} signal=${signal ?? 'none'})`)
          )
        );
      };
      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const parsed = McpHttpHostHandshakeSchema.parse(JSON.parse(buffer.slice(0, newline)));
          settle(() => resolve(parsed.port));
        } catch (error) {
          child.kill('SIGKILL');
          settle(() =>
            rejectPromise(new Error(`invalid host handshake: ${formatErrorMessage(error)}`))
          );
        }
      };
      handshakePipe.setEncoding('utf8');
      handshakePipe.on('data', onData);
      child.once('exit', onExit);
    });
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeBackoffSleep = null;
        resolve();
      }, ms);
      this.wakeBackoffSleep = () => {
        clearTimeout(timer);
        this.wakeBackoffSleep = null;
        resolve();
      };
    });
  }
}

let supervisorInstance: McpHttpHostSupervisor | null = null;
let supervisorLoop: Promise<void> | null = null;

export const getLodyMcpHttpEndpoint = (): LodyMcpHttpEndpoint | null =>
  supervisorInstance?.getEndpoint() ?? null;

export async function startLodyMcpHttpServer(options: { logger: Logger }): Promise<void> {
  if (supervisorInstance) {
    return;
  }
  if (process.env.LODY_MCP_HTTP_DISABLED === '1') {
    options.logger.info('[mcp-http] disabled via LODY_MCP_HTTP_DISABLED; using stdio MCP only');
    return;
  }
  const supervisor = new McpHttpHostSupervisor(options.logger);
  supervisorInstance = supervisor;
  // Deliberately not awaited: the daemon's local-ready path must not wait for
  // a child CLI bundle to boot. Sessions racing the handshake get stdio.
  supervisorLoop = supervisor.run().catch((error: unknown) => {
    options.logger.error(`[mcp-http] supervisor crashed: ${formatErrorMessage(error)}`);
  });
}

export async function stopLodyMcpHttpServer(): Promise<void> {
  const supervisor = supervisorInstance;
  if (!supervisor) {
    return;
  }
  supervisorInstance = null;
  // Awaiting the loop after stop() covers the in-flight-start race: a child
  // mid-handshake is killed by stop(), and the loop observes `stopping`
  // before it could install a fresh listener.
  await supervisor.stop();
  if (supervisorLoop) {
    await supervisorLoop;
    supervisorLoop = null;
  }
}
