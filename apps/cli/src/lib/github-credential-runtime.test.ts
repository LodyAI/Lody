import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { githubCredentialRuntime } from './github-credential-runtime';

function harness(
  options: { personal?: string; app?: string; owner?: boolean; offline?: boolean } = {}
) {
  const events: string[] = [];
  const logs: string[] = [];
  const context = vm.runInNewContext(
    githubCredentialRuntime +
      '\n({ readCredentialPolicy, selectGitHubCredential, githubCredentials, readCredentialContext })',
    {
      getContext: () => ({ contextToken: 'fixture', allowLocalAuth: options.owner ?? true }),
      requestBroker: async (_endpoint: string, body: { source: 'personal' | 'app' }) => {
        events.push(body.source);
        if (options.offline)
          throw Object.assign(new Error('SECRET'), { cause: { code: 'ECONNREFUSED' } });
        const token = options[body.source];
        return Response.json(
          token
            ? { token, tokenSource: body.source }
            : { available: false, reason: 'personal_auth_missing' }
        );
      },
      console: { error: (message: string) => logs.push(message) },
    }
  );
  const local = async () => {
    events.push('local');
    return { token: 'machine' };
  };
  return { context, events, logs, local };
}

describe('ordered GitHub credentials', () => {
  it('selects personal first without a policy request or a permission API', async () => {
    const h = harness({ personal: 'personal' });
    const selected = await h.context.selectGitHubCredential(
      'org/repo',
      h.context.readCredentialPolicy(),
      h.local,
      true
    );
    expect(selected).toEqual({ token: 'personal', source: 'personal' });
    expect(h.events).toEqual(['personal']);
  });
  it('uses authorized machine credentials while the broker is offline', async () => {
    const h = harness({ offline: true });
    const selected = await h.context.selectGitHubCredential(
      'org/repo',
      h.context.readCredentialPolicy(),
      h.local,
      true
    );
    expect(selected.source).toBe('local');
    expect(h.events).toEqual(['personal', 'local']);
    expect(h.logs.join('\n')).toContain('ECONNREFUSED');
    expect(h.logs.join('\n')).not.toContain('SECRET');
  });
  it('skips machine credentials for another owner and uses repository App credentials', async () => {
    const h = harness({ owner: false, app: 'repository-app' });
    const selected = await h.context.selectGitHubCredential(
      'org/repo',
      h.context.readCredentialPolicy(),
      h.local,
      true
    );
    expect(selected).toEqual({ token: 'repository-app', source: 'app' });
    expect(h.events).toEqual(['personal', 'app']);
  });
  it('does not retry a rejected credential and advances after native access failure', async () => {
    const h = harness({ personal: 'revoked', app: 'app' });
    const selected = await h.context.selectGitHubCredential(
      'org/repo',
      h.context.readCredentialPolicy(),
      h.local,
      true,
      undefined,
      async (candidate: { source: string }) => {
        if (candidate.source === 'personal')
          throw Object.assign(new Error('SECRET'), { code: 'access_denied', status: 403 });
        return true;
      }
    );
    expect(selected.source).toBe('local');
    expect(h.events).toEqual(['personal', 'local']);
    expect(h.logs.join('\n')).toContain('"status":403');
    expect(h.logs.join('\n')).not.toContain('SECRET');
  });
  it('permits anonymous reads last, even with both managed providers down', async () => {
    const h = harness({ owner: false, offline: true });
    const selected = await h.context.selectGitHubCredential(
      'public/tool',
      h.context.readCredentialPolicy(),
      h.local,
      false,
      async () => true
    );
    expect(selected.source).toBe('anonymous');
    expect(h.events).toEqual(['personal', 'app']);
  });
  it('exhausts a failed write with source-specific causes and no anonymous identity', async () => {
    const h = harness({ owner: false, offline: true });
    await expect(
      h.context.selectGitHubCredential(
        'org/repo',
        h.context.readCredentialPolicy(),
        h.local,
        true,
        async () => true
      )
    ).rejects.toMatchObject({
      code: 'credentials_exhausted',
      failures: [
        { source: 'personal', stage: 'acquire', code: 'ECONNREFUSED' },
        { source: 'app', stage: 'acquire', code: 'ECONNREFUSED' },
      ],
    });
  });
  it('retains the same iterator through execution fallbacks', async () => {
    const h = harness({ personal: 'personal', app: 'app' });
    const iterator = h.context.githubCredentials(
      'org/repo',
      h.context.readCredentialPolicy(),
      h.local
    );
    expect((await iterator.next()).value.source).toBe('personal');
    expect((await iterator.next()).value.source).toBe('local');
    expect((await iterator.next()).value.source).toBe('app');
    await expect(iterator.next()).rejects.toMatchObject({ code: 'credentials_exhausted' });
    expect(h.events).toEqual(['personal', 'local', 'app']);
  });
  it('rejects missing or malformed host context instead of trusting environment ownership', () => {
    const h = harness();
    expect(() =>
      h.context.readCredentialContext({ readFileSync: () => '{}' }, '/broker', {
        LODY_GIT_CRED_CONTEXT_TOKEN: 'old',
        LODY_ALLOW_LOCAL_AUTH: 'true',
      })
    ).toThrow('context_invalid');
    expect(() =>
      h.context.readCredentialContext({}, '/broker', { LODY_ALLOW_LOCAL_AUTH: 'true' })
    ).toThrow('context_missing');
  });
  it('reads a pinned host snapshot without the mutable session context file', () => {
    const h = harness();
    const context = h.context.readCredentialContext(
      {
        readFileSync: (file: string) => {
          if (file !== '/workspace/broker.contexts/frozen.json') throw new Error('wrong authority');
          return JSON.stringify({ version: 1, contextToken: 'frozen', allowLocalAuth: false });
        },
      },
      '/workspace/broker',
      { LODY_GIT_CRED_CONTEXT_TOKEN: 'frozen' }
    );
    expect(context).toEqual({ version: 1, contextToken: 'frozen', allowLocalAuth: false });
  });
});
