import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Resolve the exact transitive glob used by the CLI's rimraf, not a separate copy.
const cliRequire = createRequire(new URL('../apps/cli/package.json', import.meta.url));
const rimrafRequire = createRequire(cliRequire.resolve('rimraf'));
const globDir = dirname(rimrafRequire.resolve('glob/package.json'));
const { GlobUtil: CommonJsGlobUtil } = rimrafRequire(join(globDir, 'dist/commonjs/walker.js'));
const { GlobUtil: EsmGlobUtil } = await import(pathToFileURL(join(globDir, 'dist/esm/walker.js')));
const { glob, globSync } = rimrafRequire('glob');
const { rimraf } = cliRequire('rimraf');

for (const [format, GlobUtil] of [
  ['commonjs', CommonJsGlobUtil],
  ['esm', EsmGlobUtil],
]) {
  for (const method of ['walkCB', 'walkCB2', 'walkCBSync', 'walkCB2Sync']) {
    test(`${format} ${method} stops after abort`, () => {
      const controller = new AbortController();
      const walker = new GlobUtil([], {}, { signal: controller.signal });
      controller.abort();
      let callbacks = 0;
      let processed = 0;
      const processor = {
        processPatterns() {
          processed++;
        },
        matches: new Map(),
        subwalks: new Map(),
      };
      const cb = () => callbacks++;
      if (method.includes('CB2')) walker[method]({}, [], processor, cb);
      else walker[method]({}, [], cb);
      assert.equal(callbacks, 1, 'must finish once');
      assert.equal(processed, 0, 'must not process after abort');
    });
  }

  test(`${format} runs an immediately runnable resume callback after abort`, () => {
    const controller = new AbortController();
    const walker = new GlobUtil([], {}, { signal: controller.signal });
    controller.abort();
    let resumed = false;
    walker.onResume(() => {
      resumed = true;
    });
    assert.equal(resumed, true);
  });
}

test('glob and rimraf retain normal matching and deletion behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-glob-abort-'));
  try {
    await mkdir(join(root, 'nested'));
    await Promise.all(
      ['a.txt', 'b.js', 'nested/c.txt'].map((file) => writeFile(join(root, file), file))
    );
    assert.deepEqual((await glob('**/*.txt', { cwd: root })).sort(), ['a.txt', 'nested/c.txt']);
    assert.deepEqual(globSync('**/*.txt', { cwd: root }).sort(), ['a.txt', 'nested/c.txt']);
    assert.equal(await rimraf(join(root, 'nested')), true);
    assert.deepEqual(await glob('**/*.txt', { cwd: root }), ['a.txt']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Hold the first real directory read at its callback boundary. The assertion
// runs only after that callback has returned, not after a timing delay.
test('public glob stops traversal after abort during a directory read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-glob-cancel-'));
  try {
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'item.txt'), 'test');
    const controller = new AbortController();
    const reason = new Error('synthetic abort');
    let callsAfterAbort = 0;
    let releaseRead;
    const readFinished = new Promise((resolve) => {
      releaseRead = resolve;
    });
    const customFs = {
      ...fs,
      readdir(path, options, callback) {
        if (controller.signal.aborted) callsAfterAbort++;
        return fs.readdir(path, options, (...args) => {
          if (!controller.signal.aborted) {
            controller.abort(reason);
            callback(...args);
            releaseRead();
          } else {
            callback(...args);
          }
        });
      },
    };
    await assert.rejects(
      glob('**', { cwd: root, signal: controller.signal, fs: customFs }),
      (error) => error === reason
    );
    await readFinished;
    assert.equal(callsAfterAbort, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
