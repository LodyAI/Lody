import { compactParsedFileDiff } from './code-collab-diff-metadata-bounds';
import { parseDiffFromFile, type FileDiffMetadata, type SupportedLanguages } from '@pierre/diffs';

type DiffParseWorkerRequest = {
  readonly id: number;
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly lang?: SupportedLanguages;
  readonly oldCacheKey?: string;
  readonly newCacheKey?: string;
};

type ChunkedDiffParseWorkerRequest =
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

const ctx = self as unknown as {
  onmessage:
    | ((event: MessageEvent<DiffParseWorkerRequest | ChunkedDiffParseWorkerRequest>) => void)
    | null;
  postMessage: (message: DiffParseWorkerResponse) => void;
};

type PendingDiffParseJob = {
  readonly id: number;
  readonly path: string;
  readonly oldTextLength: number;
  readonly newTextLength: number;
  readonly lang?: SupportedLanguages;
  readonly oldCacheKey?: string;
  readonly newCacheKey?: string;
  readonly oldChunks: string[];
  readonly newChunks: string[];
};

const pendingJobs = new Map<number, PendingDiffParseJob>();

ctx.onmessage = (event: MessageEvent<DiffParseWorkerRequest | ChunkedDiffParseWorkerRequest>) => {
  const message = event.data;
  if ('type' in message) {
    handleChunkedMessage(message);
    return;
  }
  parseAndPostResult(message);
};

function handleChunkedMessage(message: ChunkedDiffParseWorkerRequest): void {
  if (message.type === 'start') {
    pendingJobs.set(message.id, {
      id: message.id,
      path: message.path,
      oldTextLength: message.oldTextLength,
      newTextLength: message.newTextLength,
      ...(message.lang === undefined ? {} : { lang: message.lang }),
      ...(message.oldCacheKey === undefined ? {} : { oldCacheKey: message.oldCacheKey }),
      ...(message.newCacheKey === undefined ? {} : { newCacheKey: message.newCacheKey }),
      oldChunks: [],
      newChunks: [],
    });
    return;
  }

  const job = pendingJobs.get(message.id);
  if (job === undefined) {
    postError(message.id, 'Diff parse worker received a chunk for an unknown job.');
    return;
  }

  if (message.type === 'chunk') {
    if (message.side === 'old') {
      job.oldChunks.push(message.text);
    } else {
      job.newChunks.push(message.text);
    }
    return;
  }

  pendingJobs.delete(message.id);
  const oldText = job.oldChunks.join('');
  const newText = job.newChunks.join('');
  if (oldText.length !== job.oldTextLength || newText.length !== job.newTextLength) {
    postError(
      job.id,
      `Diff parse worker received incomplete text chunks: old=${oldText.length}/${job.oldTextLength}, new=${newText.length}/${job.newTextLength}.`
    );
    return;
  }
  parseAndPostResult({
    id: job.id,
    path: job.path,
    oldText,
    newText,
    ...(job.lang === undefined ? {} : { lang: job.lang }),
    ...(job.oldCacheKey === undefined ? {} : { oldCacheKey: job.oldCacheKey }),
    ...(job.newCacheKey === undefined ? {} : { newCacheKey: job.newCacheKey }),
  });
}

function parseAndPostResult(message: DiffParseWorkerRequest): void {
  const startedAt =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  try {
    const result = parseDiffFromFile(
      {
        name: message.path,
        contents: message.oldText,
        lang: message.lang,
        cacheKey: message.oldCacheKey,
      },
      {
        name: message.path,
        contents: message.newText,
        lang: message.lang,
        cacheKey: message.newCacheKey,
      }
    );
    const endedAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    ctx.postMessage({
      id: message.id,
      result: compactParsedFileDiff(result),
      durationMs: endedAt - startedAt,
    });
  } catch (error) {
    postError(message.id, error instanceof Error ? error.message : String(error));
  }
}

function postError(id: number, error: string): void {
  ctx.postMessage({ id, error });
}
