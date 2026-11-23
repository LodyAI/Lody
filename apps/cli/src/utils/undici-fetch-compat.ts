import {
  fetch as undiciFetch,
  Request as UndiciRequest,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function isNativeRequest(input: RequestInfo | URL): input is Request {
  return (
    typeof globalThis.Request === 'function' &&
    input instanceof globalThis.Request &&
    !(input instanceof UndiciRequest)
  );
}

function wrapAsGlobalResponse(response: Awaited<ReturnType<typeof undiciFetch>>): Response {
  if (typeof globalThis.Response === 'function' && response instanceof globalThis.Response) {
    return response;
  }
  const body = NULL_BODY_STATUSES.has(response.status) ? null : (response.body as BodyInit | null);
  const wrapped = new globalThis.Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers as unknown as HeadersInit,
  });
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
  return wrapped;
}

export async function fetchWithUndiciDispatcher(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  defaultDispatcher: Dispatcher
): Promise<Response> {
  const callerDispatcher = (init as { dispatcher?: Dispatcher } | undefined)?.dispatcher;
  const dispatcher = callerDispatcher ?? defaultDispatcher;

  let response: Awaited<ReturnType<typeof undiciFetch>>;
  if (isNativeRequest(input)) {
    const method = init?.method ?? input.method;
    const headers = Array.from(new Headers(init?.headers ?? input.headers).entries());
    const body =
      init?.body !== undefined
        ? init.body
        : method === 'GET' || method === 'HEAD'
          ? undefined
          : (input.body ?? undefined);
    const nextInit: UndiciRequestInit = {
      method,
      headers,
      redirect: init?.redirect ?? input.redirect,
      referrer: init?.referrer ?? input.referrer,
      referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
      mode: init?.mode ?? input.mode,
      credentials: init?.credentials ?? input.credentials,
      integrity: init?.integrity ?? input.integrity,
      keepalive: init?.keepalive ?? input.keepalive,
      signal: init?.signal !== undefined ? init.signal : input.signal,
      ...(body !== undefined
        ? { body: body as UndiciRequestInit['body'], duplex: 'half' as const }
        : {}),
      dispatcher,
    };
    response = await undiciFetch(input.url, nextInit);
  } else {
    const nextInit = {
      ...(init ?? {}),
      dispatcher,
    } as NonNullable<Parameters<typeof undiciFetch>[1]>;
    response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], nextInit);
  }

  return wrapAsGlobalResponse(response);
}
