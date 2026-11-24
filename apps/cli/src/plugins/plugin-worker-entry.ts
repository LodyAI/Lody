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
const events = new Map<string, Handler>();
const calls = new Map<string, AbortController>();
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
  onStart(handler: Handler) {
    start = handler;
  },
  events: {
    on(type: string, handler: Handler) {
      events.set(type, handler);
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
const unavailable = () => Promise.reject(new Error('Workspace host operation unavailable'));
const context = (signal: AbortSignal) => ({
  workspace: { workspaceId },
  machine: { workspaceId, machineId },
  config: init?.config,
  dataDir: init?.dataDir,
  signal,
  lody: {
    read: unavailable,
    execute: unavailable,
    readSnapshot: unavailable,
    sessions: {
      create: unavailable,
      send: unavailable,
      respondInteraction: unavailable,
      requestStop: unavailable,
      requestArchive: unavailable,
    },
  },
  invalidate(d: Descriptor, target: unknown) {
    send({ type: 'invalidate', descriptorId: d.id, scope: d.scope, target });
  },
});
async function receive(frame: HostToChildFrame) {
  switch (frame.type) {
    case 'shutdown':
      if (phase === 'closing') return;
      phase = 'closing';
      life.abort();
      await cleanup?.();
      process.disconnect?.();
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
      });
      return;
    }
    case 'start':
      if (phase !== 'ready') throw new Error('Unexpected start');
      phase = 'starting';
      await start?.(
        context(AbortSignal.any([life.signal, AbortSignal.timeout(30_000)])),
        undefined
      );
      if (life.signal.aborted) return;
      phase = 'running';
      send({ type: 'result', callId: 'start', ok: true, data: null });
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
            Promise.resolve().then(() =>
              events.get(frame.eventType)?.(
                { ...context(signal), eventType: frame.eventType },
                frame.payload
              )
            ),
          ]);
        } finally {
          listener.abort();
        }
        signal.throwIfAborted();
        send({ type: 'result', callId: frame.eventId, ok: true, data: null });
      } catch {
        send({
          type: 'result',
          callId: frame.eventId,
          ok: false,
          error: { code: 'handler_error', message: 'Plugin event failed' },
        });
      }
      return;
    case 'host_result':
      throw new Error('Unexpected host result');
    case 'invoke': {
      if (phase !== 'running' || calls.has(frame.callId)) throw new Error('Unexpected invocation');
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
              AbortSignal.any([
                life.signal,
                c.signal,
                AbortSignal.timeout(invocationDeadlineMs(frame.kind)),
              ])
            ),
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
