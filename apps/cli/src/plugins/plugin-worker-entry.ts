import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { invocationDeadlineMs } from './pure/call-policy';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  childToHostSchema,
  hostToChildSchema,
  type HostToChildFrame,
  type ChildToHostFrame,
} from '@lody/shared/plugins/ipc-protocol';

const [entry, workspaceId, machineId] = process.argv.slice(2);
if (!entry || !workspaceId || !machineId || !process.send)
  throw new Error('Missing machine plugin bootstrap');
const moduleUrl = pathToFileURL(entry).href;
const send = (frame: unknown) => process.send?.(childToHostSchema.parse(frame));
type Kind = Extract<HostToChildFrame, { type: 'invoke' }>['kind'];
type Descriptor = {
  id: string;
  scope?: 'project' | 'session' | 'machine';
  metadataSchema?: z.ZodType;
  input?: z.ZodType;
  output?: z.ZodType;
};
type Handler = (context: unknown, input: unknown) => unknown;
const handlers = new Map<string, { descriptor: Descriptor; kind: Kind; handler: Handler }>();
const resumeEvents = new Set<string>();
const events = new Map<string, Handler[]>();
const calls = new Map<string, AbortController>();
let service: Handler | undefined,
  upgrade: Handler | undefined,
  uninstall: Handler | undefined,
  serviceTask: Promise<unknown> | undefined;
let start: Handler | undefined, cleanup: (() => unknown) | undefined;
let init: Extract<HostToChildFrame, { type: 'init' }> | undefined;
let phase: 'new' | 'initializing' | 'ready' | 'starting' | 'running' | 'closing' = 'new';
const life = new AbortController();
const machineTarget = z.strictObject({
  workspaceId: z.literal(workspaceId),
  machineId: z.literal(machineId),
});
const targetSchemas = {
  machine: machineTarget,
  project: machineTarget.extend({ projectId: z.string().min(1) }),
  session: machineTarget.extend({
    sessionId: z.string().min(1),
    projectId: z.string().min(1).optional(),
  }),
};
class ValidationFailure extends Error {}
function parse(schema: z.ZodType, data: unknown) {
  const result = schema.safeParse(data);
  if (!result.success) throw new ValidationFailure();
  return result.data;
}
const register = (kind: Kind) => (descriptor: Descriptor, handler: Handler) => {
  const key = `${kind}:${descriptor.id}`;
  if (
    typeof descriptor.input?.safeParse !== 'function' ||
    typeof descriptor.output?.safeParse !== 'function'
  )
    throw new Error('Missing plugin handler schema');
  if (handlers.has(key)) throw new Error('Duplicate plugin handler');
  handlers.set(key, { kind, descriptor, handler });
};
const registry = {
  query: register('query'),
  mutation: register('mutation'),
  tool: register('tool'),
  service(handler: Handler) {
    service = handler;
  },
  onUpgrade(handler: Handler) {
    upgrade = handler;
  },
  onUninstall(handler: Handler) {
    uninstall = handler;
  },
  onStart(handler: Handler) {
    start = handler;
  },
  events: {
    on(type: string, handler: Handler, options?: { resumeFromCursor?: boolean }) {
      if (events.has(type) && resumeEvents.has(type) !== !!options?.resumeFromCursor)
        throw Error('Conflicting event resume policy');
      if (options?.resumeFromCursor) resumeEvents.add(type);
      const listeners = events.get(type) ?? [];
      listeners.push(handler);
      events.set(type, listeners);
    },
  },
  attachmentSource(d: Descriptor, h: { search: Handler; resolve: Handler }) {
    register('attachment-search')(
      {
        ...d,
        input: z.string(),
        output: z.array(
          z.strictObject({
            id: z.string(),
            title: z.string(),
            subtitle: z.string().optional(),
            url: z.string().optional(),
          })
        ),
      },
      h.search
    );
    register('attachment-resolve')(
      {
        ...d,
        input: z.string(),
        output: z.strictObject({
          title: z.string(),
          markdown: z.string(),
          url: z.string().optional(),
          metadata: (d.metadataSchema ?? z.json()).optional(),
        }),
      },
      h.resolve
    );
  },
};
type HostReply = Extract<HostToChildFrame, { type: 'host_result' }>;
function freezeSnapshot(value: unknown): unknown {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
const replies = new Map<string, (reply: HostReply) => void>();
const context = (contextId: string, signal: AbortSignal) => {
  const call = (
    op: Extract<ChildToHostFrame, { type: 'host_call' }>['op'],
    target: unknown,
    input?: unknown,
    descriptorId?: string
  ) =>
    new Promise<unknown>((resolve, reject) => {
      signal.throwIfAborted();
      const hostCallId = randomUUID();
      const abort = () => {
        replies.delete(hostCallId);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      replies.set(hostCallId, (reply) => {
        signal.removeEventListener('abort', abort);
        replies.delete(hostCallId);
        if (reply.ok) resolve(reply.data);
        else reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
      });
      try {
        send({
          type: 'host_call',
          contextId,
          hostCallId,
          op,
          payload: {
            target,
            ...(input !== undefined ? { input } : {}),
            ...(descriptorId ? { descriptorId } : {}),
          },
        });
      } catch (error) {
        signal.removeEventListener('abort', abort);
        replies.delete(hostCallId);
        reject(error);
      }
    });
  return {
    workspace: { workspaceId },
    machine: { workspaceId, machineId },
    config: init?.config,
    dataDir: init?.dataDir,
    storage: {
      get: async (key: string) => ((await call('storage.get', key)) as { value?: unknown }).value,
      set: async (key: string, value: unknown) => {
        await call('storage.set', key, { value });
      },
      delete: async (key: string) => {
        await call('storage.delete', key);
      },
      update: (key: string, expected: unknown, value: unknown) =>
        call('storage.update', key, {
          ...(expected !== undefined ? { expected } : {}),
          ...(value !== undefined ? { value } : {}),
        }),
    },
    signal,
    lody: {
      read: (target: unknown, d: { id: string }, input?: unknown) =>
        call('lody.read', target, input, d.id),
      execute: (target: unknown, d: { id: string }, input?: unknown) =>
        call('lody.execute', target, input, d.id),
      unstable: {
        readSnapshot: (target: unknown) =>
          call('lody.unstable.readSnapshot', target).then(freezeSnapshot),
      },
      sessions: {
        create: (t: unknown, i: unknown) => call('lody.execute', t, i, 'sessionCreate'),
        send: (t: unknown, i: unknown) => call('lody.execute', t, i, 'sessionSend'),
        respondInteraction: (t: unknown, i: unknown) =>
          call('lody.execute', t, i, 'sessionRespondInteraction'),
        requestStop: (t: unknown) => call('lody.execute', t, undefined, 'sessionStop'),
        requestArchive: (t: unknown) => call('lody.execute', t, undefined, 'sessionArchive'),
      },
    },
    invalidate(d: Descriptor, target: unknown) {
      send({ type: 'invalidate', descriptorId: d.id, scope: d.scope, target });
    },
  };
};
async function receive(frame: HostToChildFrame) {
  switch (frame.type) {
    case 'shutdown':
      if (phase === 'closing') return;
      phase = 'closing';
      life.abort();
      try {
        if (frame.uninstallContextId)
          await uninstall?.(
            context(frame.uninstallContextId, AbortSignal.timeout(10000)),
            undefined
          );
      } finally {
        try {
          await serviceTask?.catch(() => undefined);
        } finally {
          await cleanup?.();
          process.disconnect?.();
        }
      }

      return;
    case 'init': {
      if (phase !== 'new') throw new Error('Duplicate init');
      phase = 'initializing';
      init = frame;
      const mod = await import(/* @vite-ignore */ moduleUrl);
      if (mod.default?.kind !== 'machine-plugin') throw new Error('Expected machine plugin');
      if (life.signal.aborted) return;
      cleanup = mod.default.register(registry);
      phase = 'ready';
      send({
        type: 'ready',
        handlers: [...handlers.values()].map(({ kind, descriptor: d }) => ({
          kind,
          descriptorId: d.id,
          scope: d.scope ?? 'session',
        })),
        subscribedEvents: [...events.keys()],
        resumeEvents: [...resumeEvents],
        hasService: !!service,
      });
      return;
    }
    case 'start':
      if (phase !== 'ready') throw new Error('Unexpected start');
      phase = 'starting';
      const startup = context(
        frame.contextId,
        AbortSignal.any([life.signal, AbortSignal.timeout(30000)])
      );
      if (frame.upgrade) await upgrade?.(startup, frame.upgrade);
      await start?.(startup, undefined);
      if (life.signal.aborted) return;
      phase = 'running';
      send({ type: 'result', callId: frame.contextId, ok: true, data: null });
      return;
    case 'service':
      if (phase !== 'running' || !service || serviceTask)
        throw new Error('Unexpected plugin service start');
      {
        serviceTask = Promise.resolve(service(context(frame.contextId, life.signal), undefined));
        serviceTask.catch(() => {
          if (!life.signal.aborted) process.exit(1);
        });
      }
      return;
    case 'cancel':
      calls.get(frame.callId)?.abort();
      return;
    case 'event':
      if (phase !== 'running') throw new Error('Unexpected event');
      try {
        const signal = AbortSignal.any([life.signal, AbortSignal.timeout(30_000)]);
        const listener = new AbortController();
        try {
          await Promise.race([
            once(signal, 'abort', { signal: listener.signal }),
            Promise.all(
              (events.get(frame.eventType) ?? []).map((handler) =>
                Promise.resolve().then(() =>
                  handler(
                    {
                      ...context(frame.contextId, signal),
                      eventType: frame.eventType,
                      ...(frame.payload &&
                      typeof frame.payload === 'object' &&
                      !Array.isArray(frame.payload)
                        ? { session: frame.payload.session, project: frame.payload.project }
                        : {}),
                    },
                    frame.payload
                  )
                )
              )
            ),
          ]);
        } finally {
          listener.abort();
        }
        signal.throwIfAborted();
        send({ type: 'result', callId: frame.contextId, ok: true, data: null });
      } catch {
        send({
          type: 'result',
          callId: frame.contextId,
          ok: false,
          error: { code: 'handler_error', message: 'Plugin event failed' },
        });
      }
      return;
    case 'host_result':
      replies.get(frame.hostCallId)?.(frame);
      return;
    case 'invoke': {
      if (
        (phase !== 'running' &&
          !(frame.kind === 'query' && (phase === 'starting' || phase === 'ready'))) ||
        calls.has(frame.callId)
      )
        throw new Error('Unexpected invocation');
      const c = new AbortController();
      calls.set(frame.callId, c);
      try {
        const h = handlers.get(`${frame.kind}:${frame.descriptorId}`);
        if (!h) throw new Error('Unknown handler');
        if ((h.descriptor.scope ?? 'session') !== frame.scope) throw new ValidationFailure();
        parse(targetSchemas[frame.scope], frame.target);
        const input = parse(h.descriptor.input!, frame.input);
        const result = await h.handler(
          {
            ...context(
              frame.callId,
              AbortSignal.any([
                life.signal,
                c.signal,
                AbortSignal.timeout(invocationDeadlineMs(frame.kind)),
              ])
            ),
            config: { ...init?.config, ...frame.projectConfig },
            target: frame.target,
            session: frame.scope === 'session' ? frame.target : undefined,
            toolCallId: frame.callId,
          },
          input
        );
        send({
          type: 'result',
          callId: frame.callId,
          ok: true,
          data: parse(z.json(), parse(h.descriptor.output!, result) ?? null),
        });
      } catch (error) {
        send({
          type: 'result',
          callId: frame.callId,
          ok: false,
          error: {
            code: error instanceof ValidationFailure ? 'validation_failed' : 'handler_error',
            message: 'Plugin invocation failed',
          },
        } satisfies ChildToHostFrame);
      } finally {
        calls.delete(frame.callId);
      }
      return;
    }
  }
}
process.once('disconnect', () => process.exit());
process.on('message', (raw) => {
  void Promise.resolve()
    .then(() => receive(hostToChildSchema.parse(raw)))
    .catch(() => process.exit(1));
});
