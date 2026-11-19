/*
 * A user-defined endpoint's models are discovered from the endpoint itself:
 * the point of adding one is to use what it already serves, not to make the
 * user type model ids before anything works.
 *
 * The three protocols answer on the same `/models` shape often enough that one
 * request covers them; Anthropic's needs its own headers.
 */
import type { EndpointModel, EndpointProtocol } from './store';

export const ENDPOINT_PROTOCOLS: EndpointProtocol[] = [
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
];

export const PROTOCOL_LABEL: Record<EndpointProtocol, string> = {
  'anthropic-messages': 'Anthropic',
  'openai-responses': 'OpenAI · Responses',
  'openai-completions': 'OpenAI · Completions',
};

const MAX_MODELS = 200;

const headersFor = (protocol: EndpointProtocol, key: string): Record<string, string> =>
  protocol === 'anthropic-messages'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json' }
    : { Authorization: `Bearer ${key}`, Accept: 'application/json' };

type ModelPayload = { data?: unknown; models?: unknown };

/** The ids an OpenAI- or Anthropic-shaped `/models` response carries. */
function readModels(body: unknown): EndpointModel[] {
  if (!body || typeof body !== 'object') return [];
  const payload = body as ModelPayload;
  const list = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];

  return list
    .map((entry): EndpointModel | null => {
      if (typeof entry === 'string') return { id: entry };
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as { id?: unknown; name?: unknown; display_name?: unknown };
      if (typeof record.id !== 'string' || !record.id.trim()) return null;
      const name = record.display_name ?? record.name;
      return typeof name === 'string' && name.trim() ? { id: record.id, name } : { id: record.id };
    })
    .filter((model): model is EndpointModel => model !== null)
    .slice(0, MAX_MODELS);
}

/**
 * Asks the endpoint what it serves. Returns an empty list when it says nothing
 * usable — an endpoint that cannot answer still gets added, and its models are
 * edited by hand afterwards.
 */
export async function discoverEndpointModels(input: {
  protocol: EndpointProtocol;
  baseUrl: string;
  key: string;
  signal?: AbortSignal;
}): Promise<EndpointModel[]> {
  const root = input.baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(root)) return [];

  const headers = headersFor(input.protocol, input.key);
  // `/models` on the given root, then on its `/v1`, which gateways accept too.
  const candidates = [`${root}/models`, `${root}/v1/models`];

  for (const url of candidates) {
    try {
      const response = await fetch(url, { headers, signal: input.signal });
      if (!response.ok) continue;
      const models = readModels(await response.json());
      if (models.length) return models;
    } catch {
      // Offline, blocked by the renderer, or not that shape: try the next one.
    }
  }
  return [];
}
