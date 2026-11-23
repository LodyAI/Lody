import { Data, Effect, Result, Schema } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import { readBoundedBody } from './bounded-body';

const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const Stream = Schema.Literals(['control', 'loro', 'flock', 'mailbox', 'stagedgroup']);
const Method = Schema.Literals(['GET', 'HEAD', 'POST', 'PUT']);
const Target = Schema.Struct({
  actor: Name,
  stream: Stream,
  method: Method,
  occurrence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(4095)),
});
const Mutation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('headers'),
    headers: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literals(['drop', 'duplicate', 'delay']) }),
  Schema.Struct({
    kind: Schema.Literal('replay'),
    eventId: Schema.String,
    nextOffset: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('flip'),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    kind: Schema.Literal('truncate'),
    length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    kind: Schema.Literal('replace'),
    status: Schema.Int.check(Schema.isGreaterThanOrEqualTo(200), Schema.isLessThanOrEqualTo(599)),
    bodyHex: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2})*$/)),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
]);
export const LabTransportAttackActionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('intercept'), target: Target, mutation: Mutation }),
  Schema.Struct({ kind: Schema.Literal('release-delay'), target: Target }),
  Schema.Struct({ kind: Schema.Literal('wait-response'), target: Target }),
  Schema.Struct({
    kind: Schema.Literal('fork'),
    eventId: Schema.String.check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({ kind: Schema.Literal('release'), actor: Name, stream: Stream }),
]);
const PlanAction = Schema.Union([
  LabTransportAttackActionSchema,
  Schema.Struct({ kind: Schema.Literal('step'), name: Name }),
]);
export type LabTransportAttackAction = typeof LabTransportAttackActionSchema.Type;
export type LabAttackPlanAction = typeof PlanAction.Type;
type Selector = typeof Target.Type;
type MutationValue = typeof Mutation.Type;
export interface LabTransportAttackEvent extends Selector {
  readonly id: string;
  readonly path: string;
  readonly requestOffset: string | null;
  readonly status: number;
  readonly originalBodyHex: string;
  readonly bodyHex: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly source: 'native' | 'fork';
  readonly mutation?: MutationValue['kind'];
}
export class LabAttackTransportError extends Data.TaggedError('LabAttackTransportError')<{
  readonly code:
    | 'closed'
    | 'budget'
    | 'configuration'
    | 'invalid-action'
    | 'missed-target'
    | 'dropped'
    | 'unrepresented-fork-offset';
}> {}
const fail = (code: LabAttackTransportError['code']) => new LabAttackTransportError({ code });
const allowedHeaders = [
  'content-type',
  'stream-next-offset',
  'stream-up-to-date',
  'stream-closed',
  'stream-snapshot-offset',
  'location',
] as const;
const key = (target: Selector) =>
  JSON.stringify([target.actor, target.stream, target.method, target.occurrence]);
const forkKey = (actor: string, stream: string) => JSON.stringify([actor, stream]);
const copyEvent = (row: LabTransportAttackEvent) =>
  Object.freeze({ ...row, headers: Object.freeze({ ...row.headers }) });
type Gate = {
  readonly promise: Promise<void>;
  readonly release: () => void;
  readonly reject: (error: unknown) => void;
};
const gate = (): Gate => {
  let release!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, failPromise) => {
    release = resolve;
    reject = failPromise;
  });
  // Delay may be armed before the matching request begins. Closure rejection is
  // observed even if the target never arrives; it never becomes an unhandled error.
  void promise.catch(() => undefined);
  return { promise, release, reject };
};

/** Native finite-fetch capability for a synthetic malicious transport. It sees
 * fixed public protocol responses only; credentials/cookies/request bodies are
 * never exposed in events or plans. One owner aborts and joins raw fetch/body
 * work and explicit delivery gates before returning from Scope close.
 * A frozen valid prefix is withholding, not proof of a signed fork or freshness. */
export const makeLabAttackTransport = Effect.fn('Lab.makeAttackTransport')(function* (input: {
  readonly origin: string;
  readonly genesis: Bytes.GenesisHash;
  readonly fetch?: typeof fetch;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}) {
  const genesis = yield* Effect.fromResult(Bytes.genesisHash(input.genesis.toBytes()));
  const nativeFetch = input.fetch ?? fetch,
    maxEvents = input.maxEvents ?? 256,
    maxBytes = input.maxBytes ?? 16 * 1024 * 1024;
  const origin = yield* Effect.try({
    try: () => {
      const url = new URL(input.origin);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        !Number.isSafeInteger(maxEvents) ||
        maxEvents < 1 ||
        maxEvents > 4096 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 64 * 1024 * 1024
      )
        throw fail('configuration');
      return url.origin;
    },
    catch: () => fail('configuration'),
  });
  const org = Buffer.from(genesis.toBytes()).toString('hex'),
    prefix = `/ds/${org}/`,
    abort = new AbortController();
  let closed = false,
    retainedBytes = 0,
    requests = 0;
  const raw = new Set<Promise<Response>>(),
    events: LabTransportAttackEvent[] = [],
    actions: LabTransportAttackAction[] = [];
  const counters = new Map<string, number>(),
    mutations = new Map<string, MutationValue>(),
    gates = new Map<string, Gate>(),
    forks = new Map<string, LabTransportAttackEvent>();
  const observed = new Map<
    string,
    {
      readonly promise: Promise<LabTransportAttackEvent>;
      readonly resolve: (event: LabTransportAttackEvent) => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  const guard = () => {
    if (closed) throw fail('closed');
  };
  const charge = (bytes: number) => {
    if (bytes > maxBytes - retainedBytes) throw fail('budget');
    retainedBytes += bytes;
  };
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true;
      abort.abort();
      for (const pending of gates.values()) pending.reject(fail('closed'));
      for (const pending of observed.values()) pending.reject(fail('closed'));
      await Promise.allSettled([...raw]);
    })
  );
  const response = (
    status: number,
    headers: Record<string, string>,
    body: Uint8Array,
    method: string
  ) =>
    new Response(
      method === 'HEAD' || [204, 205, 304].includes(status) ? null : new Uint8Array(body),
      { status, headers }
    );
  const fetchFor = (actor: string): typeof fetch => {
    Result.getOrThrow(Schema.decodeUnknownResult(Name)(actor));
    return (value, init) => {
      guard();
      const request = new Request(value, init),
        url = new URL(request.url);
      if (url.origin !== origin || url.username || url.password || url.hash)
        return Promise.reject(fail('configuration'));
      const tail = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '',
        candidateStream = url.pathname.endsWith('/key-mailbox')
          ? 'mailbox'
          : /staged|epoch-group|epoch-staging/.test(url.pathname)
            ? 'stagedgroup'
            : tail.split('/')[0];
      const selected = Schema.decodeUnknownResult(Stream)(candidateStream),
        method = Schema.decodeUnknownResult(Method)(request.method);
      const protocol = Result.isSuccess(selected) && Result.isSuccess(method);
      let target: Selector | undefined;
      if (protocol) {
        if (++requests > maxEvents) return Promise.reject(fail('budget'));
        const countKey = JSON.stringify([actor, selected.success, method.success]);
        const occurrence = counters.get(countKey) ?? 0;
        counters.set(countKey, occurrence + 1);
        target = { actor, stream: selected.success, method: method.success, occurrence };
      }
      const operation = (async () => {
        const id = target && key(target),
          frozen = target && forks.get(forkKey(actor, target.stream));
        const exactStreamPath = target && tail === target.stream;
        let status: number,
          headers: Record<string, string>,
          original: Uint8Array,
          source: 'native' | 'fork' = 'native';
        if (frozen && exactStreamPath && (request.method === 'GET' || request.method === 'HEAD')) {
          source = 'fork';
          status = 200;
          headers = { ...frozen.headers, 'stream-up-to-date': 'true' };
          const offset = url.searchParams.get('offset') ?? '-1';
          if (request.method === 'HEAD' || offset === frozen.headers['stream-next-offset'])
            original = new Uint8Array();
          else if (offset === frozen.requestOffset)
            original = new Uint8Array(Buffer.from(frozen.bodyHex, 'hex'));
          else throw fail('unrepresented-fork-offset');
        } else {
          const reply = await nativeFetch(
            new Request(request, {
              redirect: target ? 'manual' : request.redirect,
              signal: AbortSignal.any([request.signal, abort.signal]),
            })
          );
          if (!target) return reply; // Auth callbacks retain their existing caller body owner.
          status = reply.status;
          headers = {};
          for (const name of allowedHeaders) {
            const headerValue = reply.headers.get(name);
            if (headerValue !== null) headers[name] = headerValue;
          }
          const body = reply.body ? await readBoundedBody(reply.body, maxBytes) : new Uint8Array();
          if (!body) throw fail('budget');
          original = body;
        }
        guard();
        const mutation = id ? mutations.get(id) : undefined;
        let delivered = new Uint8Array(original);
        if (mutation?.kind === 'replay') {
          const captured = events.find((event) => event.id === mutation.eventId);
          if (!captured) throw fail('missed-target');
          delivered = new Uint8Array(Buffer.from(captured.bodyHex, 'hex'));
          status = captured.status;
          headers = {
            ...captured.headers,
            ...(mutation.nextOffset === undefined
              ? {}
              : { 'stream-next-offset': mutation.nextOffset }),
          };
        } else if (mutation?.kind === 'flip') {
          if (mutation.offset >= delivered.length) throw fail('invalid-action');
          delivered[mutation.offset] = delivered[mutation.offset]! ^ 1;
        } else if (mutation?.kind === 'replace') {
          status = mutation.status;
          headers = { ...(mutation.headers ?? {}) };
          delivered = new Uint8Array(Buffer.from(mutation.bodyHex, 'hex'));
        } else if (mutation?.kind === 'headers') {
          headers = { ...headers, ...mutation.headers };
        } else if (mutation?.kind === 'duplicate') {
          if (original.length > maxBytes / 2) throw fail('budget');
          delivered = new Uint8Array(original.length * 2);
          delivered.set(original);
          delivered.set(original, original.length);
        } else if (mutation?.kind === 'truncate')
          delivered = new Uint8Array(original.subarray(0, mutation.length));
        if (target && id) {
          charge(original.length + delivered.length);
          const event = Object.freeze({
            ...target,
            id,
            path: url.pathname,
            requestOffset: url.searchParams.get('offset'),
            status,
            originalBodyHex: Buffer.from(original).toString('hex'),
            bodyHex: Buffer.from(delivered).toString('hex'),
            headers: Object.freeze({ ...headers }),
            source,
            ...(mutation ? { mutation: mutation.kind } : {}),
          });
          events.push(event);
          observed.get(id)?.resolve(event);
        }
        if (mutation?.kind === 'drop') throw fail('dropped');
        if (mutation?.kind === 'delay')
          await new Promise<void>((resolve, reject) => {
            const aborted = () => reject(fail('closed'));
            if (request.signal.aborted) return aborted();
            request.signal.addEventListener('abort', aborted, { once: true });
            gates
              .get(id!)!
              .promise.then(resolve, reject)
              .finally(() => request.signal.removeEventListener('abort', aborted));
          });
        guard();
        return response(status, headers, delivered, request.method);
      })();
      raw.add(operation);
      operation.then(
        () => raw.delete(operation),
        () => raw.delete(operation)
      );
      return operation;
    };
  };
  const apply = Effect.fnUntraced(function* (value: unknown) {
    const action = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(LabTransportAttackActionSchema)(value),
      catch: () => fail('invalid-action'),
    });
    if (action.kind === 'wait-response') {
      const event = yield* waitForEvent(action.target);
      actions.push(action);
      return { index: actions.length - 1, kind: action.kind, eventId: event.id };
    }
    return yield* Effect.try({
      try: () => {
        guard();
        if (actions.length >= maxEvents) throw fail('budget');
        if (action.kind === 'intercept') {
          const id = key(action.target),
            existing =
              counters.get(
                JSON.stringify([action.target.actor, action.target.stream, action.target.method])
              ) ?? 0;
          if (existing > action.target.occurrence || mutations.has(id)) throw fail('missed-target');
          if (action.mutation.kind === 'replace' || action.mutation.kind === 'headers') {
            if (
              action.mutation.kind === 'replace' &&
              (action.mutation.bodyHex.length > maxBytes * 2 ||
                ([204, 205, 304].includes(action.mutation.status) &&
                  action.mutation.bodyHex.length))
            )
              throw fail('invalid-action');
            const headers: Record<string, string> = {};
            for (const [name, header] of Object.entries(action.mutation.headers ?? {})) {
              if (
                !(allowedHeaders as readonly string[]).includes(name) ||
                header.length > 2048 ||
                /[\r\n]/.test(header)
              )
                throw fail('invalid-action');
              headers[name] = header;
            }
            if (action.mutation.kind === 'replace') charge(action.mutation.bodyHex.length / 2);
            mutations.set(
              id,
              Object.freeze({ ...action.mutation, headers: Object.freeze(headers) })
            );
          } else mutations.set(id, Object.freeze({ ...action.mutation }));
          if (action.mutation.kind === 'delay') gates.set(id, gate());
        } else if (action.kind === 'release-delay') {
          const pending = gates.get(key(action.target));
          if (!pending) throw fail('missed-target');
          pending.release();
        } else if (action.kind === 'fork') {
          const event = events.find((row) => row.id === action.eventId);
          if (
            !event ||
            event.method !== 'GET' ||
            event.requestOffset !== '-1' ||
            event.status !== 200 ||
            event.headers['stream-up-to-date'] !== 'true' ||
            !event.headers['stream-next-offset'] ||
            event.source !== 'native' ||
            event.mutation
          )
            throw fail('invalid-action');
          const id = forkKey(event.actor, event.stream);
          if (forks.has(id)) throw fail('invalid-action');
          forks.set(id, event);
        } else {
          if (!forks.delete(forkKey(action.actor, action.stream))) throw fail('missed-target');
        }
        actions.push(action);
        return Object.freeze({
          index: actions.length - 1,
          kind: action.kind,
          ...(action.kind === 'fork' ? { eventId: action.eventId } : {}),
        });
      },
      catch: (cause) => (cause instanceof LabAttackTransportError ? cause : fail('invalid-action')),
    });
  });
  const waitForEvent = Effect.fnUntraced(function* (selector: Selector) {
    const target = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Target)(selector),
      catch: () => fail('invalid-action'),
    });
    return yield* Effect.tryPromise({
      try: () => {
        guard();
        const id = key(target),
          existing = events.find((event) => event.id === id);
        if (existing) return Promise.resolve(copyEvent(existing));
        let pending = observed.get(id);
        if (!pending) {
          let resolve!: (event: LabTransportAttackEvent) => void, reject!: (error: unknown) => void;
          const promise = new Promise<LabTransportAttackEvent>((yes, no) => {
            resolve = yes;
            reject = no;
          });
          void promise.catch(() => undefined);
          pending = { promise, resolve, reject };
          observed.set(id, pending);
        }
        return pending.promise.then(copyEvent);
      },
      catch: (cause) => (cause instanceof LabAttackTransportError ? cause : fail('invalid-action')),
    });
  });
  return Object.freeze({
    fetchFor,
    apply,
    waitForEvent,
    events: () =>
      Effect.sync(() => {
        guard();
        return Object.freeze(events.map(copyEvent));
      }),
    material: () =>
      Effect.sync(() => {
        guard();
        return Object.freeze({
          transportActions: Object.freeze(
            actions.map((action) =>
              Schema.decodeUnknownSync(LabTransportAttackActionSchema)(action)
            )
          ),
          events: Object.freeze(events.map(copyEvent)),
          hits: Object.freeze(
            events.filter((row) => row.mutation).map((row) => ({ id: row.id, kind: row.mutation! }))
          ),
        });
      }),
  });
});

/** Finite current action material. The private harness grants named real Effect
 * steps once; the attacker plan never receives their devices, keys or directories.
 * Fresh replay reruns the same controls/outcomes, not freshly random wire bytes. */
export const runLabAttackPlan = Effect.fn('Lab.runAttackPlan')(function* <E, R>(input: {
  readonly transport: Effect.Success<ReturnType<typeof makeLabAttackTransport>>;
  readonly actions: readonly unknown[];
  readonly steps: Readonly<Record<string, Effect.Effect<void, E, R>>>;
  readonly maxActions?: number;
}) {
  const maxActions = input.maxActions ?? 256;
  const actions = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(Schema.Array(PlanAction).check(Schema.isMaxLength(maxActions)))(
        input.actions
      ),
    catch: () => fail('invalid-action'),
  });
  const steps = new Map(Object.entries(input.steps)),
    apply = input.transport.apply,
    material = input.transport.material;
  if (!Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > 4096)
    return yield* fail('budget');
  const receipts = [];
  for (const action of actions) {
    if (action.kind === 'step') {
      const step = steps.get(action.name);
      if (!step) return yield* fail('invalid-action');
      yield* step;
      receipts.push({ kind: 'step' as const, name: action.name });
    } else receipts.push(yield* apply(action));
  }
  return Object.freeze({
    actions,
    receipts: Object.freeze(receipts),
    ...(yield* material()),
    scope: 'fresh-attack-controls-and-observed-outcomes' as const,
    resealEquality: 'unsupported' as const,
  });
});
