import * as baseline from '../../tests/fixtures/file-search/baseline';
import {
  buildMentionFileIndex,
  getSuggestions,
} from '../../src/components/mentions/file-search/engine';
import { createFileSearchClient } from '../../src/components/mentions/file-search/client';
import { makeFilePaths, fileSearchQueries } from '../../tests/fixtures/file-search/paths';

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function measure<T>(operation: () => T | Promise<T>) {
  await frame();
  const start = performance.now();
  let last = start;
  let maxFrameGapMs = 0;
  let frames = 0;
  let raf = 0;
  const tick = () => {
    const now = performance.now();
    maxFrameGapMs = Math.max(maxFrameGapMs, now - last);
    last = now;
    frames++;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const value = await operation();
  const durationMs = performance.now() - start;
  await frame();
  cancelAnimationFrame(raf);
  return { value, durationMs, maxFrameGapMs, frames };
}

export async function runBenchmark(repeats = 3) {
  const rows: object[] = [];
  for (const count of [1000, 10000, 80000]) {
    const entry = { paths: makeFilePaths(count) };
    const oldBuild = await measure(() => baseline.buildPathSuggestions(entry.paths));
    rows.push({ count, phase: 'index', mode: 'baseline', ...oldBuild, value: undefined });
    const optimized = buildMentionFileIndex(entry)!;
    let waiting: ((items: ReturnType<typeof getSuggestions>) => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    let client: ReturnType<typeof createFileSearchClient>;
    const cold = await measure(
      () =>
        new Promise<ReturnType<typeof getSuggestions>>((resolve, fail) => {
          waiting = resolve;
          reject = fail;
          client = createFileSearchClient(
            new Worker(
              new URL(
                '../../src/components/mentions/file-search/search.worker.ts',
                import.meta.url
              ),
              { type: 'module' }
            ),
            entry,
            (_term, items) => {
              waiting?.(items);
              waiting = undefined;
            },
            () => reject?.(new Error('Worker failed'))
          );
          client.query('');
        })
    );
    rows.push({ count, phase: 'index+empty-query', mode: 'worker', ...cold, value: undefined });
    try {
      for (const query of fileSearchQueries) {
        for (let iteration = 0; iteration < repeats; iteration++) {
          const old = await measure(() => baseline.getSuggestions(oldBuild.value, query));
          const sync = await measure(() => getSuggestions(optimized, query));
          const worker = await measure(
            () =>
              new Promise<ReturnType<typeof getSuggestions>>((resolve, fail) => {
                waiting = resolve;
                reject = fail;
                client.query(query);
              })
          );
          if (
            JSON.stringify(old.value) !== JSON.stringify(sync.value) ||
            JSON.stringify(old.value) !== JSON.stringify(worker.value)
          )
            throw new Error(`Ranking mismatch: ${count}/${query}`);
          for (const [mode, result] of [
            ['baseline', old],
            ['optimized-sync', sync],
            ['worker', worker],
          ] as const) {
            rows.push({
              count,
              query,
              iteration,
              mode,
              durationMs: result.durationMs,
              maxFrameGapMs: result.maxFrameGapMs,
              frames: result.frames,
              results: result.value.length,
            });
          }
        }
      }
    } finally {
      client!.dispose();
    }
  }
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    repeats,
    rows,
  };
}

/** Real worker protocol check, driven by messages rather than sleeps or timings. */
export async function verifyWorkerCancellation() {
  const worker = new Worker(
    new URL('../../src/components/mentions/file-search/search.worker.ts', import.meta.url),
    { type: 'module' }
  );
  const entry = { paths: makeFilePaths(2000) };
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onerror = () => reject(new Error('Worker startup failed'));
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          worker.postMessage({ type: 'query', id: 1, term: 'src/components' });
          worker.postMessage({ type: 'cancel' });
        } else if (data.type === 'cancelled') {
          worker.postMessage({ type: 'query', id: 2, term: 'README' });
        } else if (data.type === 'result' && data.id === 2) {
          const expected = baseline.getSuggestions(
            baseline.buildPathSuggestions(entry.paths),
            'README'
          );
          if (JSON.stringify(data.items) !== JSON.stringify(expected))
            reject(new Error('Post-cancellation ranking mismatch'));
          else resolve();
        } else reject(new Error(`Unexpected worker response: ${data.type}`));
      };
      worker.postMessage({ type: 'index', entry });
    });
  } finally {
    worker.terminate();
  }
}
