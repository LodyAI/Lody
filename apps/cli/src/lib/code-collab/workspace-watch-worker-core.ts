import { readdirSync, watch, type FSWatcher, type WatchOptions } from 'node:fs';
import path from 'node:path';
import {
  normalizeWorkspaceWatchFilename,
  shouldIgnoreWorkspaceWatchFilename,
} from './workspace-watch-path-policy';
import {
  planWorkspaceWatchTargets,
  rootEventMayChangeWatchPlan,
  type WorkspaceWatchPlanEntry,
} from './workspace-watch-plan';
import {
  parseWorkspaceWatchParentMessage,
  type WorkspaceWatchChildMessage,
} from './workspace-watch-protocol';

type WatchFactory = (
  root: string,
  options: WatchOptions,
  listener: (eventType: string, filename: string | Buffer | null) => void
) => FSWatcher;

type ReadDirectory = (directory: string) => readonly WorkspaceWatchPlanEntry[];

const defaultReadDirectory: ReadDirectory = (directory) =>
  readdirSync(directory, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
  }));

export function startWorkspaceWatchWorker(options: {
  send: (message: WorkspaceWatchChildMessage) => void;
  onMessage: (handler: (message: unknown) => void) => void;
  onDisconnect: (handler: () => void) => void;
  exit: () => void;
  watchFactory?: WatchFactory;
  readDirectory?: ReadDirectory;
  statsIntervalMs?: number;
}): { close: () => void } {
  /** One entry per watched ROOT; each holds the handles its plan produced. */
  const watchers = new Map<string, FSWatcher[]>();
  const watchFactory = options.watchFactory ?? watch;
  const readDirectory = options.readDirectory ?? defaultReadDirectory;
  const startedAtMs = Date.now();
  let generation = 0;
  let reconfigurationCount = 0;
  let closed = false;

  const closeRoot = (root: string): void => {
    for (const watcher of watchers.get(root) ?? []) watcher.close();
    watchers.delete(root);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const root of [...watchers.keys()]) closeRoot(root);
    clearInterval(statsTimer);
  };

  const countWatchHandles = (): number => {
    let total = 0;
    for (const handles of watchers.values()) total += handles.length;
    return total;
  };

  const statsTimer = setInterval(() => {
    options.send({
      type: 'code-collab-watch/stats',
      generation,
      watcherCount: countWatchHandles(),
      rssBytes: process.memoryUsage().rss,
      reconfigurationCount,
      uptimeMs: Date.now() - startedAtMs,
    });
  }, options.statsIntervalMs ?? 30_000);
  statsTimer.unref?.();

  const reportRootError = (root: string, error: unknown): void => {
    options.send({
      type: 'code-collab-watch/error',
      generation,
      root,
      code: error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN',
    });
  };

  /**
   * Install the watch handles for one root.
   *
   * The root itself is watched non-recursively and each non-ignored top-level
   * directory gets its own recursive watch; see `planWorkspaceWatchTargets` for why.
   * A top-level rename re-plans, because the set of directories to watch changed.
   */
  const installRoot = (root: string): void => {
    let entries: readonly WorkspaceWatchPlanEntry[];
    try {
      entries = readDirectory(root);
    } catch (error) {
      reportRootError(root, error);
      return;
    }

    const handles: FSWatcher[] = [];
    const failRoot = (error: unknown): void => {
      // A handle from a superseded plan can still emit; it must not tear down the
      // plan that replaced it.
      const current = watchers.get(root);
      if (current !== undefined && current !== handles) return;
      for (const handle of handles) handle.close();
      watchers.delete(root);
      reportRootError(root, error);
    };

    for (const target of planWorkspaceWatchTargets(root, entries)) {
      const isRootWatch = target.directory === root;
      const targetPrefix = isRootWatch
        ? ''
        : `${path.relative(root, target.directory).split(path.sep).join('/')}/`;
      try {
        const watcher = watchFactory(
          target.directory,
          { recursive: target.recursive, persistent: false },
          (_, filename) => {
            if (closed) return;
            const normalized = filename === null ? null : normalizeWorkspaceWatchFilename(filename);
            if (normalized !== null && shouldIgnoreWorkspaceWatchFilename(normalized)) return;
            if (isRootWatch && rootEventMayChangeWatchPlan(normalized)) {
              // A new top-level directory has no watch yet, and a removed one leaves
              // a dead handle. Re-plan OUT of this callback: it would otherwise close
              // the very handle currently dispatching it.
              scheduleReplan(root);
            }
            options.send({
              type: 'code-collab-watch/dirty',
              generation,
              root,
              ...(normalized === null || normalized === '.'
                ? {}
                : { path: `${targetPrefix}${normalized}` }),
            });
          }
        );
        watcher.on('error', (error: NodeJS.ErrnoException) => failRoot(error));
        handles.push(watcher);
      } catch (error) {
        // A top-level directory can disappear between readdir and watch. Only the
        // root watch failing is fatal for this root.
        if (isRootWatch) {
          failRoot(error);
          return;
        }
      }
    }
    watchers.set(root, handles);
  };

  const replanScheduled = new Set<string>();

  /** Rebuild a root's watch plan once, after the current callback unwinds. */
  const scheduleReplan = (root: string): void => {
    if (replanScheduled.has(root)) return;
    replanScheduled.add(root);
    const timer = setTimeout(() => {
      replanScheduled.delete(root);
      // The root may have been dropped by a reconfiguration in the meantime.
      if (closed || !watchers.has(root)) return;
      closeRoot(root);
      installRoot(root);
    }, 0);
    timer.unref?.();
  };

  options.onMessage((raw) => {
    const message = parseWorkspaceWatchParentMessage(raw);
    if (!message || closed) return;
    if (message.type === 'code-collab-watch/shutdown') {
      if (message.generation !== generation) return;
      close();
      options.exit();
      return;
    }
    if (message.generation < generation) return;
    generation = message.generation;
    reconfigurationCount += 1;
    const desired = new Set(message.roots);
    for (const root of [...watchers.keys()]) {
      if (!desired.has(root)) {
        closeRoot(root);
      }
    }
    for (const root of desired) {
      if (watchers.has(root)) continue;
      installRoot(root);
    }
    options.send({
      type: 'code-collab-watch/ready',
      generation,
      revision: message.revision,
      watchedRoots: Array.from(watchers.keys()),
    });
  });
  options.onDisconnect(() => {
    close();
    options.exit();
  });
  return { close };
}
