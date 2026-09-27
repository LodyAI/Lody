import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { githubCredentialRuntime } from './github-credential-runtime';

function harness(
  options: {
    personal?: string | null;
    refreshed?: string | null;
    status?: number;
    push?: boolean;
  } = {}
) {
  const requests: Array<Record<string, unknown>> = [];
  const requestBroker = vi.fn(async (_path: string, body: Record<string, unknown>) => {
    requests.push(body);
    const token =
      body.source === 'app'
        ? 'app'
        : body.invalidatedPersonalToken
          ? options.refreshed
          : options.personal;
    return {
      ok: true,
      json: async () => (token ? { token, tokenSource: body.source } : { available: false }),
    };
  });
  const fetch = vi.fn(async (_url: string, init: { headers: { Authorization: string } }) => {
    const status =
      init.headers.Authorization === 'Bearer refreshed' ? 200 : (options.status ?? 200);
    return {
      ok: status === 200,
      status,
      json: async () => ({ permissions: { push: options.push ?? true } }),
    };
  });
  const local = vi.fn(async () => ({ token: 'local' }));
  const log = vi.fn();
  const select = vm.runInNewContext(githubCredentialRuntime + '\nselectGitHubCredential', {
    requestBroker,
    getContextToken: () => 'context',
    fetch,
    AbortSignal,
    URL,
    console: { error: log },
  }) as (
    repo: string,
    policy: { personalEnabled: boolean; allowLocalAuth: boolean },
    local: typeof local,
    write: boolean
  ) => Promise<{ token: string; source: string }>;
  return { requests, fetch, local, log, select };
}

describe('per-command GitHub credential policy', () => {
  it.each([null, { ok: false, status: 503, json: async () => ({ error: 'policy_unavailable' }) }])(
    'does not tell users to restart for policy service failures',
    async (response) => {
      const readPolicy = vm.runInNewContext(githubCredentialRuntime + '\nreadCredentialPolicy', {
        getContextToken: () => 'context',
        requestBroker: async () => response,
      }) as () => Promise<unknown>;
      await expect(readPolicy()).rejects.toThrow('Check the Lody connection and machine access');
    }
  );
  it('reserves session restart guidance for invalid contexts', async () => {
    const readPolicy = vm.runInNewContext(githubCredentialRuntime + '\nreadCredentialPolicy', {
      getContextToken: () => 'context',
      requestBroker: async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: 'invalid_context' }),
      }),
    }) as () => Promise<unknown>;
    await expect(readPolicy()).rejects.toThrow('Restart this session');
  });
  it('follows public rename redirects without credentials and rejects a different API origin', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 301, headers: { get: () => '/repos/org/new' } })
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ private: false }) });
    const check = vm.runInNewContext(githubCredentialRuntime + '\ncheckRepositoryCredential', {
      fetch,
      URL,
      AbortSignal,
    }) as (token: null, repo: string, write: boolean, publicOnly: boolean) => Promise<string>;
    expect(await check(null, 'org/old', false, true)).toBe('usable');
    expect(fetch.mock.calls.every((call) => call[1].headers.Authorization === undefined)).toBe(
      true
    );
    expect(fetch.mock.calls[1][0]).toBe('https://api.github.com/repos/org/new');
    fetch.mockResolvedValueOnce({
      status: 301,
      headers: { get: () => 'https://other.example/steal' },
    });
    await expect(check(null, 'org/old', false, true)).rejects.toThrow('Unsafe GitHub redirect');
  });
  it('defaults the owner to local without minting an App token', async () => {
    const h = harness();
    expect(
      await h.select('owner/other', { personalEnabled: false, allowLocalAuth: true }, h.local, true)
    ).toEqual({ token: 'local', source: 'local' });
    expect(h.requests).toEqual([]);
  });
  it('personal preference wins over usable local credentials', async () => {
    const h = harness({ personal: 'personal' });
    expect(
      (await h.select('owner/repo', { personalEnabled: true, allowLocalAuth: true }, h.local, true))
        .source
    ).toBe('personal');
    expect(h.local).not.toHaveBeenCalled();
    expect(h.requests.map((r) => r.source)).toEqual(['personal']);
  });
  it('non-owner never reads machine-local credentials', async () => {
    const h = harness();
    expect(
      (
        await h.select(
          'owner/submodule',
          { personalEnabled: true, allowLocalAuth: false },
          h.local,
          true
        )
      ).source
    ).toBe('app');
    expect(h.local).not.toHaveBeenCalled();
    expect(h.requests.map((r) => [r.repoFullName, r.source])).toEqual([
      ['owner/submodule', 'personal'],
      ['owner/submodule', 'app'],
    ]);
  });
  it('refreshes a rejected personal token before considering another identity', async () => {
    const h = harness({ personal: 'expired', refreshed: 'refreshed', status: 401 });
    expect(
      (await h.select('owner/repo', { personalEnabled: true, allowLocalAuth: true }, h.local, true))
        .token
    ).toBe('refreshed');
    expect(h.requests[1].invalidatedPersonalToken).toBe('expired');
    expect(h.local).not.toHaveBeenCalled();
  });
  it('reports confirmed personal permission fallback to local', async () => {
    const h = harness({ personal: 'read-only', push: false });
    expect(
      (await h.select('owner/repo', { personalEnabled: true, allowLocalAuth: true }, h.local, true))
        .source
    ).toBe('local');
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('machine-local'));
  });
  it.each([403, 429, 500])('does not change identity on HTTP %s', async (status) => {
    const h = harness({ personal: 'personal', status });
    await expect(
      h.select('owner/repo', { personalEnabled: true, allowLocalAuth: true }, h.local, true)
    ).rejects.toThrow('identity was not changed');
    expect(h.local).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
  });
  it('does not change identity on network failure', async () => {
    const h = harness({ personal: 'personal' });
    h.fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(
      h.select('owner/repo', { personalEnabled: true, allowLocalAuth: true }, h.local, true)
    ).rejects.toThrow('offline');
    expect(h.requests).toHaveLength(1);
  });
});
