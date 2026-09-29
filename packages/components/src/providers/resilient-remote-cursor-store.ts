import {
  IndexedDbRemoteCursorStore,
  InMemoryRemoteCursorStore,
  type IndexedDbRemoteCursorStoreOptions,
  type JsonObject,
  type RemoteCursor,
  type RemoteCursorStore,
} from '@loro-dev/streams-crdt';
import { getLoroStreamsRemoteCursorUrlAliases } from '@lody/shared';

export const DEFAULT_REMOTE_CURSOR_STORE_TIMEOUT_MS = 2_000;

type RemoteCursorStoreOperation = 'load' | 'save' | 'delete';

type RemoteCursorStoreWarningContext = {
  operation: RemoteCursorStoreOperation;
  dbName: string;
  timeoutMs: number;
  error: unknown;
};

type RemoteCursorStoreEvent = {
  operation: RemoteCursorStoreOperation;
  phase: 'primary-start' | 'primary-success' | 'primary-failure' | 'fallback-success';
  dbName: string;
  streamUrl: string;
  timeoutMs: number;
  elapsedMs?: number;
  error?: unknown;
};

export type ResilientRemoteCursorStoreOptions<TVersion extends JsonObject = JsonObject> = {
  dbName: string;
  timeoutMs?: number;
  indexedDb?: IDBFactory;
  onWarning?: (message: string, context: RemoteCursorStoreWarningContext) => void;
  onEvent?: (message: string, event: RemoteCursorStoreEvent) => void;
  createPrimaryStore?: (options: IndexedDbRemoteCursorStoreOptions) => RemoteCursorStore<TVersion>;
  createFallbackStore?: () => RemoteCursorStore<TVersion>;
};

class RemoteCursorStoreTimeoutError extends Error {
  constructor(operation: RemoteCursorStoreOperation, dbName: string, timeoutMs: number) {
    super(
      `Timed out while accessing Loro Streams remote cursor cache (${operation}, ${dbName}, ${timeoutMs}ms)`
    );
    this.name = 'RemoteCursorStoreTimeoutError';
  }
}

const withTimeout = async <TResult>(
  promise: Promise<TResult>,
  timeoutMs: number,
  createTimeoutError: () => Error
): Promise<TResult> => {
  if (timeoutMs <= 0) {
    return await promise;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TResult>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(createTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export class ResilientRemoteCursorStore<
  TVersion extends JsonObject = JsonObject,
> implements RemoteCursorStore<TVersion> {
  private readonly primary: RemoteCursorStore<TVersion>;
  private readonly fallback: RemoteCursorStore<TVersion>;
  private readonly dbName: string;
  private readonly timeoutMs: number;
  private readonly onWarning:
    | ((message: string, context: RemoteCursorStoreWarningContext) => void)
    | undefined;
  private readonly onEvent: ((message: string, event: RemoteCursorStoreEvent) => void) | undefined;
  private degraded = false;

  constructor(options: ResilientRemoteCursorStoreOptions<TVersion>) {
    this.dbName = options.dbName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_CURSOR_STORE_TIMEOUT_MS;
    this.onWarning = options.onWarning;
    this.onEvent = options.onEvent;
    this.primary =
      options.createPrimaryStore?.({
        dbName: options.dbName,
        indexedDb: options.indexedDb,
      }) ??
      new IndexedDbRemoteCursorStore<TVersion>({
        dbName: options.dbName,
        indexedDb: options.indexedDb,
      });
    this.fallback = options.createFallbackStore?.() ?? new InMemoryRemoteCursorStore<TVersion>();
  }

  async load(streamUrl: string): Promise<RemoteCursor<TVersion> | null> {
    if (this.degraded) {
      return await this.loadFromStore(this.fallback, streamUrl);
    }
    return await this.runPrimaryOperation(
      'load',
      streamUrl,
      () => this.loadFromStore(this.primary, streamUrl),
      () => this.loadFromStore(this.fallback, streamUrl)
    );
  }

  async save(cursor: RemoteCursor<TVersion>): Promise<void> {
    if (this.degraded) {
      await this.fallback.save(cursor);
      return;
    }

    await this.runPrimaryOperation(
      'save',
      cursor.streamUrl,
      () => this.primary.save(cursor),
      () => this.fallback.save(cursor)
    );
  }

  async delete(streamUrl: string): Promise<void> {
    if (this.degraded) {
      await this.deleteFromStoreWithAliases(this.fallback, streamUrl);
      return;
    }

    await this.runPrimaryOperation(
      'delete',
      streamUrl,
      () => this.deleteFromStoreWithAliases(this.primary, streamUrl),
      () => this.deleteFromStoreWithAliases(this.fallback, streamUrl)
    );
  }

  private async loadFromStore(
    store: RemoteCursorStore<TVersion>,
    streamUrl: string
  ): Promise<RemoteCursor<TVersion> | null> {
    const cursor = await store.load(streamUrl);
    if (cursor) {
      return cursor;
    }

    for (const alias of getLoroStreamsRemoteCursorUrlAliases(streamUrl)) {
      const aliasCursor = await store.load(alias);
      if (aliasCursor) {
        return { ...aliasCursor, streamUrl };
      }
    }

    return null;
  }

  private async deleteFromStoreWithAliases(
    store: RemoteCursorStore<TVersion>,
    streamUrl: string
  ): Promise<void> {
    await Promise.all(
      [streamUrl, ...getLoroStreamsRemoteCursorUrlAliases(streamUrl)].map(async (url) => {
        await store.delete?.(url);
      })
    );
  }

  private async runPrimaryOperation<TResult>(
    operation: RemoteCursorStoreOperation,
    streamUrl: string,
    primaryOperation: () => Promise<TResult>,
    fallbackOperation: () => Promise<TResult>
  ): Promise<TResult> {
    const startedAt = Date.now();
    this.emitEvent('Loro Streams remote cursor cache primary operation started', {
      operation,
      phase: 'primary-start',
      dbName: this.dbName,
      streamUrl,
      timeoutMs: this.timeoutMs,
    });
    try {
      const result = await withTimeout(
        Promise.resolve().then(primaryOperation),
        this.timeoutMs,
        () => new RemoteCursorStoreTimeoutError(operation, this.dbName, this.timeoutMs)
      );
      this.emitEvent('Loro Streams remote cursor cache primary operation succeeded', {
        operation,
        phase: 'primary-success',
        dbName: this.dbName,
        streamUrl,
        timeoutMs: this.timeoutMs,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.degrade(operation, error);
      this.emitEvent('Loro Streams remote cursor cache primary operation failed', {
        operation,
        phase: 'primary-failure',
        dbName: this.dbName,
        streamUrl,
        timeoutMs: this.timeoutMs,
        elapsedMs: Date.now() - startedAt,
        error,
      });
      const result = await fallbackOperation();
      this.emitEvent('Loro Streams remote cursor cache fallback operation succeeded', {
        operation,
        phase: 'fallback-success',
        dbName: this.dbName,
        streamUrl,
        timeoutMs: this.timeoutMs,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    }
  }

  private degrade(operation: RemoteCursorStoreOperation, error: unknown): void {
    if (this.degraded) {
      return;
    }

    this.degraded = true;
    this.onWarning?.('Loro Streams remote cursor cache degraded; using memory fallback', {
      operation,
      dbName: this.dbName,
      timeoutMs: this.timeoutMs,
      error,
    });
  }

  private emitEvent(message: string, event: RemoteCursorStoreEvent): void {
    this.onEvent?.(message, event);
  }
}

export const createResilientRemoteCursorStore = <TVersion extends JsonObject = JsonObject>(
  options: ResilientRemoteCursorStoreOptions<TVersion>
): ResilientRemoteCursorStore<TVersion> => new ResilientRemoteCursorStore<TVersion>(options);
