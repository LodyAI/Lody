import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react';
import { WorkerPoolManager } from '@pierre/diffs/worker';
import PierreDiffsRenderWorker from '@pierre/diffs/worker/worker.js?worker';

// Isolated so the render worker (a Vite `?worker` import) is the ONLY thing a
// non-Vite bundle needs to stub out. When this factory returns `undefined`,
// `<FileDiff>` renders on the main thread via the shared highlighter.
const DIFF_RENDER_WORKER_POOL_OPTIONS: WorkerPoolOptions = {
  workerFactory: () => new PierreDiffsRenderWorker(),
  poolSize: 1,
  totalASTLRUCacheSize: 64,
};

type DiffRenderWorkerPoolEntry = {
  pool: WorkerPoolManager;
  appliedOptionsKey: string;
  desiredOptions: WorkerInitializationRenderOptions;
  desiredOptionsKey: string;
  updatePromise: Promise<void> | null;
};

const diffRenderWorkerPools = new Map<string, DiffRenderWorkerPoolEntry>();
const diffRenderWorkerPoolEntries = new WeakMap<WorkerPoolManager, DiffRenderWorkerPoolEntry>();

function getRenderProfileKey(options: WorkerInitializationRenderOptions): string {
  return `${options.lineDiffType ?? 'word-alt'}:${options.tokenizeMaxLineLength ?? 1_000}`;
}

function getRenderOptionsKey(options: WorkerInitializationRenderOptions): string {
  const theme = typeof options.theme === 'string' ? options.theme : JSON.stringify(options.theme);
  return `${getRenderProfileKey(options)}:${theme ?? ''}`;
}

export function createDiffRenderWorkerPool(
  renderOptions: WorkerInitializationRenderOptions
): WorkerPoolManager | undefined {
  if (typeof window === 'undefined') return undefined;

  const profileKey = getRenderProfileKey(renderOptions);
  const existing = diffRenderWorkerPools.get(profileKey);
  if (existing) {
    return existing.pool;
  }

  // @pierre/diffs configures line-diff behavior pool-wide. Keep one shared pool per
  // render profile so many mounted diffs cannot spawn one worker each, while word-level
  // and line-only renders cannot overwrite each other's options.
  const pool = new WorkerPoolManager(DIFF_RENDER_WORKER_POOL_OPTIONS, renderOptions);
  const optionsKey = getRenderOptionsKey(renderOptions);
  const entry: DiffRenderWorkerPoolEntry = {
    pool,
    appliedOptionsKey: optionsKey,
    desiredOptions: renderOptions,
    desiredOptionsKey: optionsKey,
    updatePromise: null,
  };
  diffRenderWorkerPools.set(profileKey, entry);
  diffRenderWorkerPoolEntries.set(pool, entry);
  return pool;
}

export function configureDiffRenderWorkerPool(
  pool: WorkerPoolManager,
  renderOptions: WorkerInitializationRenderOptions
): Promise<void> {
  const entry = diffRenderWorkerPoolEntries.get(pool);
  if (!entry) {
    return pool.setRenderOptions(renderOptions);
  }

  entry.desiredOptions = renderOptions;
  entry.desiredOptionsKey = getRenderOptionsKey(renderOptions);
  if (entry.appliedOptionsKey === entry.desiredOptionsKey) {
    return Promise.resolve();
  }
  if (entry.updatePromise) {
    return entry.updatePromise;
  }

  entry.updatePromise = (async () => {
    while (entry.appliedOptionsKey !== entry.desiredOptionsKey) {
      const nextOptions = entry.desiredOptions;
      const nextOptionsKey = entry.desiredOptionsKey;
      await pool.setRenderOptions(nextOptions);
      entry.appliedOptionsKey = nextOptionsKey;
    }
  })().finally(() => {
    entry.updatePromise = null;
  });
  return entry.updatePromise;
}

export function terminateDiffRenderWorkerPools(): void {
  for (const { pool } of diffRenderWorkerPools.values()) {
    pool.terminate();
    diffRenderWorkerPoolEntries.delete(pool);
  }
  diffRenderWorkerPools.clear();
}

if (import.meta.hot) {
  import.meta.hot.dispose(terminateDiffRenderWorkerPools);
}
