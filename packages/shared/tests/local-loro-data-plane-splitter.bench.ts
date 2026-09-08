import { strict as assert } from 'node:assert';
import { bench, describe } from 'vitest';
import { createJsonLineSplitter } from '../src/local-loro-data-plane';

// Run: pnpm --filter @lody/shared exec vitest bench --run local-loro-data-plane-splitter
const largeLine = JSON.stringify({ payload: 'x'.repeat(1_100_000) });
const shortLine = JSON.stringify({ type: 'ping', sequence: 1 });
const encoder = new TextEncoder();
const cases = [
  ...[64, 4096, 65536].map((chunkSize) => ({
    name: `1.1 MB line / ${chunkSize} byte chunks`,
    line: largeLine,
    count: 1,
    chunkSize,
  })),
  { name: '10000 short frames / 64 KiB batches', line: shortLine, count: 10_000, chunkSize: 65536 },
];

describe('JSON line splitter', () => {
  for (const { name, line, count, chunkSize } of cases) {
    const bytes = encoder.encode(`${line}\n`.repeat(count));
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(bytes.subarray(offset, offset + chunkSize));
    }

    const lines: string[] = [];
    const verify = createJsonLineSplitter({ onLine: (value) => lines.push(value) });
    for (const chunk of chunks) verify(chunk);
    assert.equal(lines.length, count);
    for (const value of lines) assert.equal(value, line);

    let consumed = 0;
    bench(
      name,
      () => {
        const split = createJsonLineSplitter({ onLine: (value) => (consumed += value.length) });
        for (const chunk of chunks) split(chunk);
      },
      {
        time: 200,
        iterations: 3,
        warmupTime: 100,
        warmupIterations: 1,
        teardown: () => assert.ok(consumed > 0),
      }
    );
  }
});
