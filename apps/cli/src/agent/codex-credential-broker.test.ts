import { afterEach, describe, expect, it } from 'vitest';
import { startCodexCredentialBroker, type CodexCredentialBroker } from './codex-credential-broker';

const brokers: CodexCredentialBroker[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

describe('user-side Codex credential broker', () => {
  it('freezes the destination, replaces authorization, and streams only allowed paths', async () => {
    const requests: Array<{
      url: string;
      method?: string;
      headers: Headers;
      redirect?: RequestRedirect;
      body: string;
    }> = [];
    const broker = await startCodexCredentialBroker({
      baseUrl: 'https://relay.example.invalid/v1',
      apiKey: 'synthetic-upstream',
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method,
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
          body: init?.body ? await new Response(init.body as BodyInit).text() : '',
        });
        return new Response('data: synthetic\n\n', {
          headers: {
            'content-type': 'text/event-stream',
            'set-cookie': 'must-not-forward',
            'x-codex-turn-state': 'synthetic-state',
          },
        });
      },
    });
    brokers.push(broker);
    expect(broker.capability).not.toContain('synthetic-upstream');
    const response = await fetch(`${broker.baseUrl}/responses/compact`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${broker.capability}`,
        cookie: 'must-not-forward',
        'openai-beta': 'responses=experimental',
      },
      body: '{"synthetic":true}',
    });
    expect(await response.text()).toBe('data: synthetic\n\n');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-codex-turn-state')).toBe('synthetic-state');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://relay.example.invalid/v1/responses/compact');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer synthetic-upstream');
    expect(requests[0]?.headers.get('cookie')).toBeNull();
    expect(requests[0]?.redirect).toBe('error');
    expect(requests[0]?.body).toBe('{"synthetic":true}');
    expect((await fetch(`${broker.baseUrl}/responses`, { method: 'POST' })).status).toBe(401);
    expect(
      (
        await fetch(`${broker.baseUrl}/responses?url=https://other.invalid`, {
          method: 'POST',
          headers: { authorization: `Bearer ${broker.capability}` },
        })
      ).status
    ).toBe(404);
    expect(requests).toHaveLength(1);
  });

  it('does not expose upstream error bodies or redirect locations', async () => {
    const broker = await startCodexCredentialBroker({
      baseUrl: 'https://relay.example.invalid/v1',
      apiKey: 'synthetic-secret',
      fetch: async () =>
        new Response('synthetic-secret', {
          status: 307,
          headers: { location: 'http://leak.example.invalid' },
        }),
    });
    brokers.push(broker);
    const response = await fetch(`${broker.baseUrl}/models`, {
      headers: { authorization: `Bearer ${broker.capability}` },
    });
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).not.toContain('synthetic-secret');
  });

  it('aborts an in-flight upstream request when its process closes', async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const broker = await startCodexCredentialBroker({
      baseUrl: 'https://relay.example.invalid/v1',
      apiKey: 'synthetic-secret',
      fetch: async (_url, init) => {
        const signal = init?.signal as AbortSignal;
        entered.resolve(signal);
        return await new Promise<Response>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        );
      },
    });
    brokers.push(broker);
    const response = fetch(`${broker.baseUrl}/models`, {
      headers: { authorization: `Bearer ${broker.capability}` },
    }).catch(() => undefined);
    const signal = await entered.promise;
    await broker.close();
    expect(signal.aborted).toBe(true);
    await response;
  });
});
