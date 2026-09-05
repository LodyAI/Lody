import assert from 'node:assert/strict';
import test from 'node:test';

import { selectTraceFrames } from './render-failure-videos.mjs';

void test('orders trace screenshots by timestamp and ignores unrelated resources', () => {
  assert.deepEqual(
    selectTraceFrames([
      'source.txt',
      'page@id-30.jpeg',
      'page@id-10.jpeg',
      'page@id-20.jpeg',
      'snapshot.png',
    ]),
    ['page@id-10.jpeg', 'page@id-20.jpeg', 'page@id-30.jpeg']
  );
});

void test('samples long traces evenly while retaining both endpoints', () => {
  const names = Array.from({ length: 10 }, (_unused, index) => `page@id-${index}.jpeg`);
  assert.deepEqual(selectTraceFrames(names, 4), [
    'page@id-0.jpeg',
    'page@id-3.jpeg',
    'page@id-6.jpeg',
    'page@id-9.jpeg',
  ]);
});
