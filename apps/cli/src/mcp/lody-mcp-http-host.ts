import http from 'node:http';
import { writeSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SessionIdSchema } from '@lody/shared';
import { getLocalControlSocketPath } from '@lody/shared/node/local-ipc';
import { createFileLogger, type Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import {
  buildLodyMcpServer,
  runWithMcpSessionContext,
  type McpSessionContext,
} from './lody-mcp-server';
import { canReadProcNetTcp, lookupLoopbackPeerUid } from './loopback-peer-uid';
import {
  MCP_HTTP_MACHINE_ID_HEADER,
  MCP_HTTP_PREFERRED_PORT_ENV,
  MCP_HTTP_SESSION_ID_HEADER,
  MCP_HTTP_TASK_TOOLS_ENABLED_HEADER,
  MCP_HTTP_SCHEDULE_TOOLS_ENABLED_HEADER,
  MCP_HTTP_TOKEN_ENV,
  MCP_HTTP_WORKDIR_B64_HEADER,
  MCP_HTTP_WORKSPACE_ID_HEADER,
  type McpHttpHostHandshake,
} from './lody-mcp-http-protocol';

/**
 * The MCP HTTP host process: `lody __internal lody-mcp-http-host`.
 *
 * One shared subprocess per daemon serves the `lody` MCP tool surface over
 * streamable HTTP for every session whose agent advertises
 * `mcpCapabilities.http` — replacing one full stdio CLI subprocess PER
 * session. It is deliberately NOT hosted inside the daemon: MCP tools do
 * synchronous SQLite work (`operation-store.ts` restricts that to subprocess
 * boundaries) and open one-shot workspace managers, either of which would
 * stall the daemon event loop that dispatch, heartbeats, and IPC share.
 *
 * Lifecycle: the daemon supervisor spawns this process with the bearer token
 * and preferred port in the environment (owner-readable only, never argv),
 * reads one handshake JSON line from fd 3, and restarts it with the SAME
 * token/port on crash so already-configured agent sessions keep working. The
 * host exits when its stdin closes (daemon death) or on SIGTERM.
 *
 * Security model:
 * - Binds 127.0.0.1 only; random 256-bit bearer token required on every
 *   request (constant-time comparison).
 * - The token leaks to same-machine users through the agent runtime's argv
 *   (`--mcp-config` in `/proc/<pid>/cmdline`) on Linux, so every request
 *   additionally proves the peer socket's owner via `/proc/net/tcp{,6}`
 *   (full four-tuple + ESTABLISHED). Unprovable ownership is REJECTED on
 *   Linux — and the host refuses to start when `/proc/net/tcp` is unreadable,
 *   so the daemon falls back to stdio MCP instead of serving requests it
 *   could never verify. macOS/Windows hide foreign process arguments, so the
 *   token alone is sufficient there.
 * - Pre-auth exposure is bounded: header receipt 10s, full request receipt
 *   30s, and a connection cap. Response streaming (long-running tools) is
 *   not subject to either timeout.
 * - Context headers are trusted after authentication: the stdio variant
 *   already runs every tool under the daemon owner's CLI credential
 *   regardless of the calling session, so header-supplied ids grant nothing
 *   the agent could not already reach.
 */

const HANDSHAKE_FD = 3;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_RECEIPT_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 256;

export async function runLodyMcpHttpHost(): Promise<void> {
  const logger = createFileLogger('mcp-http-%DATE%.log');
  const token = process.env[MCP_HTTP_TOKEN_ENV];
  if (!token || token.length < 16) {
    process.stderr.write(`${MCP_HTTP_TOKEN_ENV} is required\n`);
    process.exitCode = 2;
    return;
  }
  if (process.platform === 'linux' && !canReadProcNetTcp()) {
    // Without /proc/net/tcp every request would fail closed; tell the
    // supervisor this environment cannot host HTTP MCP at all.
    process.stderr.write('cannot read /proc/net/tcp; refusing to serve MCP over TCP\n');
    process.exitCode = 3;
    return;
  }
  const preferredPortRaw = process.env[MCP_HTTP_PREFERRED_PORT_ENV];
  const preferredPort = preferredPortRaw ? Number.parseInt(preferredPortRaw, 10) : 0;

  const server = createMcpHttpServer(token, logger);
  const port = await listen(server, Number.isNaN(preferredPort) ? 0 : preferredPort);
  logger.info(`[mcp-http-host] listening on 127.0.0.1:${port}`);

  const handshake: McpHttpHostHandshake = { type: 'lody-mcp-http-listening', port };
  try {
    writeSync(HANDSHAKE_FD, `${JSON.stringify(handshake)}\n`);
  } catch {
    // Started by hand without the handshake pipe; print it for humans.
    process.stdout.write(`${JSON.stringify(handshake)}\n`);
  }

  await new Promise<void>((resolve) => {
    const shutdown = (reason: string) => {
      logger.info(`[mcp-http-host] shutting down (${reason})`);
      server.close(() => resolve());
      server.closeAllConnections();
      // Backstop in case close callbacks never fire.
      setTimeout(() => resolve(), 3_000).unref();
    };
    // The daemon holds our stdin open; its death is our exit signal.
    process.stdin.resume();
    process.stdin.on('end', () => shutdown('stdin closed'));
    process.stdin.on('close', () => shutdown('stdin closed'));
    process.stdin.on('error', () => shutdown('stdin error'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });
  // The resumed stdin stream would otherwise keep the event loop alive after
  // the server closed and the process would never exit on SIGTERM.
  process.stdin.destroy();
  await logger.close();
}

const listen = (server: http.Server, preferredPort: number): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const tryListen = (port: number, retryOnBusy: boolean) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (retryOnBusy && error.code === 'EADDRINUSE') {
          // The stable port from a previous generation was taken meanwhile;
          // fall back to an ephemeral one (existing agent sessions configured
          // with the old port lose MCP until restarted, new ones are fine).
          tryListen(0, false);
          return;
        }
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('MCP HTTP host did not bind a TCP port'));
          return;
        }
        resolve(address.port);
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });

export function createMcpHttpServer(token: string, logger: Logger): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, token, logger).catch((error: unknown) => {
      logger.error(`[mcp-http-host] request failed: ${formatErrorMessage(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          })
        );
      } else {
        res.end();
      }
    });
  });
  // Bound the unauthenticated surface: headers must arrive quickly and the
  // request body must complete within a short window. Neither timeout covers
  // the RESPONSE, so long-running tool calls are unaffected.
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_RECEIPT_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  return server;
}

const timingSafeTokenEqual = (provided: string, expected: string): boolean => {
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
};

const singleHeader = (req: http.IncomingMessage, name: string): string | null => {
  const value = req.headers[name];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
};

const parseSessionContextHeaders = (req: http.IncomingMessage): McpSessionContext | null => {
  const rawSessionId = singleHeader(req, MCP_HTTP_SESSION_ID_HEADER);
  const workspaceId = singleHeader(req, MCP_HTTP_WORKSPACE_ID_HEADER);
  const machineId = singleHeader(req, MCP_HTTP_MACHINE_ID_HEADER);
  const taskToolsEnabled = singleHeader(req, MCP_HTTP_TASK_TOOLS_ENABLED_HEADER);
  const workdirB64 = singleHeader(req, MCP_HTTP_WORKDIR_B64_HEADER);
  if (
    !rawSessionId ||
    !workspaceId ||
    !machineId ||
    (taskToolsEnabled !== '0' && taskToolsEnabled !== '1') ||
    !workdirB64
  ) {
    return null;
  }
  const sessionId = SessionIdSchema.safeParse(rawSessionId);
  if (!sessionId.success) {
    return null;
  }
  let workdir: string;
  try {
    workdir = Buffer.from(workdirB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (workdir.length === 0) {
    return null;
  }
  return {
    sessionId: sessionId.data,
    workspaceId,
    machineId,
    taskToolsEnabled: taskToolsEnabled === '1',
    scheduleToolsEnabled: singleHeader(req, MCP_HTTP_SCHEDULE_TOOLS_ENABLED_HEADER) === '1',
    workdir,
    localControlSocketPath: getLocalControlSocketPath(),
  };
};

const reject = (
  res: http.ServerResponse,
  status: number,
  message: string,
  extraHeaders: http.OutgoingHttpHeaders = {}
): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders }).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    })
  );
};

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  logger: Logger
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/mcp') {
    reject(res, 404, 'Not found');
    return;
  }

  // Stateless JSON mode has no server-initiated stream, so the spec's answer to
  // GET is 405. Handing it to the SDK instead opens an SSE response that can
  // never carry anything and is never closed, and a strict client (Grok's Rust
  // rmcp) reports that hang as a transport failure rather than as an MCP error.
  if (req.method === 'GET' || req.method === 'HEAD') {
    reject(res, 405, 'Method not allowed', { allow: 'POST' });
    return;
  }

  const authorization = singleHeader(req, 'authorization');
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  if (!bearer || !timingSafeTokenEqual(bearer, token)) {
    reject(res, 401, 'Unauthorized');
    return;
  }

  // The bearer token leaks to same-machine users through the agent runtime's
  // /proc cmdline on Linux, so peer ownership must be PROVEN there: an
  // unresolvable uid is a rejection, not a pass. Startup already refused to
  // serve when /proc/net/tcp is unreadable, so a legitimate local peer always
  // has a locatable, kernel-owned table entry.
  if (process.platform === 'linux' && typeof process.getuid === 'function') {
    const peerAddress = req.socket.remoteAddress;
    const peerPort = req.socket.remotePort;
    const serverAddress = req.socket.localAddress;
    const serverPort = req.socket.localPort;
    const peerUid =
      peerAddress !== undefined &&
      peerPort !== undefined &&
      serverAddress !== undefined &&
      serverPort !== undefined
        ? await lookupLoopbackPeerUid({ peerAddress, peerPort, serverAddress, serverPort })
        : null;
    if (peerUid === null || peerUid !== process.getuid()) {
      logger.warn(
        `[mcp-http-host] rejected connection: peer uid ${
          peerUid === null ? 'unresolvable' : peerUid
        } (${peerAddress ?? '?'}:${peerPort ?? '?'})`
      );
      reject(res, 403, 'Forbidden');
      return;
    }
  }

  const context = parseSessionContextHeaders(req);
  if (!context) {
    reject(res, 400, 'Missing or invalid Lody MCP session context headers');
    return;
  }

  // Stateless streamable HTTP: one server + transport pair per request, torn
  // down when the response closes. The MCP client re-initializes per
  // connection, and every tool call carries its full context in headers, so no
  // cross-request state is needed and concurrent sessions cannot interleave.
  const server = buildLodyMcpServer({
    taskToolsEnabled: context.taskToolsEnabled,
    scheduleToolsEnabled: context.scheduleToolsEnabled,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await runWithMcpSessionContext(context, async () => {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
}
