import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import type { FSWatcher } from 'node:fs';
import path from 'node:path';

import { buildWorkspaceWatchWorkerEnvironment } from './workspace-watch-coordinator';
import type { WorkspaceWatchChildMessage } from './workspace-watch-protocol';
import { parseWorkspaceWatchChildMessage } from './workspace-watch-protocol';
import { startWorkspaceWatchWorker } from './workspace-watch-worker-core';

describe('WorkspaceWatchCoordinator', () => {
  it('does not forward representative credentials or NODE_OPTIONS', () => {
    expect(
      buildWorkspaceWatchWorkerEnvironment({
        PATH: '/bin',
        LANG: 'en_US.UTF-8',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        GH_TOKEN: 'secret',
        LODY_SUPERVISOR_TOKEN: 'secret',
        OPENAI_API_KEY: 'secret',
      })
    ).toEqual({
      PATH: '/bin',
      LANG: 'en_US.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
});

describe('workspace watch child', () => {
  it('reports root-relative event paths so the parent can apply Git ignore rules', () => {
    const root = path.join(path.sep, 'workspace');
    const listeners = new Map<string, (eventType: string, filename: string | null) => void>();
    const sent: WorkspaceWatchChildMessage[] = [];
    let deliver: (message: unknown) => void = () => {};
    const worker = startWorkspaceWatchWorker({
      send: (message) => sent.push(message),
      onMessage: (handler) => {
        deliver = handler;
      },
      onDisconnect: () => {},
      exit: () => {},
      readDirectory: () => [
        { name: 'coverage', isDirectory: true },
        { name: 'node_modules', isDirectory: true },
      ],
      watchFactory: (directory, _options, listener) => {
        listeners.set(directory, listener);
        return Object.assign(new EventEmitter(), { close: () => {} }) as unknown as FSWatcher;
      },
    });
    try {
      deliver({
        type: 'code-collab-watch/replace-roots',
        generation: 1,
        revision: 1,
        roots: [root],
      });
      listeners.get(path.join(root, 'coverage'))?.('change', 'lcov-report/index.html');
      listeners.get(root)?.('change', null);

      const dirty = sent
        .map((message) => parseWorkspaceWatchChildMessage(message))
        .filter((message) => message?.type === 'code-collab-watch/dirty');
      expect(dirty).toEqual([
        {
          type: 'code-collab-watch/dirty',
          generation: 1,
          root,
          path: 'coverage/lcov-report/index.html',
        },
        // No filename: the parent must rescan rather than guess.
        { type: 'code-collab-watch/dirty', generation: 1, root },
      ]);
      expect(listeners.has(path.join(root, 'node_modules'))).toBe(false);
    } finally {
      worker.close();
    }
  });
});
