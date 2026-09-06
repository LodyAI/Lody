import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { startWorkspaceWatchWorker } from './workspace-watch-worker-core';
import type {
  WorkspaceWatchChildMessage,
  WorkspaceWatchParentMessage,
} from './workspace-watch-protocol';

class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

describe('workspace watch worker core', () => {
  it('deduplicates roots, filters ignored paths, and treats missing filenames as dirty', () => {
    const messages: WorkspaceWatchChildMessage[] = [];
    const listeners: Array<(message: unknown) => void> = [];
    const callbacks = new Map<string, (event: string, filename: string | Buffer | null) => void>();
    let watchCalls = 0;
    const worker = startWorkspaceWatchWorker({
      send: (message) => messages.push(message),
      onMessage: (handler) => listeners.push(handler),
      onDisconnect: () => undefined,
      exit: () => undefined,
      readDirectory: () => [],
      watchFactory: (root, _options, callback) => {
        watchCalls += 1;
        callbacks.set(root, callback);
        return new FakeWatcher() as unknown as FSWatcher;
      },
    });
    const replace: WorkspaceWatchParentMessage = {
      type: 'code-collab-watch/replace-roots',
      generation: 1,
      revision: 1,
      roots: ['/workspace', '/workspace'],
    };
    listeners[0]?.(replace);

    expect(watchCalls).toBe(1);
    expect(messages.at(-1)).toMatchObject({
      type: 'code-collab-watch/ready',
      watchedRoots: ['/workspace'],
    });

    callbacks.get('/workspace')?.('change', 'node_modules/pkg/index.js');
    expect(messages.filter((message) => message.type === 'code-collab-watch/dirty')).toHaveLength(
      0
    );
    callbacks.get('/workspace')?.('change', null);
    expect(messages.at(-1)).toMatchObject({ type: 'code-collab-watch/dirty', root: '/workspace' });
    worker.close();
  });

  it('reports a root error once and does not retry it locally', () => {
    const messages: WorkspaceWatchChildMessage[] = [];
    const listeners: Array<(message: unknown) => void> = [];
    const watcher = new FakeWatcher();
    let watchCalls = 0;
    const worker = startWorkspaceWatchWorker({
      send: (message) => messages.push(message),
      onMessage: (handler) => listeners.push(handler),
      onDisconnect: () => undefined,
      exit: vi.fn(),
      readDirectory: () => [],
      watchFactory: () => {
        watchCalls += 1;
        return watcher as unknown as FSWatcher;
      },
    });
    listeners[0]?.({
      type: 'code-collab-watch/replace-roots',
      generation: 2,
      revision: 1,
      roots: ['/workspace'],
    });
    watcher.emit('error', Object.assign(new Error('too many files'), { code: 'EMFILE' }));

    expect(messages.at(-1)).toEqual({
      type: 'code-collab-watch/error',
      generation: 2,
      root: '/workspace',
      code: 'EMFILE',
    });
    expect(watchCalls).toBe(1);
    worker.close();
  });

  it('watches the root shallowly and every non-ignored top-level directory recursively', () => {
    const messages: WorkspaceWatchChildMessage[] = [];
    const listeners: Array<(message: unknown) => void> = [];
    const watched: Array<{ directory: string; recursive: boolean }> = [];
    const worker = startWorkspaceWatchWorker({
      send: (message) => messages.push(message),
      onMessage: (handler) => listeners.push(handler),
      onDisconnect: () => undefined,
      exit: () => undefined,
      readDirectory: () => [
        { name: 'apps', isDirectory: true },
        { name: 'packages', isDirectory: true },
        { name: 'node_modules', isDirectory: true },
        { name: '.git', isDirectory: true },
        { name: 'dist', isDirectory: true },
        { name: 'package.json', isDirectory: false },
      ],
      watchFactory: (directory, options) => {
        watched.push({ directory, recursive: options.recursive === true });
        return new FakeWatcher() as unknown as FSWatcher;
      },
    });
    listeners[0]?.({
      type: 'code-collab-watch/replace-roots',
      generation: 1,
      revision: 1,
      roots: ['/workspace'],
    });

    expect(watched).toEqual([
      { directory: '/workspace', recursive: false },
      { directory: path.join('/workspace', 'apps'), recursive: true },
      { directory: path.join('/workspace', 'packages'), recursive: true },
    ]);
    // The whole point: no inotify tree over these.
    expect(watched.map((entry) => entry.directory)).not.toContain(
      path.join('/workspace', 'node_modules')
    );
    expect(watched.map((entry) => entry.directory)).not.toContain(path.join('/workspace', '.git'));
    worker.close();
  });

  it('re-plans when a top-level directory appears, and not for nested changes', async () => {
    const messages: WorkspaceWatchChildMessage[] = [];
    const listeners: Array<(message: unknown) => void> = [];
    const rootCallbacks: Array<(event: string, filename: string | Buffer | null) => void> = [];
    let entries = [{ name: 'apps', isDirectory: true }];
    const watched: string[] = [];
    const worker = startWorkspaceWatchWorker({
      send: (message) => messages.push(message),
      onMessage: (handler) => listeners.push(handler),
      onDisconnect: () => undefined,
      exit: () => undefined,
      readDirectory: () => entries,
      watchFactory: (directory, options, callback) => {
        watched.push(directory);
        if (options.recursive !== true) {
          rootCallbacks.push(callback);
        }
        return new FakeWatcher() as unknown as FSWatcher;
      },
    });
    listeners[0]?.({
      type: 'code-collab-watch/replace-roots',
      generation: 1,
      revision: 1,
      roots: ['/workspace'],
    });
    expect(watched).toEqual(['/workspace', path.join('/workspace', 'apps')]);

    // A nested path cannot change the top-level set, so no re-plan.
    rootCallbacks[0]?.('change', 'apps/web/src/main.ts');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watched).toEqual(['/workspace', path.join('/workspace', 'apps')]);

    // A new top-level directory must get its own recursive watch.
    entries = [
      { name: 'apps', isDirectory: true },
      { name: 'services', isDirectory: true },
    ];
    rootCallbacks[0]?.('rename', 'services');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(watched).toEqual([
      '/workspace',
      path.join('/workspace', 'apps'),
      '/workspace',
      path.join('/workspace', 'apps'),
      path.join('/workspace', 'services'),
    ]);
    worker.close();
  });

  it('survives a top-level directory disappearing between readdir and watch', () => {
    const messages: WorkspaceWatchChildMessage[] = [];
    const listeners: Array<(message: unknown) => void> = [];
    const worker = startWorkspaceWatchWorker({
      send: (message) => messages.push(message),
      onMessage: (handler) => listeners.push(handler),
      onDisconnect: () => undefined,
      exit: () => undefined,
      readDirectory: () => [
        { name: 'apps', isDirectory: true },
        { name: 'vanished', isDirectory: true },
      ],
      watchFactory: (directory) => {
        if (directory.endsWith('vanished')) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        return new FakeWatcher() as unknown as FSWatcher;
      },
    });
    listeners[0]?.({
      type: 'code-collab-watch/replace-roots',
      generation: 1,
      revision: 1,
      roots: ['/workspace'],
    });

    // The root stays watched; only the vanished child is skipped.
    expect(messages.at(-1)).toMatchObject({
      type: 'code-collab-watch/ready',
      watchedRoots: ['/workspace'],
    });
    expect(messages.some((message) => message.type === 'code-collab-watch/error')).toBe(false);
    worker.close();
  });
});
