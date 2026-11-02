import { afterEach, describe, expect, it, vi } from 'vitest';

type WorkerHarness = {
  onmessage:
    | ((
        event: MessageEvent<{
          readonly id: number;
          readonly path: string;
          readonly oldText: string;
          readonly newText: string;
        }>
      ) => void)
    | null;
  postMessage: ReturnType<typeof vi.fn>;
};

describe('diff-parse.worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('posts partial indexed diff text with the original changed lines', async () => {
    const worker: WorkerHarness = {
      onmessage: null,
      postMessage: vi.fn(),
    };
    vi.stubGlobal('self', worker);
    await import('../src/lib/diff-parse.worker');

    worker.onmessage?.({
      data: {
        id: 1,
        path: 'src/example.ts',
        oldText: 'const value = 1;\n',
        newText: 'const value = 2;\n',
      },
    } as MessageEvent<{
      readonly id: number;
      readonly path: string;
      readonly oldText: string;
      readonly newText: string;
    }>);

    const response = worker.postMessage.mock.calls[0]?.[0];
    expect(response).toMatchObject({ id: 1 });
    const result = readResult(response);
    expect(result.hunks.length).toBeGreaterThan(0);
    expect(result).toMatchObject({
      isPartial: true,
      deletionLines: ['const value = 1;\n'],
      additionLines: ['const value = 2;\n'],
    });
  });
});

function readResult(response: unknown): { readonly hunks: readonly unknown[] } {
  if (
    typeof response !== 'object' ||
    response === null ||
    !('result' in response) ||
    typeof response.result !== 'object' ||
    response.result === null ||
    !('hunks' in response.result) ||
    !Array.isArray(response.result.hunks)
  ) {
    throw new Error('Expected diff parse worker result');
  }
  return response.result as { readonly hunks: readonly unknown[] };
}
