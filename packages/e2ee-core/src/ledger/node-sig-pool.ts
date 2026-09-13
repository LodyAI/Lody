import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { verifySignature } from './crypto';

export type SigJob = { pk: Uint8Array; msg: Uint8Array; sig: Uint8Array };

const workerPath = fileURLToPath(new URL('./node-sig-worker.ts', import.meta.url));
const PARALLEL_MIN = 32;

function sequential(jobs: readonly SigJob[]): boolean[] {
  return jobs.map((job) => verifySignature(job.pk, job.msg, job.sig));
}

function asResults(slice: readonly SigJob[], ok: unknown): boolean[] {
  if (!Array.isArray(ok) || ok.length !== slice.length) throw new Error('sig-worker-shape');
  const results: boolean[] = [];
  for (const value of ok) {
    if (typeof value !== 'boolean') throw new Error('sig-worker-shape');
    results.push(value);
  }
  return results;
}

function runSlice(slice: SigJob[]): Promise<boolean[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: slice,
      execArgv: process.execArgv,
    });
    const finish = (error: Error | null, ok?: boolean[]) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      if (error) reject(error);
      else resolve(ok!);
    };
    worker.once('message', (ok: unknown) => {
      try {
        finish(null, asResults(slice, ok));
      } catch (error) {
        finish(error instanceof Error ? error : new Error('sig-worker-shape'));
      }
    });
    worker.once('error', (error) => {
      finish(error);
    });
    worker.once('exit', (code) => {
      finish(new Error(code !== 0 ? `sig-worker-exit-${code}` : 'sig-worker-silent'));
    });
  });
}

export async function verifyJobsParallel(jobs: readonly SigJob[]): Promise<boolean[]> {
  if (jobs.length < PARALLEL_MIN) return sequential(jobs);
  const workers = Math.min(availableParallelism(), 8, jobs.length);
  if (workers <= 1) return sequential(jobs);
  const size = Math.ceil(jobs.length / workers);
  const slices: SigJob[][] = [];
  for (let i = 0; i < jobs.length; i += size) slices.push(jobs.slice(i, i + size));
  try {
    const parts = await Promise.all(slices.map((slice) => runSlice(slice)));
    return parts.flat();
  } catch {
    return sequential(jobs);
  }
}
