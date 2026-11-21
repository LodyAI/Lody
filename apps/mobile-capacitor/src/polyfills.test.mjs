import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const polyfillSource = ts.transpileModule(
  readFileSync(new URL('./polyfills.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

function install({ native = false, finalizationRegistry = FinalizationRegistry } = {}) {
  class RealmAbortSignal extends AbortSignal {}
  if (!native)
    Object.defineProperty(RealmAbortSignal, 'any', { value: undefined, configurable: true });
  const context = vm.createContext({
    AbortController,
    AbortSignal: RealmAbortSignal,
    fetch,
    Request,
    Response,
    ReadableStream,
    FinalizationRegistry: finalizationRegistry,
    WeakRef,
  });
  if (!native) {
    vm.runInContext(
      `
      Promise.withResolvers = undefined;
      for (const name of ['toSorted', 'toReversed', 'toSpliced', 'with']) {
        delete Array.prototype[name];
      }
    `,
      context
    );
  }
  const original = vm.runInContext(
    '({ promise: Promise.withResolvers, any: AbortSignal.any, sorted: Array.prototype.toSorted, fetch })',
    context
  );
  vm.runInContext(polyfillSource, context);
  return {
    context,
    original,
    any: RealmAbortSignal.any,
    Promise: vm.runInContext('Promise', context),
    evaluate: (code) => vm.runInContext(code, context),
  };
}

function trackedController() {
  const controller = new AbortController();
  const listeners = new Set();
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.add(listener);
    return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.delete(listener);
    return remove(type, listener, options);
  };
  return { controller, signal, listeners };
}

void test('native implementations are preserved', () => {
  const installed = install({ native: true });
  assert.equal(installed.Promise.withResolvers, installed.original.promise);
  assert.equal(installed.any, installed.original.any);
  assert.equal(installed.context.fetch, installed.original.fetch);
  assert.equal(installed.evaluate('Array.prototype.toSorted'), installed.original.sorted);
});

void test('withResolvers resolves thenables, rejects, and returns a real promise', async () => {
  const { Promise: RealmPromise } = install();
  const resolved = RealmPromise.withResolvers();
  assert.ok(resolved.promise instanceof RealmPromise);
  resolved.resolve({ then: (resolve) => resolve(42) });
  assert.equal(await resolved.promise, 42);
  const rejected = RealmPromise.withResolvers();
  const reason = Error('cancelled');
  rejected.reject(reason);
  await assert.rejects(rejected.promise, (error) => error === reason);
});

void test('withResolvers uses its receiver constructor, including Promise subclasses', async () => {
  const installed = install();
  const subclass = installed.evaluate('class SubPromise extends Promise {}; SubPromise');
  const result = subclass.withResolvers();
  assert.ok(result.promise instanceof subclass);
  result.resolve('done');
  assert.equal(await result.promise, 'done');

  class Capability {
    constructor(executor) {
      executor(
        (value) => {
          this.value = value;
        },
        (reason) => {
          this.reason = reason;
        }
      );
    }
  }
  const custom = installed.Promise.withResolvers.call(Capability);
  assert.ok(custom.promise instanceof Capability);
  custom.resolve('custom');
  assert.equal(custom.promise.value, 'custom');
  custom.reject('failure');
  assert.equal(custom.promise.reason, 'failure');
});

void test('withResolvers rejects invalid constructors and capabilities', () => {
  const { Promise: RealmPromise } = install();
  for (const constructor of [
    () => {},
    class {},
    class {
      constructor(executor) {
        executor(null, null);
      }
    },
  ]) {
    assert.throws(() => RealmPromise.withResolvers.call(constructor), { name: 'TypeError' });
  }
  class RepeatedExecutor {
    constructor(executor) {
      executor(
        () => {},
        () => {}
      );
      executor(
        () => {},
        () => {}
      );
    }
  }
  assert.throws(() => RealmPromise.withResolvers.call(RepeatedExecutor), { name: 'TypeError' });
});

void test('any accepts iterable signals and propagates the first abort reason once', () => {
  const { any } = install();
  const first = trackedController();
  const second = trackedController();
  const combined = any(new Set([first.signal, second.signal]));
  let aborts = 0;
  combined.addEventListener('abort', () => aborts++);
  const reason = { cause: 'workspace closed' };
  second.controller.abort(reason);
  first.controller.abort('late');
  assert.equal(combined.aborted, true);
  assert.equal(combined.reason, reason);
  assert.equal(aborts, 1);
  assert.equal(first.listeners.size, 0);
  assert.equal(second.listeners.size, 0);
});

void test('any validates every input before selecting the first already-aborted signal', () => {
  const { any } = install();
  const first = trackedController();
  const second = trackedController();
  first.controller.abort('first');
  second.controller.abort('second');
  assert.equal(any([first.signal, second.signal]).reason, 'first');
  assert.equal(any([second.signal, first.signal]).reason, 'second');
  for (const invalid of [null, undefined, {}, { aborted: false }]) {
    assert.throws(() => any([first.signal, invalid]), { name: 'TypeError' });
  }
  assert.equal(first.listeners.size, 0);
  assert.equal(second.listeners.size, 0);
  assert.throws(() => any({ 0: first.signal, length: 1 }), { name: 'TypeError' });
});

void test('any consumes the full iterable before checking aborted state', () => {
  const { any } = install();
  const controller = new AbortController();
  controller.abort();
  const failure = Error('iteration failed');
  function* signals() {
    yield controller.signal;
    throw failure;
  }
  assert.throws(
    () => any(signals()),
    (error) => error === failure
  );
});

void test('any ignores forged abort events and overridden aborted properties', () => {
  const { any } = install();
  const source = trackedController();
  Object.defineProperty(source.signal, 'aborted', { value: true });
  const combined = any([source.signal]);
  source.signal.dispatchEvent(new Event('abort'));
  assert.equal(combined.aborted, false);
  assert.equal(source.listeners.size, 1);
  source.controller.abort('real abort');
  assert.equal(combined.reason, 'real abort');
  assert.equal(source.listeners.size, 0);
});

void test('any deduplicates listeners and supports empty and nested composites', () => {
  const { any } = install();
  const source = trackedController();
  const combined = any([source.signal, source.signal]);
  assert.equal(source.listeners.size, 1);
  const nested = any([combined]);
  source.controller.abort('nested abort');
  assert.equal(nested.reason, 'nested abort');
  assert.equal(source.listeners.size, 0);
  const empty = any([]);
  assert.equal(empty.aborted, false);
  assert.equal(empty.reason, undefined);
});

void test('any handles a source aborted while its listener is being attached', () => {
  const { any } = install();
  const source = trackedController();
  const other = trackedController();
  const add = source.signal.addEventListener;
  source.signal.addEventListener = (...args) => {
    source.controller.abort('during attach');
    add(...args);
  };
  const combined = any([source.signal, other.signal]);
  assert.equal(combined.reason, 'during attach');
  assert.equal(source.listeners.size, 0);
  assert.equal(other.listeners.size, 0);
});

void test('collection cleanup removes dormant source listeners without waiting for abort', () => {
  let runFinalizer;
  const registrations = new Map();
  class ControlledFinalizationRegistry {
    constructor(callback) {
      runFinalizer = callback;
    }
    register(_target, heldValue, token) {
      registrations.set(token, heldValue);
    }
    unregister(token) {
      return registrations.delete(token);
    }
  }
  const { any } = install({ finalizationRegistry: ControlledFinalizationRegistry });
  const source = trackedController();
  any([source.signal]);
  assert.equal(source.listeners.size, 1);
  assert.equal(registrations.size, 1);
  // Deliver the GC cleanup callback explicitly: no timing/GC heuristics.
  runFinalizer([...registrations.values()][0]);
  assert.equal(source.listeners.size, 0);
});

void test('normal cancellation unregisters collection cleanup', () => {
  const registrations = new Map();
  class ControlledFinalizationRegistry {
    register(_target, heldValue, token) {
      registrations.set(token, heldValue);
    }
    unregister(token) {
      return registrations.delete(token);
    }
  }
  const { any } = install({ finalizationRegistry: ControlledFinalizationRegistry });
  const source = trackedController();
  const combined = any([source.signal]);
  source.controller.abort();
  assert.equal(combined.reason.name, 'AbortError');
  assert.equal(registrations.size, 0);
});

void test('array copying fallbacks distinguish omitted and explicit undefined arguments', () => {
  const { evaluate } = install();
  assert.deepEqual(Array.from(evaluate('[1, 2, 3].toSpliced()')), [1, 2, 3]);
  assert.deepEqual(Array.from(evaluate('[1, 2, 3].toSpliced(1)')), [1]);
  assert.deepEqual(Array.from(evaluate('[1, 2, 3].toSpliced(1, undefined, 4)')), [1, 4, 2, 3]);
  assert.deepEqual(Array.from(evaluate('[1, 2, 3].with(1.8, 4)')), [1, 4, 3]);
  assert.deepEqual(Array.from(evaluate('[1, 2, 3].with(-1.8, 4)')), [1, 2, 4]);
  assert.deepEqual(Array.from(evaluate('[1, 2, 3].with(NaN, 4)')), [4, 2, 3]);
  assert.throws(() => evaluate('[1, 2, 3].with(Infinity, 4)'), { name: 'RangeError' });
  assert.throws(() => evaluate('[1, 2, 3].with(1n, 4)'), { name: 'TypeError' });
  assert.deepEqual(
    Array.from(evaluate('const a = [3, 1, 2]; a.toSorted(); a.toReversed(); a')),
    [3, 1, 2]
  );
  assert.deepEqual(Array.from(evaluate('Object.keys(Array.prototype)')), []);
});
