// Opt-in performance experiment, not a timing-dependent correctness test.
import { it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import {
  startNativePreviewHost,
  createNativePreviewComments,
  nativePreviewRoom,
} from '../src/node/native-repo';
import type { FlockOp } from '@loro-dev/loro-repo-client';
import type { SessionId } from '../src/index';
import { comment } from './fixtures/native-preview-comment';

it.skipIf(process.env.LODY_NATIVE_BENCH !== '1')(
  'measures fixed-size comment operations at 10k and 100k rows',
  async () => {
    const results = [];
    const quantiles = (samples: number[]) => {
      const sorted = samples.toSorted((a, b) => a - b);
      return Object.fromEntries(
        [50, 95, 99].map((p) => [
          `p${p}`,
          Number(sorted[Math.ceil((p / 100) * sorted.length) - 1].toFixed(3)),
        ])
      );
    };
    for (const count of [10_000, 100_000]) {
      const dir = await mkdtemp(join(tmpdir(), 'native-preview-bench-'));
      const host = await startNativePreviewHost(dir);
      try {
        const domain = createNativePreviewComments(host.client, 'benchmark');
        await domain.ensure();
        for (let offset = 0; offset < count; offset += 256) {
          const ops: FlockOp[] = Array.from(
            { length: Math.min(256, count - offset) },
            (_, index) => {
              const id = String(offset + index);
              return {
                op: 'put',
                key: [
                  'comment',
                  offset + index < 32 ? 'selected' : `other-${Math.floor((offset + index) / 32)}`,
                  id,
                ],
                value: { ...comment(id) },
              };
            }
          );
          await host.client.flockBatch('benchmark', nativePreviewRoom, ops);
        }
        let delivery: (() => void) | undefined;
        let deliveredAt = 0;
        let changedRows = 0;
        let snapshotRows = 0;
        const snapshotStart = performance.now();
        const observation = domain.observe('selected', (event) => {
          if (event.kind === 'snapshot') snapshotRows = event.entries.length;
          if (event.kind === 'changes') {
            changedRows = event.entries.length;
            deliveredAt = performance.now();
            delivery?.();
          }
        });
        await observation.ready;
        const snapshotMs = performance.now() - snapshotStart;
        const read: number[] = [],
          write: number[] = [],
          update: number[] = [];
        for (let i = 0; i < 120; i++) {
          const readStart = performance.now();
          await domain.read('selected', ['0']);
          const readMs = performance.now() - readStart;
          const observed = new Promise<void>((resolve) => {
            delivery = resolve;
          });
          const writeStart = performance.now();
          await domain.mutate('selected' as SessionId, {
            kind: 'resolve',
            commentId: '0',
            resolvedBy: 'local:test',
            resolvedAt: i + 2,
          });
          const writeMs = performance.now() - writeStart;
          await observed;
          if (changedRows !== 1) throw new Error('benchmark must deliver only the changed row');
          if (i >= 20) {
            read.push(readMs);
            write.push(writeMs);
            update.push(deliveredAt - writeStart);
          }
        }
        await observation.release();
        results.push({
          rows: count,
          selectedRows: snapshotRows,
          samples: read.length,
          warmup: 20,
          snapshotMs: Number(snapshotMs.toFixed(3)),
          readMs: quantiles(read),
          writeMs: quantiles(write),
          updateMs: quantiles(update),
          changedRows,
        });
      } finally {
        await host.close();
        await rm(dir, { recursive: true, force: true });
      }
    }
    const output = {
      sdk: '795bafcb6fd112fdaa0971a92db1c89133f2bcd5',
      platform: `${os.platform()}-${os.arch()}`,
      cpu: os.cpus()[0].model,
      node: process.version,
      results,
    };
    console.log(JSON.stringify(output, null, 2));
    if (process.env.LODY_NATIVE_BENCH_OUTPUT)
      await writeFile(process.env.LODY_NATIVE_BENCH_OUTPUT, JSON.stringify(output, null, 2) + '\n');
  },
  300_000
);
