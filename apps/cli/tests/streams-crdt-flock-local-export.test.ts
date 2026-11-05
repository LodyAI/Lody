/**
 * Guards the Lody patch to `@loro-dev/streams-crdt` `createFlockAdapter`
 * (`patches/@loro-dev__streams-crdt@*.patch`): a burst of local Flock commits
 * schedules one coalesced export instead of one Wasm `exportJson` per commit,
 * the export yields a macrotask first so timers/IPC are not starved, and no
 * local write is lost across in-flight exports, failures or unsubscription.
 */
import { Flock } from '@loro-dev/flock-wasm';
import { createFlockAdapter } from '@loro-dev/streams-crdt/flock';
import { describe, expect, it } from 'vitest';

type Delivery = { readonly keys: string[] };

function decodeKeys(update: Uint8Array): string[] {
  const bundle = JSON.parse(new TextDecoder().decode(update)) as {
    entries: Record<string, unknown>;
  };
  return Object.keys(bundle.entries).map((key) => (JSON.parse(key) as string[])[0] ?? '');
}

function subscribe(flock: Flock) {
  const adapter = createFlockAdapter(flock);
  const deliveries: Delivery[] = [];
  const unsubscribe = adapter.subscribeLocalUpdates((batch) => {
    deliveries.push({ keys: batch.updates.flatMap(decodeKeys).sort() });
  });
  return { adapter, deliveries, unsubscribe };
}

function instrumentExports(flock: Flock, options: { failFirst?: boolean } = {}) {
  const stats = { exports: 0 };
  let failNext = options.failFirst === true;
  const instrumented = new Proxy(flock, {
    get(target, property, receiver) {
      if (property === 'exportJson') {
        return (...args: Parameters<Flock['exportJson']>) => {
          stats.exports += 1;
          if (failNext) {
            failNext = false;
            throw new Error('synthetic export failure');
          }
          return target.exportJson(...args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { instrumented, stats };
}

function writePaths(flock: Flock, paths: readonly string[]): void {
  for (const path of paths) {
    flock.set([path], true);
    flock.commit();
  }
}

describe('patched streams-crdt Flock local export queue', () => {
  it('coalesces a burst of commits into one export and lets queued timers run first', async () => {
    const flock = new Flock();
    const { instrumented, stats } = instrumentExports(flock);
    const { adapter, deliveries } = subscribe(instrumented);
    const order: string[] = [];
    const paths = Array.from({ length: 500 }, (_, index) => `src/file-${index}.ts`);

    writePaths(flock, paths);
    setTimeout(() => order.push(`timer:${deliveries.length}`), 0);
    await adapter.flushLocalExports?.();
    order.push(`flushed:${deliveries.length}`);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.keys).toEqual([...paths].sort());
    expect(order).toEqual(['timer:0', 'flushed:1']);
    // The regression ran one full Wasm export per commit after the first covered all.
    expect(stats.exports).toBe(1);
  });

  it('exports writes made while an export is pending in a later batch', async () => {
    const flock = new Flock();
    const { adapter, deliveries } = subscribe(flock);

    writePaths(flock, ['a.ts']);
    const firstFlush = adapter.flushLocalExports?.();
    // Still pending: coalesced into the same export.
    writePaths(flock, ['b.ts']);
    await firstFlush;
    expect(deliveries.map((delivery) => delivery.keys)).toEqual([['a.ts', 'b.ts']]);

    writePaths(flock, ['c.ts']);
    await adapter.flushLocalExports?.();
    expect(deliveries.map((delivery) => delivery.keys)).toEqual([['a.ts', 'b.ts'], ['c.ts']]);
  });

  it('retries the unexported range after an export failure', async () => {
    const flock = new Flock();
    const { instrumented } = instrumentExports(flock, { failFirst: true });
    const { adapter, deliveries } = subscribe(instrumented);

    writePaths(flock, ['lost-if-buggy.ts']);
    await adapter.flushLocalExports?.();
    expect(deliveries).toEqual([]);

    writePaths(flock, ['next.ts']);
    await adapter.flushLocalExports?.();
    expect(deliveries.map((delivery) => delivery.keys)).toEqual([['lost-if-buggy.ts', 'next.ts']]);
  });

  it('stops delivering after unsubscribe without advancing past unexported writes', async () => {
    const flock = new Flock();
    const adapter = createFlockAdapter(flock);
    const stale: Delivery[] = [];
    const unsubscribe = adapter.subscribeLocalUpdates((batch) => {
      stale.push({ keys: batch.updates.flatMap(decodeKeys) });
    });

    writePaths(flock, ['before-unsubscribe.ts']);
    unsubscribe();
    await adapter.flushLocalExports?.();
    expect(stale).toEqual([]);

    const fresh: Delivery[] = [];
    adapter.subscribeLocalUpdates((batch) => {
      fresh.push({ keys: batch.updates.flatMap(decodeKeys).sort() });
    });
    writePaths(flock, ['after-resubscribe.ts']);
    await adapter.flushLocalExports?.();
    expect(fresh.map((delivery) => delivery.keys)).toEqual([
      ['after-resubscribe.ts', 'before-unsubscribe.ts'],
    ]);
  });
});
