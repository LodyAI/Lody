import type { z } from 'zod/v4';
import {
  Envelope,
  PROTOCOL_VERSION,
  type RuntimeError,
} from '../contract/envelope.ts';
import { hostCalls, runtimeCalls, runtimeEvents } from '../contract/methods.ts';

type RuntimeCalls = typeof runtimeCalls;
type HostCalls = typeof hostCalls;
type RuntimeEvents = typeof runtimeEvents;
type Handler<M extends keyof RuntimeCalls> = (
  params: z.output<RuntimeCalls[M]['params']>,
) =>
  | z.input<RuntimeCalls[M]['result']>
  | Promise<z.input<RuntimeCalls[M]['result']>>;

export class ContractError extends Error {
  constructor(
    code: string,
    retryable = false,
    detail?: string,
    upstream?: string,
  ) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
    this.upstream = upstream;
  }
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: string;
  readonly upstream?: string;
}

const codePattern = /^[a-z][a-z0-9_]*$/;

function runtimeError(error: unknown): RuntimeError {
  if (error instanceof ContractError && error.upstream)
    return {
      code: 'host_call_failed',
      retryable: error.retryable,
      detail: `${error.upstream}: ${error.code}`,
    };
  if (error instanceof ContractError)
    return {
      code: error.code,
      retryable: error.retryable,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  const message = error instanceof Error ? error.message : String(error);
  if (codePattern.test(message)) return { code: message, retryable: false };
  return { code: 'runtime_error', retryable: false, detail: message };
}

type Pending = {
  method: keyof HostCalls;
  resolve: (value: unknown) => void;
  reject: (error: ContractError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function droppedKeys(
  value: unknown,
  kept: unknown,
  path = '',
  found: string[] = [],
): string[] {
  if (found.length >= 8) return found;
  if (Array.isArray(value) && Array.isArray(kept)) {
    value.forEach((item, i) =>
      droppedKeys(item, kept[i], `${path}[${i}]`, found),
    );
    return found;
  }
  if (!value || typeof value !== 'object' || !kept || typeof kept !== 'object')
    return found;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (!Object.hasOwn(kept, key)) found.push(`${path}.${key}`);
    else
      droppedKeys(
        item,
        (kept as Record<string, unknown>)[key],
        `${path}.${key}`,
        found,
      );
  }
  return found;
}

export function createChannel(
  post: (text: string) => void,
  options: {
    id?: () => string;
    onDroppedKeys?: (method: string, paths: string[]) => void;
  } = {},
) {
  const nextId = options.id ?? (() => crypto.randomUUID());
  let gen = 0;
  const handlers = new Map<string, (params: unknown) => unknown>();
  const pending = new Map<string, Pending>();
  const write = (message: Envelope) => post(JSON.stringify(message));
  const fail = (
    id: string,
    method: string,
    error: RuntimeError,
    replyGen = gen,
  ) =>
    write({
      v: PROTOCOL_VERSION,
      gen: replyGen,
      kind: 'error',
      id,
      method,
      error,
    });

  function handle<M extends keyof RuntimeCalls>(method: M, fn: Handler<M>) {
    handlers.set(method, fn as (params: unknown) => unknown);
  }

  async function answer(
    id: string,
    method: string,
    payload: unknown,
    replyGen: number,
  ) {
    const spec = Object.hasOwn(runtimeCalls, method)
      ? runtimeCalls[method as keyof RuntimeCalls]
      : undefined;
    const fn = handlers.get(method);
    if (!spec || !fn) {
      fail(
        id,
        method,
        { code: 'unsupported_method', retryable: false },
        replyGen,
      );
      return;
    }
    const params = spec.params.safeParse(payload);
    if (!params.success) {
      fail(
        id,
        method,
        {
          code: 'invalid_params',
          retryable: false,
          detail: params.error.message,
        },
        replyGen,
      );
      return;
    }
    let value: unknown;
    try {
      value = await fn(params.data);
    } catch (error) {
      fail(id, method, runtimeError(error), replyGen);
      return;
    }
    const result = spec.result.safeParse(value);
    if (!result.success) {
      fail(
        id,
        method,
        {
          code: 'invalid_result',
          retryable: false,
          detail: result.error.message,
        },
        replyGen,
      );
      return;
    }
    if (options.onDroppedKeys) {
      const paths = droppedKeys(value, result.data);
      if (paths.length) options.onDroppedKeys(method, paths);
    }
    write({
      v: PROTOCOL_VERSION,
      gen: replyGen,
      kind: 'result',
      id,
      method,
      payload: result.data,
    });
  }

  function settle(id: string, outcome: { value: unknown } | ContractError) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (outcome instanceof ContractError) {
      entry.reject(
        new ContractError(
          outcome.code,
          outcome.retryable,
          outcome.detail,
          entry.method,
        ),
      );
      return;
    }
    const result = hostCalls[entry.method].result.safeParse(outcome.value);
    if (result.success) entry.resolve(result.data);
    else
      entry.reject(
        new ContractError(
          'invalid_result',
          false,
          result.error.message,
          entry.method,
        ),
      );
  }

  function request<M extends keyof HostCalls>(
    method: M,
    params: z.input<HostCalls[M]['params']>,
  ): Promise<z.output<HostCalls[M]['result']>> {
    const spec = hostCalls[method];
    const payload = spec.params.parse(params);
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => settle(id, new ContractError('timeout', true, undefined, method)),
        spec.timeoutMs,
      );
      pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      write({ v: PROTOCOL_VERSION, gen, kind: 'request', id, method, payload });
    });
  }

  function emit<M extends keyof RuntimeEvents>(
    method: M,
    payload: z.input<RuntimeEvents[M]>,
  ) {
    write({
      v: PROTOCOL_VERSION,
      gen,
      kind: 'event',
      method,
      payload: runtimeEvents[method].parse(payload),
    });
  }

  function receive(text: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = Envelope.safeParse(raw);
    if (!parsed.success) {
      const loose = raw as {
        v?: unknown;
        gen?: unknown;
        kind?: unknown;
        id?: unknown;
        method?: unknown;
      };
      if (loose?.kind === 'request' && typeof loose.id === 'string')
        fail(
          loose.id,
          String(loose.method ?? ''),
          {
            code:
              loose.v === PROTOCOL_VERSION
                ? 'invalid_envelope'
                : 'protocol_mismatch',
            retryable: false,
          },
          typeof loose.gen === 'number' ? loose.gen : gen,
        );
      return;
    }
    const message = parsed.data;
    const handshake = message.kind === 'request' && message.method === 'hello';
    if (message.gen !== gen && !handshake) return;
    switch (message.kind) {
      case 'request':
        void answer(message.id, message.method, message.payload, message.gen);
        return;
      case 'result':
        settle(message.id, { value: message.payload });
        return;
      case 'error':
        settle(
          message.id,
          new ContractError(
            message.error.code,
            message.error.retryable,
            message.error.detail,
          ),
        );
        return;
      case 'event':
        return;
    }
  }

  handle('hello', (params) => {
    gen = params.gen;
    if (params.protocol !== PROTOCOL_VERSION)
      throw new ContractError('protocol_mismatch');
    return { protocol: PROTOCOL_VERSION, methods: [...handlers.keys()] };
  });

  return {
    handle,
    request,
    emit,
    receive,
    get gen() {
      return gen;
    },
  };
}
