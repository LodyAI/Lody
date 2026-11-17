/** Public local-gateway token: a usage label, never a vendor credential. */
export const MAGPIE_TOKEN = 'magpie-lody';
export const MAGPIE_TARGETS = ['claude', 'codex', 'pi', 'dsh', 'kimi', 'grok', 'bub'] as const;
export type MagpieTarget = (typeof MAGPIE_TARGETS)[number];
export type MagpieImport = { gatewayUrl: string; targets: MagpieTarget[] };

/** Import never authorizes arbitrary hosts, paths, credentials, or launch fields. */
export function normalizeMagpieGateway(value: string): string {
  if (value.length > 256) throw new Error('Invalid Magpie gateway');
  const url = new URL(value);
  if (
    !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\/?$/.test(value) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Magpie requires a local HTTP gateway');
  return url.origin;
}

export function isMagpieGatewayUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return normalizeMagpieGateway(value) === value;
  } catch {
    return false;
  }
}

export function isMagpieImportLink(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['lody:', 'lody-oss:', 'ai.lody.stable:', 'ai.lody.nightly:'].includes(url.protocol) &&
      url.hostname === 'provider' &&
      url.pathname === '/import'
    );
  } catch {
    return false;
  }
}

/** Versioned, bounded Cindy-style envelope. Only the fixed local Magpie token is accepted. */
export function parseMagpieImportLink(value: string): MagpieImport {
  if (value.length > 8192 || !isMagpieImportLink(value)) throw new Error('Invalid Magpie import');
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== 'v' && key !== 'data') ||
    url.searchParams.getAll('v').length !== 1 ||
    url.searchParams.get('v') !== '1' ||
    url.searchParams.getAll('data').length !== 1
  )
    throw new Error('Invalid Magpie import');
  const data = url.searchParams.get('data') ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(data)) throw new Error('Invalid Magpie import');
  const raw: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    )
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid Magpie import');
  const payload = raw as Record<string, unknown>;
  if (
    Object.keys(payload).some((k) => !['kind', 'id', 'name', 'auth', 'endpoints'].includes(k)) ||
    payload.kind !== 'custom' ||
    payload.id !== 'magpie' ||
    payload.name !== 'Magpie'
  )
    throw new Error('Invalid Magpie provider');
  const auth = payload.auth as Record<string, unknown> | undefined;
  if (
    !auth ||
    Object.keys(auth).length !== 2 ||
    auth.method !== 'apiKey' ||
    auth.apiKey !== MAGPIE_TOKEN
  )
    throw new Error('Invalid Magpie token');
  if (
    !Array.isArray(payload.endpoints) ||
    !payload.endpoints.length ||
    payload.endpoints.length > 3
  )
    throw new Error('Invalid Magpie endpoints');
  let gatewayUrl: string | undefined;
  const targets = new Set<MagpieTarget>();
  for (const rawEndpoint of payload.endpoints) {
    if (!rawEndpoint || typeof rawEndpoint !== 'object' || Array.isArray(rawEndpoint))
      throw new Error('Invalid Magpie endpoint');
    const endpoint = rawEndpoint as Record<string, unknown>;
    if (
      Object.keys(endpoint).some(
        (k) => !['protocol', 'baseUrl', 'targets', 'modelsUrl'].includes(k)
      ) ||
      typeof endpoint.baseUrl !== 'string' ||
      !Array.isArray(endpoint.targets) ||
      !endpoint.targets.length
    )
      throw new Error('Invalid Magpie endpoint');
    const anthropic = endpoint.protocol === 'anthropic-messages';
    if (
      !anthropic &&
      endpoint.protocol !== 'openai-responses' &&
      endpoint.protocol !== 'openai-chat'
    )
      throw new Error('Invalid Magpie protocol');
    const base = endpoint.baseUrl;
    if (!anthropic && !base.endsWith('/v1')) throw new Error('Invalid Magpie API path');
    const gateway = normalizeMagpieGateway(anthropic ? base : base.slice(0, -3));
    if ((gatewayUrl && gatewayUrl !== gateway) || endpoint.modelsUrl !== `${gateway}/v1/models`)
      throw new Error('Magpie endpoints must use the same local gateway');
    gatewayUrl = gateway;
    const allowed: Record<string, MagpieTarget> = anthropic
      ? { 'claude-code': 'claude' }
      : endpoint.protocol === 'openai-responses'
        ? { codex: 'codex' }
        : { pi: 'pi', dsh: 'dsh', 'kimi-code': 'kimi', grok: 'grok', bub: 'bub' };
    for (const target of endpoint.targets) {
      const resolved =
        typeof target === 'string' && Object.hasOwn(allowed, target) ? allowed[target] : undefined;
      if (!resolved || targets.has(resolved)) throw new Error('Invalid Magpie target');
      targets.add(resolved);
    }
  }
  if (!gatewayUrl) throw new Error('Missing Magpie gateway');
  return { gatewayUrl, targets: MAGPIE_TARGETS.filter((target) => targets.has(target)) };
}

export function magpieProviderSettings(target: MagpieTarget, gatewayUrl: string) {
  const gateway = normalizeMagpieGateway(gatewayUrl);
  const env: Record<string, string> = {};
  if (target === 'claude')
    Object.assign(env, { ANTHROPIC_BASE_URL: gateway, ANTHROPIC_AUTH_TOKEN: MAGPIE_TOKEN });
  if (target === 'codex')
    Object.assign(env, { OPENAI_API_KEY: MAGPIE_TOKEN, OPENAI_BASE_URL: `${gateway}/v1` });
  if (target === 'dsh')
    Object.assign(env, { DEEPSEEK_API_KEY: MAGPIE_TOKEN, DEEPSEEK_BASE_URL: `${gateway}/v1` });
  return {
    magpieGatewayUrl: gateway,
    name: `${{ claude: 'Claude', codex: 'Codex', pi: 'Pi', dsh: 'DSH', kimi: 'Kimi Code', grok: 'Grok', bub: 'Bub' }[target]}-magpie`,
    cliType: 'builtin' as const,
    agentType: target === 'dsh' ? 'deepseek' : target,
    env,
  };
}
