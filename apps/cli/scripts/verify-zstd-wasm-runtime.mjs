#!/usr/bin/env node
/**
 * Run the published streams-crdt zstd entry from a directory that mimics the
 * production CLI chunk layout. The entry's `import.meta.url` is the staged
 * file, so `./zstd.wasm` resolves beside that file and nowhere else.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ZSTD_INITIALIZATION_TIMEOUT_MS = 10000;

const scriptPath = fileURLToPath(import.meta.url);

export async function verifyRelocatedZstdRuntime(sourceEntry) {
  if (typeof global.gc !== 'function') {
    const result = spawnSync(process.execPath, ['--expose-gc', scriptPath, sourceEntry], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        result.stderr || result.stdout || `zstd runtime check exited ${result.status}`
      );
    }
    return;
  }
  await runChecks(sourceEntry);
}

async function stageRuntime(sourceEntry) {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-zstd-runtime-'));
  const chunks = path.join(root, 'chunks');
  await mkdir(chunks);
  const queue = [sourceEntry];
  const seen = new Set();
  while (queue.length > 0) {
    const filePath = queue.pop();
    if (filePath == null || seen.has(filePath)) continue;
    seen.add(filePath);
    const source = await readFile(filePath, 'utf8');
    await copyFile(filePath, path.join(chunks, path.basename(filePath)));
    for (const match of source.matchAll(/from\s+["'](\.\/[^"']+\.js)["']/g)) {
      const specifier = match[1];
      if (specifier == null) continue;
      queue.push(path.join(path.dirname(filePath), specifier));
    }
  }
  return {
    root,
    entryPath: path.join(chunks, path.basename(sourceEntry)),
    wasmPath: path.join(chunks, 'zstd.wasm'),
  };
}

async function importStaged(entryPath, token) {
  return import(`${pathToFileURL(entryPath).href}?case=${token}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(task, label) {
  let rejected = false;
  try {
    await task;
  } catch {
    rejected = true;
  }
  assert(rejected, `${label} resolved instead of rejecting`);
}

function errorText(error) {
  if (error instanceof Error) {
    const cause = error.cause;
    const causeText = cause instanceof Error ? cause.message : '';
    return causeText.length > 0 ? `${error.message} (${causeText})` : error.message;
  }
  return String(error);
}

async function until(predicate, label) {
  for (let turn = 0; turn < 200; turn += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error(`condition was not reached: ${label}`);
}

function track(promise) {
  const state = {
    settled: false,
    status: 'pending',
    value: undefined,
    reason: undefined,
  };
  promise.then(
    (value) => {
      state.settled = true;
      state.status = 'fulfilled';
      state.value = value;
    },
    (reason) => {
      state.settled = true;
      state.status = 'rejected';
      state.reason = reason;
    }
  );
  return state;
}

function installRuntimeControls() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realInstantiate = WebAssembly.instantiate;
  const timers = [];
  const gates = [];
  let instantiateCalls = 0;

  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === ZSTD_INITIALIZATION_TIMEOUT_MS) {
      const timer = { callback, args, delay, cleared: false };
      timers.push(timer);
      return timer;
    }
    return realSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (timer) => {
    if (timer != null && typeof timer === 'object' && timer.delay === ZSTD_INITIALIZATION_TIMEOUT_MS) {
      timer.cleared = true;
      return;
    }
    return realClearTimeout(timer);
  };
  WebAssembly.instantiate = async (...args) => {
    instantiateCalls += 1;
    const result = await realInstantiate(...args);
    return new Promise((resolve, reject) => {
      gates.push({
        release: () => resolve(result),
        fail: (error) => reject(error),
      });
    });
  };

  return {
    timers,
    gates,
    instantiateCount: () => instantiateCalls,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      WebAssembly.instantiate = realInstantiate;
    },
  };
}

async function withWasmRuntime(sourceEntry, token, check) {
  const staged = await stageRuntime(sourceEntry);
  const controls = installRuntimeControls();
  try {
    await copyFile(path.join(path.dirname(sourceEntry), 'zstd.wasm'), staged.wasmPath);
    const runtime = await importStaged(staged.entryPath, token);
    await check(runtime, controls);
  } finally {
    controls.restore();
    await rm(staged.root, { recursive: true, force: true });
  }
}

async function roundTrip(runtime, payload, label) {
  const compressed = await runtime.compress(payload);
  const restored = await runtime.decompress(compressed);
  assert(Buffer.from(restored).equals(Buffer.from(payload)), label);
  return compressed;
}

async function checkLateSuccessReusesStartedRuntime(sourceEntry) {
  await withWasmRuntime(sourceEntry, 'late-success', async (runtime, controls) => {
    const payload = new TextEncoder().encode('timeout recovery');
    let document = { payload };
    const retained = new WeakRef(document);
    const pending = runtime.compress(document.payload);
    const release = (async (held) => {
      await pending;
      return held;
    })(document);
    document = null;
    await until(
      () => controls.gates.length === 1 && controls.timers.length === 1,
      'first instantiate and its timeout'
    );
    const firstTimer = controls.timers[0];
    firstTimer.callback();
    let rejection = null;
    try {
      await release;
    } catch (error) {
      rejection = error;
    }
    assert(rejection != null, 'timed-out compression resolved');
    assert(
      errorText(rejection).includes('timed out'),
      `timed-out compression rejected with ${errorText(rejection)}`
    );
    global.gc();
    assert(retained.deref() === undefined, 'timed-out compression kept the caller document');

    const joined = track(runtime.compress(payload));
    await until(
      () => joined.settled || controls.timers.length >= 2 || controls.instantiateCount() >= 2,
      'later compress joining the timed-out initialization'
    );
    assert(
      controls.instantiateCount() === 1,
      `timed-out initialization started ${controls.instantiateCount()} instantiates`
    );
    assert(!joined.settled, `later compress settled while the original instantiate was still held (${joined.status})`);
    firstTimer.callback();
    await nextTurn();
    await nextTurn();
    assert(
      !joined.settled,
      `replaying the first timeout settled a later compress (${joined.status}: ${errorText(joined.reason)})`
    );

    controls.gates[0].release();
    await until(() => joined.settled, 'later compress after the original instantiate succeeded');
    assert(
      joined.status === 'fulfilled',
      `late instantiate success left compress ${joined.status}: ${errorText(joined.reason)}`
    );
    const restored = await runtime.decompress(joined.value);
    assert(
      Buffer.from(restored).equals(Buffer.from(payload)),
      'late instantiate success did not round-trip'
    );

    await roundTrip(runtime, payload, 'compress after the runtime had already started did not round-trip');
    assert(
      controls.instantiateCount() === 1,
      `an already-started runtime was instantiated again (${controls.instantiateCount()})`
    );
    let firstStillRejected = false;
    try {
      await pending;
    } catch (error) {
      firstStillRejected = errorText(error).includes('timed out');
    }
    assert(firstStillRejected, 'late success changed the timed-out compression');
  });
}

async function checkStaleAttemptDoesNotSettleReplacement(sourceEntry) {
  await withWasmRuntime(sourceEntry, 'stale-attempt', async (runtime, controls) => {
    const payload = new TextEncoder().encode('replacement attempt');
    const first = track(runtime.compress(payload));
    await until(
      () => controls.gates.length === 1 && controls.timers.length === 1,
      'first attempt'
    );
    const staleTimer = controls.timers[0];
    controls.gates[0].fail(new Error('instantiate failed on purpose'));
    await until(() => first.settled, 'failed instantiate rejection');
    assert(first.status === 'rejected', 'a failed instantiate resolved compress');
    assert(controls.instantiateCount() === 1, 'the failed attempt instantiated more than once');

    const replacement = track(runtime.compress(payload));
    await until(
      () => controls.gates.length === 2 && controls.timers.length >= 2,
      'replacement instantiate'
    );
    staleTimer.callback();
    await nextTurn();
    await nextTurn();
    assert(
      !replacement.settled,
      `a stale timeout from the failed attempt settled the replacement (${replacement.status}: ${errorText(replacement.reason)})`
    );

    controls.gates[1].release();
    await until(() => replacement.settled, 'replacement compress');
    assert(
      replacement.status === 'fulfilled',
      `replacement compress rejected: ${errorText(replacement.reason)}`
    );
    const restored = await runtime.decompress(replacement.value);
    assert(
      Buffer.from(restored).equals(Buffer.from(payload)),
      'replacement runtime did not round-trip'
    );
    staleTimer.callback();
    await nextTurn();
    await roundTrip(runtime, payload, 'stale timeout broke the ready runtime');
    assert(controls.instantiateCount() === 2, 'replacement did not keep its own instantiate');
  });
}

async function checkLateFailureStillAllowsReplacement(sourceEntry) {
  await withWasmRuntime(sourceEntry, 'late-failure', async (runtime, controls) => {
    const payload = new TextEncoder().encode('late failure');
    const first = track(runtime.compress(payload));
    await until(
      () => controls.gates.length === 1 && controls.timers.length === 1,
      'instantiate held before a late failure'
    );
    controls.timers[0].callback();
    await until(() => first.settled, 'timeout before the late failure');
    assert(first.status === 'rejected', 'timed-out compress resolved before the instantiate failed');
    controls.gates[0].fail(new Error('late instantiate failure'));
    await nextTurn();
    await nextTurn();

    const replacement = track(runtime.compress(payload));
    await until(() => controls.gates.length === 2 && controls.timers.length >= 2, 'replacement after a late failure');
    controls.timers[0].callback();
    await nextTurn();
    await nextTurn();
    assert(
      !replacement.settled,
      `the timed-out attempt settled the replacement after a late failure (${replacement.status}: ${errorText(replacement.reason)})`
    );
    controls.gates[1].release();
    await until(() => replacement.settled, 'replacement compress after a late failure');
    assert(
      replacement.status === 'fulfilled',
      `replacement after a late failure rejected: ${errorText(replacement.reason)}`
    );
    const restored = await runtime.decompress(replacement.value);
    assert(
      Buffer.from(restored).equals(Buffer.from(payload)),
      'replacement after a late failure did not round-trip'
    );
  });
}

async function checkOverlappingInstantiationSharesRuntime(sourceEntry) {
  await withWasmRuntime(sourceEntry, 'overlap', async (runtime, controls) => {
    const firstPayload = new TextEncoder().encode('alpha payload');
    const secondPayload = new TextEncoder().encode('beta payload !!');
    const first = track(runtime.compress(firstPayload));
    const second = track(runtime.compress(secondPayload));
    await until(
      () => controls.gates.length === 1 && (first.settled || second.settled || controls.instantiateCount() >= 1),
      'overlapping compress'
    );
    await nextTurn();
    await nextTurn();
    assert(
      controls.instantiateCount() === 1,
      `overlapping compress started ${controls.instantiateCount()} instantiates`
    );
    assert(!first.settled && !second.settled, 'overlapping compress settled before instantiate finished');
    controls.gates[0].release();
    await until(() => first.settled && second.settled, 'overlapping compress after instantiate');
    assert(first.status === 'fulfilled', `first overlapping compress rejected: ${errorText(first.reason)}`);
    assert(second.status === 'fulfilled', `second overlapping compress rejected: ${errorText(second.reason)}`);
    assert(
      Buffer.from(await runtime.decompress(first.value)).equals(Buffer.from(firstPayload)),
      'overlapping instantiation changed the first payload'
    );
    assert(
      Buffer.from(await runtime.decompress(second.value)).equals(Buffer.from(secondPayload)),
      'overlapping instantiation changed the second payload'
    );
    await roundTrip(runtime, firstPayload, 'compress after a shared instantiate did not round-trip');
    assert(
      controls.instantiateCount() === 1,
      `a shared runtime was instantiated again (${controls.instantiateCount()})`
    );
  });
}

async function runChecks(sourceEntry) {
  const unhandled = [];
  const onUnhandled = (error) => {
    unhandled.push(String(error));
  };
  process.on('unhandledRejection', onUnhandled);
  const sourceWasm = path.join(path.dirname(sourceEntry), 'zstd.wasm');
  const payload = new TextEncoder().encode('local diagnostic test');
  let failure = null;

  try {
    const missing = await stageRuntime(sourceEntry);
    try {
      const runtime = await importStaged(missing.entryPath, 'missing');
      let document = { payload };
      const retained = new WeakRef(document);
      const pending = runtime.compress(document.payload);
      const release = (async (held) => {
        await pending;
        return held;
      })(document);
      document = null;
      await expectRejection(release, 'compression without zstd.wasm');
      global.gc();
      assert(retained.deref() === undefined, 'rejected compression kept the caller document');

      await copyFile(sourceWasm, missing.wasmPath);
      const compressed = await runtime.compress(payload);
      const restored = await runtime.decompress(compressed);
      assert(
        Buffer.from(restored).equals(Buffer.from(payload)),
        'compression after the wasm file appeared did not round-trip'
      );
    } finally {
      await rm(missing.root, { recursive: true, force: true });
    }

    const corrupt = await stageRuntime(sourceEntry);
    try {
      await writeFile(corrupt.wasmPath, Buffer.from('not wasm'));
      const runtime = await importStaged(corrupt.entryPath, 'corrupt');
      await expectRejection(runtime.compress(payload), 'corrupt zstd.wasm');
      await expectRejection(runtime.compress(payload), 'retry after corrupt zstd.wasm');
    } finally {
      await rm(corrupt.root, { recursive: true, force: true });
    }

    const lifecycle = [
      ['late success reuses the started runtime', checkLateSuccessReusesStartedRuntime],
      ['stale attempt cannot settle its replacement', checkStaleAttemptDoesNotSettleReplacement],
      ['late failure still allows a replacement', checkLateFailureStillAllowsReplacement],
      ['overlapping compress shares one instantiate', checkOverlappingInstantiationSharesRuntime],
    ];
    const failures = [];
    for (const [name, check] of lifecycle) {
      try {
        await check(sourceEntry);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(failures.join('\n\n'));
    }
  } catch (error) {
    failure = error;
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  if (unhandled.length > 0) {
    throw new Error(`unhandled zstd rejections: ${unhandled.join(' | ')}`, { cause: failure ?? undefined });
  }
  if (failure != null) throw failure;
}

const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === scriptPath;
if (invokedDirectly) {
  const entry = process.argv[2];
  if (entry == null || entry.length === 0) {
    console.error('usage: verify-zstd-wasm-runtime.mjs <zstd-entry>');
    process.exitCode = 1;
  } else {
    verifyRelocatedZstdRuntime(entry).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
