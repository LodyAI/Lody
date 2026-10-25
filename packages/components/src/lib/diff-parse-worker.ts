import type { FileDiffMetadata, SupportedLanguages } from '@pierre/diffs';
import type { DiffTextChunkSide, DiffTextChunkSource } from './diff-text-chunk-source';
import DiffParseWorker from './diff-parse.worker?worker';
import { logDiffPerf, logDiffPerfDurationLazy, getDiffPerfNow } from './diff-perf';
import { createWebWorkerRequestClient } from './web-worker-request-client';

const DEFAULT_DIFF_PARSE_WORKER_TIMEOUT_MS = 8_000;
export const DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH = 64 * 1024;

type DiffParseWorkerInput = {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly lang?: SupportedLanguages;
  readonly oldCacheKey?: string;
  readonly newCacheKey?: string;
};

type DiffParseWorkerTextSourceInput = {
  readonly path: string;
  readonly source: DiffTextChunkSource;
  readonly lang?: SupportedLanguages;
  readonly oldCacheKey?: string;
  readonly newCacheKey?: string;
};

type DiffParseWorkerResponse =
  | {
      readonly id: number;
      readonly result: FileDiffMetadata;
      readonly durationMs: number;
    }
  | {
      readonly id: number;
      readonly error: string;
    };

type DiffParseWorkerRequest =
  | {
      readonly type: 'start';
      readonly id: number;
      readonly path: string;
      readonly oldTextLength: number;
      readonly newTextLength: number;
      readonly lang?: SupportedLanguages;
      readonly oldCacheKey?: string;
      readonly newCacheKey?: string;
    }
  | {
      readonly type: 'chunk';
      readonly id: number;
      readonly side: 'old' | 'new';
      readonly text: string;
    }
  | {
      readonly type: 'finish';
      readonly id: number;
    };

type DiffParseWorkerOutcome =
  | {
      readonly type: 'success';
      readonly result: FileDiffMetadata;
      readonly workerDurationMs: number;
    }
  | { readonly type: 'unavailable' }
  | { readonly type: 'timeout' }
  | { readonly type: 'error'; readonly error: Error };

type DiffParseJobInput = {
  readonly path: string;
  readonly oldTextLength: number;
  readonly newTextLength: number;
};

export async function parseDiffInWorker(
  input: DiffParseWorkerInput,
  timeoutMs = DEFAULT_DIFF_PARSE_WORKER_TIMEOUT_MS
): Promise<FileDiffMetadata | undefined> {
  const jobInput = {
    path: input.path,
    oldTextLength: input.oldText.length,
    newTextLength: input.newText.length,
  };
  const startedAt = getDiffPerfNow();
  const outcome = await workerClient.request<DiffParseWorkerInput, DiffParseWorkerOutcome>({
    input,
    timeoutMs,
    defaultTimeoutMs: DEFAULT_DIFF_PARSE_WORKER_TIMEOUT_MS,
    fallbackResult: { type: 'unavailable' },
    timeoutFallbackResult: { type: 'timeout' },
    postMessageFallbackResult: (error) => ({
      type: 'error',
      error:
        error instanceof Error
          ? error
          : new Error(`Diff parse worker postMessage failed: ${formatUnknownError(error)}`),
    }),
    restartFallbackResult: (reason) => ({
      type: 'error',
      error: new Error(`Diff parse worker restarted: ${reason}`),
    }),
    timeoutRestartReason: 'timeout',
    postMessageRestartReason: 'post-message',
    postMessage: ({ worker, id, request }) => postDiffParseRequestInChunks(worker, id, request),
  });
  return finishDiffParseOutcome(jobInput, startedAt, outcome);
}

export async function parseDiffTextSourceInWorker(
  input: DiffParseWorkerTextSourceInput,
  timeoutMs = DEFAULT_DIFF_PARSE_WORKER_TIMEOUT_MS
): Promise<FileDiffMetadata | undefined> {
  const jobInput = {
    path: input.path,
    oldTextLength: input.source.oldTextLength,
    newTextLength: input.source.newTextLength,
  };
  const startedAt = getDiffPerfNow();
  const outcome = await workerClient.request<
    DiffParseWorkerTextSourceInput,
    DiffParseWorkerOutcome
  >({
    input,
    timeoutMs,
    defaultTimeoutMs: DEFAULT_DIFF_PARSE_WORKER_TIMEOUT_MS,
    fallbackResult: { type: 'unavailable' },
    timeoutFallbackResult: { type: 'timeout' },
    postMessageFallbackResult: (error) => ({
      type: 'error',
      error:
        error instanceof Error
          ? error
          : new Error(
              `Diff parse worker text source postMessage failed: ${formatUnknownError(error)}`
            ),
    }),
    restartFallbackResult: (reason) => ({
      type: 'error',
      error: new Error(`Diff parse worker restarted: ${reason}`),
    }),
    timeoutRestartReason: 'timeout',
    postMessageRestartReason: 'post-message',
    postMessage: ({ worker, id, request }) =>
      postDiffParseTextSourceRequestInChunks(worker, id, request),
  });
  return finishDiffParseOutcome(jobInput, startedAt, outcome);
}

const workerClient = createWebWorkerRequestClient<DiffParseWorkerResponse>({
  createWorker: () => new DiffParseWorker(),
  handleMessage: ({ message, client }) => {
    if ('result' in message) {
      client.finish(message.id, {
        type: 'success',
        result: message.result,
        workerDurationMs: message.durationMs,
      } satisfies DiffParseWorkerOutcome);
      return;
    }
    client.finish(message.id, {
      type: 'error',
      error: new Error(message.error),
    } satisfies DiffParseWorkerOutcome);
  },
  handleWorkerError: ({ event, client }) => {
    logDiffPerf('diff:parse-worker-crash', {
      message: event.message,
    });
    client.restart('error');
  },
  onRestart: (reason) => {
    logDiffPerf('diff:parse-worker-restart', { reason });
  },
});

function finishDiffParseOutcome(
  input: DiffParseJobInput,
  startedAt: number,
  outcome: DiffParseWorkerOutcome
): FileDiffMetadata | undefined {
  if (outcome.type === 'unavailable') {
    return undefined;
  }
  if (outcome.type === 'timeout') {
    throw new Error('Large diff parsing timed out in the worker.');
  }
  if (outcome.type === 'error') {
    throw outcome.error;
  }
  if (outcome.type === 'success') {
    logDiffPerfDurationLazy(
      'diff:parse-worker',
      startedAt,
      () => ({
        path: input.path,
        oldTextLength: input.oldTextLength,
        newTextLength: input.newTextLength,
        oldChunkCount: countTextChunksByLength(input.oldTextLength),
        newChunkCount: countTextChunksByLength(input.newTextLength),
        workerDurationMs: Math.round(outcome.workerDurationMs * 10) / 10,
        hunkCount: outcome.result.hunks.length,
      }),
      0
    );
    return outcome.result;
  }
  return undefined;
}

async function postDiffParseRequestInChunks(
  targetWorker: Worker,
  id: number,
  input: DiffParseWorkerInput
): Promise<void> {
  postMessageForPendingJob(targetWorker, id, {
    type: 'start',
    id,
    path: input.path,
    oldTextLength: input.oldText.length,
    newTextLength: input.newText.length,
    ...(input.lang === undefined ? {} : { lang: input.lang }),
    ...(input.oldCacheKey === undefined ? {} : { oldCacheKey: input.oldCacheKey }),
    ...(input.newCacheKey === undefined ? {} : { newCacheKey: input.newCacheKey }),
  });
  await postTextChunks(targetWorker, id, 'old', input.oldText);
  await postTextChunks(targetWorker, id, 'new', input.newText);
  postMessageForPendingJob(targetWorker, id, { type: 'finish', id });
}

async function postDiffParseTextSourceRequestInChunks(
  targetWorker: Worker,
  id: number,
  input: DiffParseWorkerTextSourceInput
): Promise<void> {
  postMessageForPendingJob(targetWorker, id, {
    type: 'start',
    id,
    path: input.path,
    oldTextLength: input.source.oldTextLength,
    newTextLength: input.source.newTextLength,
    ...(input.lang === undefined ? {} : { lang: input.lang }),
    ...(input.oldCacheKey === undefined ? {} : { oldCacheKey: input.oldCacheKey }),
    ...(input.newCacheKey === undefined ? {} : { newCacheKey: input.newCacheKey }),
  });
  await postTextSourceChunks(targetWorker, id, 'old', input.source);
  await postTextSourceChunks(targetWorker, id, 'new', input.source);
  postMessageForPendingJob(targetWorker, id, { type: 'finish', id });
}

async function postTextChunks(
  targetWorker: Worker,
  id: number,
  side: 'old' | 'new',
  text: string
): Promise<void> {
  if (text.length === 0) {
    return;
  }
  for (let offset = 0; offset < text.length; offset += DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH) {
    postMessageForPendingJob(targetWorker, id, {
      type: 'chunk',
      id,
      side,
      text: text.slice(offset, offset + DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH),
    });
    if (offset + DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH < text.length) {
      await yieldToMainThread();
    }
  }
}

async function postTextSourceChunks(
  targetWorker: Worker,
  id: number,
  side: DiffTextChunkSide,
  source: DiffTextChunkSource
): Promise<void> {
  const textLength = side === 'old' ? source.oldTextLength : source.newTextLength;
  if (textLength === 0) {
    return;
  }
  for (let offset = 0; offset < textLength; offset += DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH) {
    const endOffset = Math.min(offset + DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH, textLength);
    const text = await source.readChunk({ side, startOffset: offset, endOffset });
    if (text.length !== endOffset - offset) {
      throw new Error(
        `Diff text source returned an invalid ${side} chunk length: expected ${
          endOffset - offset
        }, received ${text.length}.`
      );
    }
    postMessageForPendingJob(targetWorker, id, {
      type: 'chunk',
      id,
      side,
      text,
    });
    if (endOffset < textLength) {
      await yieldToMainThread();
    }
  }
}

function postMessageForPendingJob(
  targetWorker: Worker,
  id: number,
  message: DiffParseWorkerRequest
): void {
  if (!workerClient.hasPending(id)) {
    return;
  }
  targetWorker.postMessage(message);
}

function countTextChunksByLength(textLength: number): number {
  return textLength === 0 ? 0 : Math.ceil(textLength / DIFF_PARSE_WORKER_TEXT_CHUNK_LENGTH);
}

async function yieldToMainThread(): Promise<void> {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function __resetDiffParseWorkerForTests(): void {
  workerClient.resetForTests();
}
