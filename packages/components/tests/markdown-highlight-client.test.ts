import { describe, expect, it } from 'vitest';
import {
  createMarkdownHighlightClient,
  type MarkdownHighlightRequest,
  type MarkdownHighlightResponse,
  type MarkdownHighlightWorkerLike,
} from '../src/lib/markdown-highlight-client';
import type { MarkdownTokens } from '../src/lib/markdown-highlighter';

/** A worker whose replies the test sends explicitly. */
function createFakeWorker() {
  const received: MarkdownHighlightRequest[] = [];
  let terminated = false;
  const worker: MarkdownHighlightWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => received.push(message),
    terminate: () => {
      terminated = true;
    },
  };
  const reply = (response: MarkdownHighlightResponse) =>
    worker.onmessage?.({ data: response } as MessageEvent<MarkdownHighlightResponse>);
  const crash = (message: string) => worker.onerror?.({ message } as ErrorEvent);
  return { worker, received, reply, crash, isTerminated: () => terminated };
}

const tokensFor = (code: string) =>
  ({ tokens: [[{ content: code, color: 'var(--x)', offset: 0 }]] }) as unknown as MarkdownTokens;

describe('markdown highlight client', () => {
  it('shares one worker round trip between identical in-flight requests', async () => {
    const fake = createFakeWorker();
    const client = createMarkdownHighlightClient(() => fake.worker);

    const first = client.highlight('const a = 1', 'typescript');
    const second = client.highlight('const a = 1', 'typescript');
    const other = client.highlight('const a = 1', 'javascript');
    expect(fake.received.map((request) => request.language)).toEqual(['typescript', 'javascript']);

    fake.reply({ id: fake.received[0]!.id, tokens: tokensFor('ts') });
    fake.reply({ id: fake.received[1]!.id, tokens: tokensFor('js') });
    expect(await first).toBe(await second);
    expect(await other).toEqual(tokensFor('js'));

    // Settled requests are not shared: the next call asks the worker again.
    void client.highlight('const a = 1', 'typescript');
    expect(fake.received).toHaveLength(3);
  });

  it('rejects a failed tokenization without disabling the worker', async () => {
    const fake = createFakeWorker();
    const client = createMarkdownHighlightClient(() => fake.worker);

    const failing = client.highlight('x', 'rust');
    fake.reply({ id: fake.received[0]!.id, error: 'grammar failed' });
    await expect(failing).rejects.toThrow('grammar failed');
    expect(client.usable).toBe(true);
  });

  it('rejects pending requests and becomes unusable when the worker crashes', async () => {
    const fake = createFakeWorker();
    const client = createMarkdownHighlightClient(() => fake.worker);

    const pending = client.highlight('x', 'go');
    fake.crash('out of memory');
    await expect(pending).rejects.toThrow('out of memory');
    expect(client.usable).toBe(false);
    await expect(client.highlight('y', 'go')).rejects.toThrow('unavailable');
    expect(fake.received).toHaveLength(1);

    client.dispose();
    expect(fake.isTerminated()).toBe(true);
  });
});
