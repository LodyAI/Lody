import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runNativeChild } from './native-child';

function heldChild(signal?: AbortSignal) {
  let release!: () => void, ready!: () => void, child!: ChildProcess, closed!: Promise<void>;
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const result = runNativeChild(
    process.execPath,
    [
      '-e',
      `process.stdin.once('data', () => { process.stdout.write('settled'); process.stdin.destroy(); }); process.stdout.write('ready');`,
    ],
    {
      signal,
      onSpawn: (native) => {
        child = native;
        closed = new Promise<void>((resolve) => native.once('close', () => resolve()));
        let released = false;
        release = () => {
          if (!released) {
            released = true;
            native.stdin!.end('release');
          }
        };
        native.stdout!.once('data', ready);
      },
    }
  );
  return { result, reached, release: () => release(), child: () => child, closed: () => closed };
}

describe('owned native fixture process', () => {
  it('retains a deliberately held child until explicit release and actual close', async () => {
    const fixture = heldChild();
    let completed = false;
    void fixture.result.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      }
    );
    try {
      await fixture.reached;
      expect(completed).toBe(false);
      expect(fixture.child().exitCode).toBeNull();
      fixture.release();
      const result = await fixture.result;
      expect(result).toMatchObject({ status: 0, signal: null, stdout: 'readysettled' });
      expect(fixture.child().exitCode).toBe(0);
    } finally {
      fixture.release();
      await fixture.result;
      await fixture.closed();
    }
  });

  it('owner cancellation kills and awaits the actual held child, and is a harness failure', async () => {
    const controller = new AbortController();
    const fixture = heldChild(controller.signal);
    const checked = expect(fixture.result).rejects.toThrow('Native child harness failure');
    await fixture.reached;
    controller.abort();
    await checked;
    await fixture.closed();
    expect(fixture.child().signalCode).toBe('SIGKILL');
    expect(fixture.child().exitCode).toBeNull();
  });
});
