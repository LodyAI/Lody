import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const diffParseWorkerMock = vi.hoisted(() => {
  const instances: FakeDiffParseWorker[] = [];

  class FakeDiffParseWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    readonly messages: unknown[] = [];
    terminated = false;

    constructor() {
      instances.push(this);
    }

    postMessage(message: unknown): void {
      if (this.terminated) {
        throw new Error('worker terminated');
      }
      this.messages.push(message);
      if (isFinishMessage(message)) {
        globalThis.setTimeout(() => {
          this.onmessage?.({
            data: {
              id: message.id,
              result: {
                hunks: [],
                deletionLines: ['full old text'],
                additionLines: ['full new text'],
              },
              durationMs: 1,
            },
          } as MessageEvent<unknown>);
        }, 0);
      }
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  function isFinishMessage(
    message: unknown
  ): message is { readonly type: 'finish'; readonly id: number } {
    return (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      (message as { readonly type?: unknown }).type === 'finish' &&
      typeof (message as { readonly id?: unknown }).id === 'number'
    );
  }

  return { FakeDiffParseWorker, instances };
});

vi.mock('../src/lib/diff-parse.worker?worker', () => ({
  default: diffParseWorkerMock.FakeDiffParseWorker,
}));

import {
  __resetDiffParseWorkerForTests,
  DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH,
  parseDiffInWorker,
  parseDiffTextSourceInWorker,
} from '../src/lib/diff-parse-worker';

describe('parseDiffInWorker', () => {
  beforeEach(() => {
    diffParseWorkerMock.instances.length = 0;
    vi.stubGlobal('Worker', class Worker {});
  });

  afterEach(() => {
    __resetDiffParseWorkerForTests();
    vi.unstubAllGlobals();
  });

  it('sends large diff text to the worker in yielded chunks instead of one full payload', async () => {
    const oldText = 'a'.repeat(DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH * 2 + 7);
    const newText = 'b'.repeat(DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH + 3);

    const resultPromise = parseDiffInWorker({
      path: 'src/large.ts',
      oldText,
      newText,
      lang: 'typescript',
      oldCacheKey: 'old-cache',
      newCacheKey: 'new-cache',
    });

    const worker = diffParseWorkerMock.instances[0];
    expect(worker).toBeDefined();
    const expectedMessageCount = 1 + 3 + 2 + 1;
    expect(worker!.messages).toHaveLength(2);

    const result = await resultPromise;

    expect(result).toEqual({
      hunks: [],
      deletionLines: ['full old text'],
      additionLines: ['full new text'],
    });
    expect(worker!.messages).toHaveLength(expectedMessageCount);
    expect(worker!.messages[0]).toMatchObject({
      type: 'start',
      path: 'src/large.ts',
      oldTextLength: oldText.length,
      newTextLength: newText.length,
      lang: 'typescript',
      oldCacheKey: 'old-cache',
      newCacheKey: 'new-cache',
    });
    expect(worker!.messages.at(-1)).toMatchObject({ type: 'finish' });
    expect(
      worker!.messages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          ('oldText' in message || 'newText' in message)
      )
    ).toBe(false);
    expect(
      worker!.messages
        .filter((message) => isChunkMessage(message, 'old'))
        .map((message) => message.text.length)
    ).toEqual([DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH, DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH, 7]);
    expect(
      worker!.messages
        .filter((message) => isChunkMessage(message, 'new'))
        .map((message) => message.text.length)
    ).toEqual([DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH, 3]);
  });

  it('streams diff text from a chunk source without materializing full text in the request', async () => {
    const oldText = 'a'.repeat(DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH + 5);
    const newText = 'b'.repeat(DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH * 2 + 9);
    const readChunkCalls: Array<{
      readonly side: 'old' | 'new';
      readonly startOffset: number;
      readonly endOffset: number;
    }> = [];

    const resultPromise = parseDiffTextSourceInWorker({
      path: 'src/chunk-source.ts',
      source: {
        oldTextLength: oldText.length,
        newTextLength: newText.length,
        readChunk: async (input) => {
          readChunkCalls.push(input);
          const text = input.side === 'old' ? oldText : newText;
          return text.slice(input.startOffset, input.endOffset);
        },
      },
      lang: 'typescript',
      oldCacheKey: 'old-source',
      newCacheKey: 'new-source',
    });

    const worker = diffParseWorkerMock.instances[0];
    expect(worker).toBeDefined();
    const result = await resultPromise;

    expect(result).toEqual({
      hunks: [],
      deletionLines: ['full old text'],
      additionLines: ['full new text'],
    });
    expect(worker!.messages[0]).toMatchObject({
      type: 'start',
      path: 'src/chunk-source.ts',
      oldTextLength: oldText.length,
      newTextLength: newText.length,
      oldCacheKey: 'old-source',
      newCacheKey: 'new-source',
    });
    expect(
      worker!.messages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          ('oldText' in message || 'newText' in message)
      )
    ).toBe(false);
    expect(readChunkCalls).toEqual([
      { side: 'old', startOffset: 0, endOffset: DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH },
      {
        side: 'old',
        startOffset: DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH,
        endOffset: oldText.length,
      },
      { side: 'new', startOffset: 0, endOffset: DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH },
      {
        side: 'new',
        startOffset: DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH,
        endOffset: DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH * 2,
      },
      {
        side: 'new',
        startOffset: DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH * 2,
        endOffset: newText.length,
      },
    ]);
  });
});

function isChunkMessage(
  message: unknown,
  side: 'old' | 'new'
): message is { readonly type: 'chunk'; readonly side: 'old' | 'new'; readonly text: string } {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { readonly type?: unknown }).type === 'chunk' &&
    (message as { readonly side?: unknown }).side === side &&
    typeof (message as { readonly text?: unknown }).text === 'string'
  );
}
