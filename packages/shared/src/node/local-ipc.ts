import {
  LOCAL_SCHEDULE_CONTROL_PATH,
  ScheduleControlResponseSchema,
  type ScheduleControlRequest,
  type ScheduleControlResponse,
} from '../schedule-control';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Data, Effect } from 'effect';
import { z } from 'zod';
import type { CliRuntimeState } from '../electron-ipc';
import { CliRuntimeStateSchema } from '../electron-ipc';
import {
  LOCAL_MACHINE_RPC_PATH,
  LocalMachineRpcResponseSchema,
  type LocalMachineRpcRequest,
  type LocalMachineRpcResponse,
} from '../local-machine-rpc';
import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalSessionControlRequest,
  LocalSessionControlResponse,
} from '../message';
import {
  LocalProjectControlResponseSchema,
  LocalSessionControlResponseSchema,
} from '../message-schemas';
import { LOCAL_PROJECT_CONTROL_PATH } from './local-project-control';
import { getInstallationProfile, getLodyDataDir } from './installation-profile';
import type { PlatformKind } from '../platform-kind';

export const LOCAL_CONTROL_HEADER = 'x-lody-local-control';
export const LOCAL_SESSION_CONTROL_PATH = '/session-control';
export const LOCAL_SESSION_CONTROL_STREAM_MEDIA_TYPE = 'application/x-ndjson';
export const LOCAL_PROBE_HEALTH_PATH = '/healthz';
export const LOCAL_PROBE_STATE_PATH = '/state';

const DEFAULT_LOCAL_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_LOCAL_PROBE_TIMEOUT_MS = 2_000;
// Mirrors the server-side MAX_REQUEST_BODY_BYTES (apps/cli local-session-control):
// the client must not buffer an unbounded response either. Exported for tests.
export const LOCAL_IPC_MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const LOCAL_CONTROL_SOCKET_SUFFIX = 'control';
const LOCAL_PROBE_SOCKET_SUFFIX = 'probe';
const LOCAL_LORO_DATA_PLANE_SOCKET_SUFFIX = 'loro-data-plane';

function getSocketBasename(suffix: string, platform?: PlatformKind): string {
  return `${getInstallationProfile(platform).namespace}-${suffix}`;
}

type HttpResponseLike = {
  ok: boolean;
  status: number;
};

// Not `.strict()`: the probe is consumed across CLI/daemon version boundaries
// (e.g. a newer client probing an older daemon during a rolling upgrade). A
// daemon that adds a forward-compatible health field must still validate, so we
// only require the fields we read and allow unknown extras.
const LocalProbeHealthResponseSchema = z.object({
  ok: z.literal(true),
  machineId: z.string().min(1),
  pid: z.number().int().positive(),
  cliVersion: z.string().min(1),
  homeDir: z.string().min(1),
});

export type LocalProbeHealthResponse = z.infer<typeof LocalProbeHealthResponseSchema>;

// Not `.strict()`: matches the original (pre-abstraction) non-strict envelope
// schemas in command-runtime/mcp, so a daemon adding a forward-compatible
// top-level field to a control response keeps validating across versions.
const LocalControlHttpResponseSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  details: z.unknown().optional(),
  responses: z.array(z.unknown()).optional(),
});

const LocalSessionControlStreamFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('response'), response: z.unknown() }).strict(),
  z.object({ kind: z.literal('complete') }).strict(),
  z
    .object({
      kind: z.literal('error'),
      error: z.string().min(1),
      status: z.number().int().optional(),
      details: z.unknown().optional(),
    })
    .strict(),
]);

type LocalControlHttpResponse = z.infer<typeof LocalControlHttpResponseSchema>;

// Not `.strict()`: the run file is read across CLI/daemon version boundaries
// during upgrade windows (S6), so a newer daemon adding a forward-compatible
// field must still validate for an older reader. Only require the fields we read.
const LocalDaemonRunFileSchema = z.object({
  pid: z.number().int().positive(),
  socketPath: z.string().min(1),
  controlSocketPath: z.string().min(1),
  version: z.string().min(1),
  startedAt: z.string().min(1),
});

export type LocalDaemonRunFile = z.infer<typeof LocalDaemonRunFileSchema>;

export class IpcConnectError extends Data.TaggedError('IpcConnectError')<{
  message: string;
  cause?: unknown;
}> {}

export class IpcTimeoutError extends Data.TaggedError('IpcTimeoutError')<{
  message: string;
  timeoutMs: number;
  cause?: unknown;
}> {}

export class IpcProtocolError extends Data.TaggedError('IpcProtocolError')<{
  message: string;
  status?: number;
  errorCode?: string;
  responseBody?: unknown;
  cause?: unknown;
}> {}

export type IpcError = IpcConnectError | IpcTimeoutError | IpcProtocolError;

export class LocalDaemonRunFileMissingError extends Data.TaggedError(
  'LocalDaemonRunFileMissingError'
)<{
  path: string;
}> {}

export class LocalDaemonRunFileCorruptError extends Data.TaggedError(
  'LocalDaemonRunFileCorruptError'
)<{
  path: string;
  cause?: unknown;
}> {}

export class LocalDaemonRunFilePermissionError extends Data.TaggedError(
  'LocalDaemonRunFilePermissionError'
)<{
  path: string;
  cause?: unknown;
}> {}

export type LocalDaemonRunFileError =
  | LocalDaemonRunFileMissingError
  | LocalDaemonRunFileCorruptError
  | LocalDaemonRunFilePermissionError;

export type LocalIpcRequestOptions = {
  timeoutMs?: number;
};

export type LocalSessionControlRequestOptions = LocalIpcRequestOptions & {
  /** Receives validated control messages as the daemon produces them. */
  onResponse?: (response: LocalSessionControlResponse) => void;
};

export type LocalProbeClientService = {
  health: (options?: LocalIpcRequestOptions) => Effect.Effect<LocalProbeHealthResponse, IpcError>;
  state: (options?: LocalIpcRequestOptions) => Effect.Effect<CliRuntimeState, IpcError>;
};

export type LocalControlClientService = {
  scheduleControl: (
    message: ScheduleControlRequest,
    options?: LocalIpcRequestOptions
  ) => Effect.Effect<ScheduleControlResponse, IpcError>;
  sessionControl: (
    message: LocalSessionControlRequest,
    options?: LocalSessionControlRequestOptions
  ) => Effect.Effect<LocalSessionControlResponse[], IpcError>;
  projectControl: (
    message: LocalProjectControlRequest,
    options?: LocalIpcRequestOptions
  ) => Effect.Effect<LocalProjectControlResponse, IpcError>;
  machineRpc: (
    message: LocalMachineRpcRequest,
    options?: LocalIpcRequestOptions
  ) => Effect.Effect<LocalMachineRpcResponse, IpcError>;
};

export type LocalProbeClientSocketOptions = {
  socketPath?: string;
  runFilePath?: string;
};

export type LocalControlClientSocketOptions = {
  socketPath?: string;
  runFilePath?: string;
};

export type LocalProbeClientAutoOptions = LocalProbeClientSocketOptions;

export type LocalControlClientAutoOptions = LocalControlClientSocketOptions;

function getUserSocketSuffix(): string {
  if (typeof process.getuid === 'function') {
    return String(process.getuid());
  }
  const userInfo = os.userInfo();
  return crypto
    .createHash('sha256')
    .update(`${userInfo.uid}:${userInfo.username}:${os.homedir()}`)
    .digest('hex')
    .slice(0, 16);
}

// sockaddr_un.sun_path is ~104 bytes on macOS and 108 on Linux, including the
// trailing NUL; binding a longer path fails at the OS level.
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/**
 * Build the per-user local daemon socket path for a channel basename: a named
 * pipe on Windows, otherwise `<run dir>/<basename>.sock`. Sockets live in the
 * 0700 run dir, not a world-writable shared tmpdir, so other local users
 * cannot squat or symlink the well-known path (S1). Throws
 * `local_ipc_socket_path_too_long` instead of silently falling back when the
 * home dir pushes the path past the `sun_path` limit.
 */
export function getLocalDaemonSocketPath(basename: string, platform?: PlatformKind): string {
  if (process.platform === 'win32') {
    // Windows named pipes cannot get an explicit DACL from Node's listen(); we
    // rely on (a) the per-user suffix keeping paths collision-free and (b) the
    // creating process's default pipe security descriptor, which grants write
    // access to the owner (and Administrators — who can compromise the user's
    // processes regardless). If Node ever exposes pipe security attributes,
    // tighten this to owner-only explicitly.
    return `\\\\.\\pipe\\${basename}-${getUserSocketSuffix()}`;
  }

  const socketPath = path.join(getLocalDaemonRunDir(platform), `${basename}.sock`);
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`local_ipc_socket_path_too_long:${socketPath}`);
  }
  return socketPath;
}

export function getLocalControlSocketPath(platform?: PlatformKind): string {
  return getLocalDaemonSocketPath(
    getSocketBasename(LOCAL_CONTROL_SOCKET_SUFFIX, platform),
    platform
  );
}

export function getLocalProbeSocketPath(platform?: PlatformKind): string {
  return getLocalDaemonSocketPath(getSocketBasename(LOCAL_PROBE_SOCKET_SUFFIX, platform), platform);
}

export function getLocalLoroDataPlaneSocketPath(platform?: PlatformKind): string {
  return getLocalDaemonSocketPath(
    getSocketBasename(LOCAL_LORO_DATA_PLANE_SOCKET_SUFFIX, platform),
    platform
  );
}

export function getLocalDaemonRunDir(platform?: PlatformKind): string {
  return path.join(getLodyDataDir(platform), 'run');
}

export function getLocalDaemonRunFilePath(platform?: PlatformKind): string {
  return path.join(getLocalDaemonRunDir(platform), 'daemon.json');
}

export function getLocalDaemonLockFilePath(platform?: PlatformKind): string {
  return path.join(getLocalDaemonRunDir(platform), 'daemon.lock');
}

export function ensureLocalDaemonRunDir(runDir: string = getLocalDaemonRunDir()): void {
  const existed = fs.existsSync(runDir);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (!existed || runDir === getLocalDaemonRunDir())) {
    fs.chmodSync(runDir, 0o700);
    // The 0700 mode only isolates the run dir if WE own it. On shared/network
    // home dirs another user could have pre-created the path — sockets and the
    // run-file inside would then be theirs to squat/replace. Refuse to use a
    // run dir owned by someone else rather than silently trusting it (S1).
    if (typeof process.getuid === 'function') {
      const stat = fs.statSync(runDir);
      const uid = process.getuid();
      if (stat.uid !== uid) {
        throw new Error(`local_ipc_run_dir_not_owned:${runDir}:uid=${stat.uid}:expected=${uid}`);
      }
    }
  }
}

function mapRunFileReadError(filePath: string, error: unknown): LocalDaemonRunFileError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new LocalDaemonRunFileMissingError({ path: filePath });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new LocalDaemonRunFilePermissionError({ path: filePath, cause: error });
  }
  return new LocalDaemonRunFileCorruptError({ path: filePath, cause: error });
}

export function readLocalDaemonRunFile(
  runFilePath: string = getLocalDaemonRunFilePath()
): LocalDaemonRunFile {
  let raw: string;
  try {
    raw = fs.readFileSync(runFilePath, 'utf8');
  } catch (error) {
    throw mapRunFileReadError(runFilePath, error);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new LocalDaemonRunFileCorruptError({ path: runFilePath, cause: error });
  }

  const parsed = LocalDaemonRunFileSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new LocalDaemonRunFileCorruptError({ path: runFilePath, cause: parsed.error });
  }
  return parsed.data;
}

export function writeLocalDaemonRunFile(
  runFile: LocalDaemonRunFile,
  runFilePath: string = getLocalDaemonRunFilePath()
): void {
  const parsed = LocalDaemonRunFileSchema.parse(runFile);
  ensureLocalDaemonRunDir(path.dirname(runFilePath));
  const tempPath = `${runFilePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(tempPath, 0o600);
  }
  fs.renameSync(tempPath, runFilePath);
  if (process.platform !== 'win32') {
    fs.chmodSync(runFilePath, 0o600);
  }
}

export function removeLocalDaemonRunFile(runFilePath: string = getLocalDaemonRunFilePath()): void {
  try {
    fs.unlinkSync(runFilePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      error.message.toLowerCase().includes('aborted'))
  );
}

function isIpcError(error: unknown): error is IpcError {
  return (
    !!error &&
    typeof error === 'object' &&
    '_tag' in error &&
    (error._tag === 'IpcConnectError' ||
      error._tag === 'IpcTimeoutError' ||
      error._tag === 'IpcProtocolError')
  );
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapRequestError(error: unknown, timeoutMs: number): IpcError {
  if (isIpcError(error)) {
    return error;
  }
  if (isAbortLikeError(error)) {
    return new IpcTimeoutError({
      message: `Local IPC request timed out after ${timeoutMs}ms`,
      timeoutMs,
      cause: error,
    });
  }
  return new IpcConnectError({
    message: formatUnknownError(error),
    cause: error,
  });
}

function requestJsonOverSocket(
  socketPath: string,
  requestPath: string,
  init: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  },
  timeoutMs: number
): Effect.Effect<{ response: HttpResponseLike; payload: unknown }, IpcError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<{ response: HttpResponseLike; payload: unknown }>((resolve, reject) => {
        let settled = false;
        const settleWith = (settle: () => void): void => {
          if (settled) return;
          settled = true;
          settle();
        };
        const request = http.request(
          {
            socketPath,
            path: requestPath,
            method: init.method,
            headers: init.headers,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let receivedBytes = 0;
            response.on('data', (chunk: Buffer | string) => {
              if (settled) return;
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              receivedBytes += buffer.length;
              if (receivedBytes > LOCAL_IPC_MAX_RESPONSE_BODY_BYTES) {
                settleWith(() =>
                  reject(
                    new IpcProtocolError({
                      message: `Local IPC response exceeded ${LOCAL_IPC_MAX_RESPONSE_BODY_BYTES} bytes`,
                      status: response.statusCode ?? 0,
                    })
                  )
                );
                request.destroy();
                return;
              }
              chunks.push(buffer);
            });
            // A connection dropped mid-body emits 'error' on the response
            // stream only (never on the request), and Node swallows it when
            // unhandled — without this listener the promise never settles.
            response.on('error', (error) => settleWith(() => reject(error)));
            response.on('end', () => {
              const status = response.statusCode ?? 0;
              settleWith(() => {
                try {
                  resolve({
                    response: {
                      ok: status >= 200 && status < 300,
                      status,
                    },
                    payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                  });
                } catch (error) {
                  reject(
                    new IpcProtocolError({
                      message: `Invalid JSON response from local IPC (HTTP ${status})`,
                      status,
                      cause: error,
                    })
                  );
                }
              });
            });
          }
        );

        // Reject before destroy(): once headers have arrived, destroy() only
        // surfaces on the (possibly unhandled) response stream, so relying on
        // the request 'error' event would leave the timeout ineffective.
        request.setTimeout(timeoutMs, () => {
          settleWith(() =>
            reject(
              new IpcTimeoutError({
                message: `Local IPC request timed out after ${timeoutMs}ms`,
                timeoutMs,
              })
            )
          );
          request.destroy();
        });
        request.on('error', (error) => settleWith(() => reject(error)));
        if (init.body !== undefined) {
          request.write(init.body);
        }
        request.end();
      }),
    catch: (error) => mapRequestError(error, timeoutMs),
  });
}

function getJsonOverSocket(
  socketPath: string,
  requestPath: string,
  timeoutMs: number
): Effect.Effect<{ response: HttpResponseLike; payload: unknown }, IpcError> {
  return requestJsonOverSocket(socketPath, requestPath, { method: 'GET' }, timeoutMs);
}

function postJsonOverSocket(
  socketPath: string,
  requestPath: string,
  body: unknown,
  timeoutMs: number
): Effect.Effect<{ response: HttpResponseLike; payload: unknown }, IpcError> {
  const encoded = JSON.stringify(body);
  return requestJsonOverSocket(
    socketPath,
    requestPath,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(encoded, 'utf8')),
        [LOCAL_CONTROL_HEADER]: '1',
      },
      body: encoded,
    },
    timeoutMs
  );
}

function postSessionControlOverSocket(
  socketPath: string,
  message: LocalSessionControlRequest,
  options: LocalSessionControlRequestOptions
): Effect.Effect<LocalSessionControlResponse[], IpcError> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCAL_CONTROL_TIMEOUT_MS;
  const encoded = JSON.stringify(message);
  return Effect.tryPromise({
    try: () =>
      new Promise<LocalSessionControlResponse[]>((resolve, reject) => {
        let settled = false;
        const responses: LocalSessionControlResponse[] = [];
        const settleWith = (settle: () => void): void => {
          if (settled) return;
          settled = true;
          settle();
        };
        const request = http.request(
          {
            socketPath,
            path: LOCAL_SESSION_CONTROL_PATH,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(encoded, 'utf8')),
              accept: LOCAL_SESSION_CONTROL_STREAM_MEDIA_TYPE,
              [LOCAL_CONTROL_HEADER]: '1',
            },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            const contentType = response.headers['content-type'] ?? '';

            // Older daemons ignore Accept and return the legacy JSON envelope.
            if (!contentType.startsWith(LOCAL_SESSION_CONTROL_STREAM_MEDIA_TYPE)) {
              const chunks: Buffer[] = [];
              let receivedBytes = 0;
              response.on('data', (chunk: Buffer | string) => {
                if (settled) return;
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                receivedBytes += buffer.length;
                if (receivedBytes > LOCAL_IPC_MAX_RESPONSE_BODY_BYTES) {
                  settleWith(() =>
                    reject(
                      new IpcProtocolError({
                        message: `Local IPC response exceeded ${LOCAL_IPC_MAX_RESPONSE_BODY_BYTES} bytes`,
                        status,
                      })
                    )
                  );
                  response.destroy();
                  return;
                }
                chunks.push(buffer);
              });
              response.on('error', (error) => settleWith(() => reject(error)));
              response.on('end', () => {
                if (settled) return;
                try {
                  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
                  void Effect.runPromise(
                    parseSessionControlEnvelope(
                      { ok: status >= 200 && status < 300, status },
                      payload
                    ).pipe(
                      Effect.match({
                        onFailure: (error) => ({ ok: false as const, error }),
                        onSuccess: (legacyResponses) => ({
                          ok: true as const,
                          responses: legacyResponses,
                        }),
                      })
                    )
                  ).then(
                    (result) => {
                      if (!result.ok) {
                        settleWith(() => reject(result.error));
                        return;
                      }
                      for (const controlResponse of result.responses) {
                        try {
                          options.onResponse?.(controlResponse);
                        } catch {
                          // Observers cannot break the request transport.
                        }
                      }
                      settleWith(() => resolve(result.responses));
                    },
                    (error) => settleWith(() => reject(error))
                  );
                } catch (error) {
                  settleWith(() =>
                    reject(
                      new IpcProtocolError({
                        message: `Invalid JSON response from local IPC (HTTP ${status})`,
                        status,
                        cause: error,
                      })
                    )
                  );
                }
              });
              return;
            }

            const decoder = new StringDecoder('utf8');
            let buffered = '';
            let receivedBytes = 0;
            let complete = false;
            const parseLine = (line: string): void => {
              if (!line.trim() || settled) return;
              let decoded: unknown;
              try {
                decoded = JSON.parse(line);
              } catch (error) {
                throw new IpcProtocolError({
                  message: 'Local session control stream returned invalid JSON',
                  status,
                  cause: error,
                });
              }
              const frame = LocalSessionControlStreamFrameSchema.safeParse(decoded);
              if (!frame.success) {
                throw new IpcProtocolError({
                  message: 'Local session control stream returned an invalid frame',
                  status,
                  responseBody: decoded,
                  cause: frame.error,
                });
              }
              if (frame.data.kind === 'error') {
                throw new IpcProtocolError({
                  message: frame.data.error,
                  status: frame.data.status ?? status,
                  errorCode: frame.data.error,
                  responseBody: frame.data.details,
                });
              }
              if (frame.data.kind === 'complete') {
                complete = true;
                return;
              }
              const parsed = LocalSessionControlResponseSchema.safeParse(frame.data.response);
              if (!parsed.success) {
                throw new IpcProtocolError({
                  message: 'Local session control stream returned an invalid response payload',
                  status,
                  responseBody: frame.data.response,
                  cause: parsed.error,
                });
              }
              const controlResponse = parsed.data as LocalSessionControlResponse;
              responses.push(controlResponse);
              try {
                options.onResponse?.(controlResponse);
              } catch {
                // Observers cannot break the request transport.
              }
            };

            response.on('data', (chunk: Buffer | string) => {
              if (settled) return;
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              receivedBytes += buffer.length;
              if (receivedBytes > LOCAL_IPC_MAX_RESPONSE_BODY_BYTES) {
                settleWith(() =>
                  reject(
                    new IpcProtocolError({
                      message: `Local IPC response exceeded ${LOCAL_IPC_MAX_RESPONSE_BODY_BYTES} bytes`,
                      status,
                    })
                  )
                );
                response.destroy();
                return;
              }
              buffered += decoder.write(buffer);
              try {
                let newlineIndex = buffered.indexOf('\n');
                while (newlineIndex >= 0) {
                  const line = buffered.slice(0, newlineIndex);
                  buffered = buffered.slice(newlineIndex + 1);
                  parseLine(line);
                  newlineIndex = buffered.indexOf('\n');
                }
              } catch (error) {
                settleWith(() => reject(error));
                response.destroy();
              }
            });
            response.on('error', (error) => settleWith(() => reject(error)));
            response.on('end', () => {
              if (settled) return;
              try {
                buffered += decoder.end();
                parseLine(buffered);
                if (!complete) {
                  throw new IpcProtocolError({
                    message: 'Local session control stream ended before its completion frame',
                    status,
                  });
                }
                settleWith(() => resolve(responses));
              } catch (error) {
                settleWith(() => reject(error));
              }
            });
          }
        );

        request.setTimeout(timeoutMs, () => {
          settleWith(() =>
            reject(
              new IpcTimeoutError({
                message: `Local IPC request timed out after ${timeoutMs}ms`,
                timeoutMs,
              })
            )
          );
          request.destroy();
        });
        request.on('error', (error) => settleWith(() => reject(error)));
        request.write(encoded);
        request.end();
      }),
    catch: (error) => mapRequestError(error, timeoutMs),
  });
}

function parseProbeHealth(
  response: HttpResponseLike,
  payload: unknown
): Effect.Effect<LocalProbeHealthResponse, IpcProtocolError> {
  if (!response.ok) {
    return Effect.fail(
      new IpcProtocolError({
        message: `Local probe returned HTTP ${response.status}`,
        status: response.status,
        responseBody: payload,
      })
    );
  }
  const parsed = LocalProbeHealthResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return Effect.fail(
      new IpcProtocolError({
        message: 'Invalid local probe health response',
        status: response.status,
        responseBody: payload,
        cause: parsed.error,
      })
    );
  }
  return Effect.succeed(parsed.data);
}

function parseProbeState(
  response: HttpResponseLike,
  payload: unknown
): Effect.Effect<CliRuntimeState, IpcProtocolError> {
  if (!response.ok) {
    return Effect.fail(
      new IpcProtocolError({
        message: `Local probe returned HTTP ${response.status}`,
        status: response.status,
        responseBody: payload,
      })
    );
  }
  const parsed = CliRuntimeStateSchema.safeParse(payload);
  if (!parsed.success) {
    return Effect.fail(
      new IpcProtocolError({
        message: 'Invalid local probe state response',
        status: response.status,
        responseBody: payload,
        cause: parsed.error,
      })
    );
  }
  return Effect.succeed(parsed.data);
}

function formatLocalControlFailure(body: LocalControlHttpResponse, status: number): string {
  const parts = [body.error ?? `local control returned HTTP ${status}`];
  if (body.message !== undefined && body.message.length > 0) {
    parts.push(body.message);
  }
  if (body.details !== undefined) {
    parts.push(`details: ${JSON.stringify(body.details)}`);
  }
  return parts.join(': ');
}

function parseSessionControlEnvelope(
  response: HttpResponseLike,
  payload: unknown
): Effect.Effect<LocalSessionControlResponse[], IpcProtocolError> {
  const envelope = LocalControlHttpResponseSchema.safeParse(payload);
  if (!envelope.success) {
    return Effect.fail(
      new IpcProtocolError({
        message: `Invalid response from local CLI daemon (HTTP ${response.status}).`,
        status: response.status,
        responseBody: payload,
        cause: envelope.error,
      })
    );
  }

  const body = envelope.data;
  if (!response.ok || body.ok === false) {
    const errorCode = body.error ?? `http_${response.status}`;
    return Effect.fail(
      new IpcProtocolError({
        message: formatLocalControlFailure(body, response.status),
        status: response.status,
        errorCode,
        responseBody: body,
      })
    );
  }

  if (!body.responses) {
    return Effect.fail(
      new IpcProtocolError({
        message: 'Local CLI daemon response did not include any control messages.',
        status: response.status,
        responseBody: body,
      })
    );
  }

  const responses: LocalSessionControlResponse[] = [];
  for (const item of body.responses) {
    const parsed = LocalSessionControlResponseSchema.safeParse(item);
    if (!parsed.success) {
      return Effect.fail(
        new IpcProtocolError({
          message: 'local control returned an invalid response payload',
          status: response.status,
          responseBody: item,
          cause: parsed.error,
        })
      );
    }
    responses.push(parsed.data as LocalSessionControlResponse);
  }
  return Effect.succeed(responses);
}

function parseJsonBody<T>(
  // `data` is intentionally untyped: some response types carry branded ids the
  // zod schema cannot infer, so the callers pin T and we cast like the
  // per-endpoint parsers this replaced.
  schema: { safeParse: (input: unknown) => { success: boolean; data?: unknown; error?: unknown } },
  buildMessage: (status: number) => string
): (response: HttpResponseLike, payload: unknown) => Effect.Effect<T, IpcProtocolError> {
  return (response, payload) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return Effect.fail(
        new IpcProtocolError({
          message: buildMessage(response.status),
          status: response.status,
          responseBody: payload,
          cause: parsed.error,
        })
      );
    }
    return Effect.succeed(parsed.data as T);
  };
}

const parseProjectControlResponse = parseJsonBody<LocalProjectControlResponse>(
  LocalProjectControlResponseSchema,
  (status) => `Invalid project control response (HTTP ${status})`
);

const parseMachineRpcResponse = parseJsonBody<LocalMachineRpcResponse>(
  LocalMachineRpcResponseSchema,
  (status) => `invalid_response:http_${status}`
);

type PostJsonFn = (
  requestPath: string,
  body: unknown,
  timeoutMs: number
) => Effect.Effect<{ response: HttpResponseLike; payload: unknown }, IpcError>;

type PostSessionControlFn = (
  message: LocalSessionControlRequest,
  options: LocalSessionControlRequestOptions
) => Effect.Effect<LocalSessionControlResponse[], IpcError>;

// Single endpoint enumeration for every local control method. P8 made the auto
// client socket-only; keeping this centralized prevents per-method path drift.
function makeControlClient(
  post: PostJsonFn,
  postSessionControl?: PostSessionControlFn
): LocalControlClientService {
  return {
    sessionControl: (message, requestOptions) =>
      postSessionControl
        ? postSessionControl(message, requestOptions ?? {})
        : Effect.flatMap(
            post(
              LOCAL_SESSION_CONTROL_PATH,
              message,
              requestOptions?.timeoutMs ?? DEFAULT_LOCAL_CONTROL_TIMEOUT_MS
            ),
            ({ response, payload }) => parseSessionControlEnvelope(response, payload)
          ),
    scheduleControl: (message, requestOptions) =>
      Effect.flatMap(
        post(
          LOCAL_SCHEDULE_CONTROL_PATH,
          message,
          requestOptions?.timeoutMs ?? DEFAULT_LOCAL_CONTROL_TIMEOUT_MS
        ),
        ({ response, payload }) =>
          parseJsonBody<ScheduleControlResponse>(
            ScheduleControlResponseSchema,
            (status) => `Invalid Schedule response (HTTP ${status})`
          )(response, payload)
      ),
    projectControl: (message, requestOptions) =>
      Effect.flatMap(
        post(
          LOCAL_PROJECT_CONTROL_PATH,
          message,
          requestOptions?.timeoutMs ?? DEFAULT_LOCAL_CONTROL_TIMEOUT_MS
        ),
        ({ response, payload }) => parseProjectControlResponse(response, payload)
      ),
    machineRpc: (message, requestOptions) =>
      Effect.flatMap(
        post(
          LOCAL_MACHINE_RPC_PATH,
          message,
          requestOptions?.timeoutMs ?? DEFAULT_LOCAL_CONTROL_TIMEOUT_MS
        ),
        ({ response, payload }) => parseMachineRpcResponse(response, payload)
      ),
  };
}

function runFileToConnectError(error: unknown): IpcConnectError {
  if (
    error instanceof LocalDaemonRunFileMissingError ||
    error instanceof LocalDaemonRunFileCorruptError ||
    error instanceof LocalDaemonRunFilePermissionError
  ) {
    return new IpcConnectError({
      message: `Local daemon run-file unavailable: ${error.path}`,
      cause: error,
    });
  }
  return new IpcConnectError({
    message: formatUnknownError(error),
    cause: error,
  });
}

function resolveProbeSocketPath(
  options: LocalProbeClientSocketOptions
): Effect.Effect<string, IpcConnectError> {
  if (options.socketPath) {
    return Effect.succeed(options.socketPath);
  }
  return Effect.try({
    try: () => readLocalDaemonRunFile(options.runFilePath).socketPath,
    catch: runFileToConnectError,
  });
}

function resolveControlSocketPath(
  options: LocalControlClientSocketOptions
): Effect.Effect<string, IpcConnectError> {
  if (options.socketPath) {
    return Effect.succeed(options.socketPath);
  }
  return Effect.try({
    try: () => readLocalDaemonRunFile(options.runFilePath).controlSocketPath,
    catch: runFileToConnectError,
  });
}

// Resolving a socket path reads + zod-parses the run file synchronously, and
// long-lived clients (e.g. the Electron data-plane poll) issue requests
// continuously — cache the resolved path per client and invalidate it on
// connect errors so a daemon restart or stale run file re-resolves.
function makeCachedSocketPathRunner(
  resolveSocketPath: () => Effect.Effect<string, IpcConnectError>
): <A>(run: (socketPath: string) => Effect.Effect<A, IpcError>) => Effect.Effect<A, IpcError> {
  let cachedSocketPath: string | null = null;
  return (run) =>
    Effect.suspend(() =>
      cachedSocketPath
        ? Effect.succeed(cachedSocketPath)
        : Effect.tap(resolveSocketPath(), (socketPath) =>
            Effect.sync(() => {
              cachedSocketPath = socketPath;
            })
          )
    ).pipe(
      Effect.flatMap(run),
      Effect.catchTag('IpcConnectError', (error) => {
        cachedSocketPath = null;
        return Effect.fail(error);
      })
    );
}

export function makeLocalProbeClientSocket(
  options: LocalProbeClientSocketOptions = {}
): LocalProbeClientService {
  const withSocketPath = makeCachedSocketPathRunner(() => resolveProbeSocketPath(options));
  return {
    health: (requestOptions) =>
      withSocketPath((socketPath) =>
        Effect.flatMap(
          getJsonOverSocket(
            socketPath,
            LOCAL_PROBE_HEALTH_PATH,
            requestOptions?.timeoutMs ?? DEFAULT_LOCAL_PROBE_TIMEOUT_MS
          ),
          ({ response, payload }) => parseProbeHealth(response, payload)
        )
      ),
    state: (requestOptions) =>
      withSocketPath((socketPath) =>
        Effect.flatMap(
          getJsonOverSocket(
            socketPath,
            LOCAL_PROBE_STATE_PATH,
            requestOptions?.timeoutMs ?? DEFAULT_LOCAL_PROBE_TIMEOUT_MS
          ),
          ({ response, payload }) => parseProbeState(response, payload)
        )
      ),
  };
}

export function makeLocalControlClientSocket(
  options: LocalControlClientSocketOptions = {}
): LocalControlClientService {
  const withSocketPath = makeCachedSocketPathRunner(() => resolveControlSocketPath(options));
  return makeControlClient(
    (requestPath, body, timeoutMs) =>
      withSocketPath((socketPath) => postJsonOverSocket(socketPath, requestPath, body, timeoutMs)),
    (message, requestOptions) =>
      withSocketPath((socketPath) =>
        postSessionControlOverSocket(socketPath, message, requestOptions)
      )
  );
}

export function makeLocalProbeClientAuto(
  options: LocalProbeClientAutoOptions = {}
): LocalProbeClientService {
  return makeLocalProbeClientSocket(options);
}

export function makeLocalControlClientAuto(
  options: LocalControlClientAutoOptions = {}
): LocalControlClientService {
  return makeLocalControlClientSocket(options);
}
