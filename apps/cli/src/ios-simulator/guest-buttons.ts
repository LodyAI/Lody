import type { ChildProcessByStdio } from 'node:child_process';
import { Effect } from 'effect';
import { startProcess, terminateChildTree } from '@lody/shared/node/process';
import type { Readable, Writable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guestButtonsSource } from './guest-buttons-source';

type Button = 'home' | 'app-switcher' | 'lock';
/** One guest service per worker/device. Never replays a command after failure. */
export function createGuestButtons(signal: AbortSignal, executable = '/usr/bin/xcrun') {
  let directory: string | undefined;
  let device: string | undefined;
  let child: ChildProcessByStdio<Writable, Readable, null> | undefined;
  let childClosed: Promise<void> | undefined;
  let preparing: Promise<void> | undefined;
  let pending: { line: string; resolve(): void; reject(error: Error): void } | undefined;
  let sequence = 0;
  let failed = false;
  let stopping: Promise<void> | undefined;
  const error = () => new Error('Simulator buttons unavailable.');
  const fail = () => {
    failed = true;
    pending?.reject(error());
    pending = undefined;
  };
  let terminating: Promise<void> | undefined;
  function terminate(): Promise<void> {
    if (terminating) return terminating;
    const owned = child;
    if (!owned) return Promise.resolve();
    const closed = childClosed;
    terminating = (async () => {
      owned.stdin.end();
      // EOF gives the guest one second to release a key and cancel its service.
      if (closed)
        await Effect.runPromise(Effect.raceAll([Effect.promise(() => closed), Effect.sleep(1000)]));
      await terminateChildTree(owned, { processGroup: true, graceMs: 1000, killWaitMs: 2000 });
      await closed;
      if (child === owned) child = undefined;
    })();
    return terminating;
  }
  function launch(args: string[], protocol: boolean): Promise<void> {
    signal.throwIfAborted();
    if (failed) throw error();
    const { child: started } = startProcess({
      command: executable,
      args,
      processGroup: true,
      options: { stdio: ['pipe', 'pipe', 'ignore'] },
    });
    const process = started as ChildProcessByStdio<Writable, Readable, null>;
    child = process;
    terminating = undefined;
    childClosed = new Promise<void>((resolve) => process.once('close', resolve));
    process.stdin.on('error', fail);
    return new Promise<void>((resolve, reject) => {
      let ready = false;
      let buffer = '';
      process.once('error', () => {
        fail();
        reject(error());
      });
      process.once('close', (code) => {
        if (!protocol && code === 0 && !signal.aborted) resolve();
        else {
          fail();
          reject(error());
        }
      });
      if (protocol) {
        pending = {
          line: 'ready',
          resolve: () => {
            ready = true;
            resolve();
          },
          reject,
        };
        process.stdout.setEncoding('utf8');
        process.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 1024) {
            fail();
            void terminate();
            return;
          }
          while (buffer.includes('\n')) {
            const at = buffer.indexOf('\n');
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            const request = pending;
            if (!request || line !== request.line || (line === 'ready' && ready)) {
              fail();
              void terminate();
              return;
            }
            pending = undefined;
            request.resolve();
          }
        });
      } else process.stdin.end();
    });
  }
  async function prepare(udid: string) {
    directory = await mkdtemp(join(tmpdir(), 'lody-simulator-buttons-'));
    signal.throwIfAborted();
    const source = join(directory, 'buttons.m');
    const binary = join(directory, 'buttons');
    await writeFile(source, guestButtonsSource, { mode: 0o600 });
    await launch(
      [
        '--sdk',
        'iphonesimulator',
        'clang',
        '-arch',
        'arm64',
        '-target',
        'arm64-apple-ios17.0-simulator',
        '-framework',
        'Foundation',
        '-fobjc-arc',
        '-Wl,-adhoc_codesign',
        source,
        '-o',
        binary,
      ],
      false
    );
    await launch(['simctl', 'spawn', udid, binary], true);
  }
  const close = (): Promise<void> => {
    stopping ??= (async () => {
      fail();
      await terminate();
      await preparing?.catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true });
      signal.removeEventListener('abort', onAbort);
    })();
    return stopping;
  };
  const onAbort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    close,
    async prepare(udid: string) {
      await this.press(udid);
    },
    async press(udid: string, button?: Button) {
      signal.throwIfAborted();
      if (failed || pending || (device && device !== udid)) throw error();
      device = udid;
      // Includes cold compilation/registration; warm presses have no subprocess startup.
      const timeout = setTimeout(() => {
        void close().catch(() => {});
      }, 10000);
      try {
        preparing ??= prepare(udid);
        await preparing;
        if (failed || signal.aborted || !child) throw error();
        if (!button) return;
        const id = ++sequence;
        await new Promise<void>((resolve, reject) => {
          pending = { line: `${id} ok`, resolve, reject };
          child?.stdin.write(`${id} ${button}\n`, (err) => {
            if (err) fail();
          });
        });
      } catch {
        await close();
        throw error();
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
