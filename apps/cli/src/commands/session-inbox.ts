import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { Effect } from 'effect';
import { z } from 'zod';
import {
  RYUGI_UNSUBSCRIBE_EXIT_CODE,
  SessionInboxDeliverRequestSchema,
  SessionInboxDeliverSourceSchema,
  type SessionInboxDeliverRequest,
  type SessionInboxDeliverResponse,
  type SessionInboxDeliverSource,
} from '@lody/shared';
import { makeLocalControlClientAuto } from '@lody/shared/node/local-ipc';
import { classifyLocalDaemonIpcError, LocalDaemonAvailabilityError } from '@/lib/command-runtime';

/** Leave headroom inside Ryugi's 15s default command timeout for a clean retry receipt. */
const DEFAULT_INBOX_DELIVER_IPC_TIMEOUT_MS = 12_000;
const MAX_STDIN_BYTES = 2 * 1024 * 1024;

const RyugiDeliveryPayloadSchema = z
  .object({
    protocol: z.number().optional(),
    host: z.string().optional(),
    session: z.string().optional(),
    project: z.string().optional(),
    artifact: z.string().optional(),
    type: z.string().optional(),
    wakeMessage: z.string().optional(),
    event: z.unknown().optional(),
  })
  .passthrough();

export type SessionInboxDeliverCliOptions = {
  source: string;
  session?: string;
  socket?: string;
  timeoutMs?: number;
};

export type SessionInboxDeliverCliResult = {
  exitCode: number;
  stdout?: string;
  stderr?: string;
};

export type SessionInboxDeliverCliDeps = {
  readStdin?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  deliver?: (
    request: SessionInboxDeliverRequest,
    options: { socketPath?: string; timeoutMs: number }
  ) => Promise<SessionInboxDeliverResponse>;
};

function trimNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortedJson(item)])
    );
  }
  return value;
}

export function buildRyugiDedupeKey(input: {
  sessionId: string;
  artifact?: string;
  eventType?: string;
  wakeMessage: string;
  event: unknown;
}): string {
  const canonical = JSON.stringify(
    sortedJson({
      source: 'ryugi',
      sessionId: input.sessionId,
      artifact: input.artifact ?? null,
      eventType: input.eventType ?? null,
      wakeMessage: input.wakeMessage,
      event: input.event,
    })
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export function parseRyugiDeliveryPayload(
  rawStdin: string,
  options: { session?: string; env?: NodeJS.ProcessEnv }
): { ok: true; request: SessionInboxDeliverRequest } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(rawStdin);
  } catch {
    return { ok: false, error: 'Invalid JSON payload on stdin.' };
  }
  const parsed = RyugiDeliveryPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid Ryugi delivery payload.' };
  }
  const payload = parsed.data;
  const env = options.env ?? process.env;
  const sessionId =
    trimNonEmpty(options.session) ??
    trimNonEmpty(payload.session) ??
    trimNonEmpty(env.RYUGI_SESSION) ??
    trimNonEmpty(env.LODY_SESSION_ID);
  if (!sessionId) {
    return { ok: false, error: 'Missing session ID in payload, --session, or RYUGI_SESSION.' };
  }

  const wakeMessage = payload.wakeMessage;
  if (typeof wakeMessage !== 'string' || wakeMessage.trim().length === 0) {
    return { ok: false, error: 'Missing non-empty wakeMessage in Ryugi payload.' };
  }

  const artifact = trimNonEmpty(payload.artifact) ?? trimNonEmpty(env.RYUGI_ARTIFACT);
  const eventType = trimNonEmpty(payload.type) ?? trimNonEmpty(env.RYUGI_EVENT_TYPE);
  const host = trimNonEmpty(payload.host) ?? trimNonEmpty(env.RYUGI_HOST);
  const project = trimNonEmpty(payload.project) ?? trimNonEmpty(env.RYUGI_PROJECT);

  const dedupeKey =
    payload.event !== undefined
      ? buildRyugiDedupeKey({
          sessionId,
          artifact,
          eventType,
          wakeMessage,
          event: payload.event,
        })
      : undefined;

  const metadata = {
    ...(host ? { host } : {}),
    label: 'Ryugi',
    ...(artifact ? { artifact } : {}),
    ...(eventType ? { eventType } : {}),
    ...(project ? { project } : {}),
  };

  const validated = SessionInboxDeliverRequestSchema.safeParse({
    source: 'ryugi',
    sessionId,
    message: wakeMessage,
    ...(dedupeKey ? { dedupeKey } : {}),
    metadata,
  });
  if (!validated.success) {
    return { ok: false, error: validated.error.issues[0]?.message ?? 'Invalid delivery request.' };
  }
  return { ok: true, request: validated.data };
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_STDIN_BYTES) {
      throw new Error(`Delivery payload exceeds ${MAX_STDIN_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function defaultDeliverViaDaemon(
  request: SessionInboxDeliverRequest,
  options: { socketPath?: string; timeoutMs: number }
): Promise<SessionInboxDeliverResponse> {
  const result = await Effect.runPromise(
    makeLocalControlClientAuto({ socketPath: options.socketPath })
      .sessionInboxDeliver(request, { timeoutMs: options.timeoutMs })
      .pipe(Effect.result)
  );
  if (result._tag === 'Failure') {
    throw classifyLocalDaemonIpcError(result.failure);
  }
  return result.success;
}

function classifyDaemonFailureReason(error: unknown): string {
  if (error instanceof LocalDaemonAvailabilityError) {
    return error.code === 'DAEMON_NOT_RUNNING' ? 'daemon_unavailable' : 'daemon_busy';
  }
  return 'daemon_ipc_failed';
}

export async function executeSessionInboxDeliver(
  options: SessionInboxDeliverCliOptions,
  deps: SessionInboxDeliverCliDeps = {}
): Promise<SessionInboxDeliverCliResult> {
  const parsedSource = SessionInboxDeliverSourceSchema.safeParse(options.source);
  if (!parsedSource.success) {
    return {
      exitCode: 1,
      stderr: `Unsupported delivery source: ${options.source}. Supported sources: ryugi.\n`,
    };
  }
  const source: SessionInboxDeliverSource = parsedSource.data;

  let rawStdin: string;
  try {
    rawStdin = await (deps.readStdin ?? readProcessStdin)();
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  let request: SessionInboxDeliverRequest;
  switch (source) {
    case 'ryugi': {
      const parsed = parseRyugiDeliveryPayload(rawStdin, {
        session: options.session,
        env: deps.env,
      });
      if (!parsed.ok) {
        return { exitCode: 1, stderr: `${parsed.error}\n` };
      }
      request = parsed.request;
      break;
    }
  }

  let response: SessionInboxDeliverResponse;
  try {
    response = await (deps.deliver ?? defaultDeliverViaDaemon)(request, {
      socketPath: trimNonEmpty(options.socket),
      timeoutMs: options.timeoutMs ?? DEFAULT_INBOX_DELIVER_IPC_TIMEOUT_MS,
    });
  } catch (error) {
    const reason = classifyDaemonFailureReason(error);
    return {
      exitCode: 1,
      stdout: `${JSON.stringify({ status: 'retry', reason })}\n`,
    };
  }

  if (response.status === 'queued') {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(response)}\n`,
    };
  }
  if (response.status === 'unsubscribe') {
    return {
      exitCode: RYUGI_UNSUBSCRIBE_EXIT_CODE,
      stdout: `${JSON.stringify(response)}\n`,
    };
  }
  return {
    exitCode: 1,
    stdout: `${JSON.stringify(response)}\n`,
  };
}

const sessionInboxDeliverCommand = new Command('deliver')
  .description('Deliver an external host event into a Session Inbox as queued input')
  .requiredOption('--source <source>', 'External host source (ryugi)')
  .option('--session <sessionId>', 'Target Session ID (defaults to payload or RYUGI_SESSION)')
  .option('--socket <path>', 'Local daemon control socket path')
  .action(async (options: SessionInboxDeliverCliOptions) => {
    const result = await executeSessionInboxDeliver(options);
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exitCode = result.exitCode;
  });

export const sessionInboxCommand = new Command('inbox')
  .description('Deliver external input to a Session Inbox')
  .addCommand(sessionInboxDeliverCommand);
