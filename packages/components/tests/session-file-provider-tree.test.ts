// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionMeta } from '@lody/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTreeView } from '../src/components/sessions/components/file-tree-view';
import {
  buildFileTreeFromSessionFileProviderEntries,
  useSessionFileProviderTree,
} from '../src/hooks/use-code-session';
import { createSessionFileProviderFromSource } from '../src/lib/session-file-provider-selection';
import type {
  SessionFileProvider,
  SessionFileProviderEntry,
} from '../src/lib/session-file-provider';

vi.mock('../src/hooks/use-code-collab-requested-role', () => ({
  useCodeCollabRequestedRole: () => 'read',
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
});

async function render(node: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('buildFileTreeFromSessionFileProviderEntries', () => {
  it('merges lazy ancestors with loaded files while retaining ids, modified flags and ordering', () => {
    const entries = [
      lazyDirectory('src/z'),
      lazyDirectory('assets/icons'),
      lazyDirectory('src', 'old-src'),
      { path: 'src/cache.ts', kind: 'text', sourceState: 'live-readonly', modifiedTime: 123 },
      { path: 'readme.md', kind: 'text', sourceState: 'live-readonly' },
      lazyDirectory('/src//a/', 'a-id'),
      lazyDirectory('src', 'current-src'),
      lazyDirectory('', 'empty-id'),
      { ...lazyDirectory('ignored'), directoryId: undefined },
    ] satisfies SessionFileProviderEntry[];
    expect(buildFileTreeFromSessionFileProviderEntries(Object.freeze(entries))).toEqual([
      {
        path: 'assets',
        type: 'directory',
        children: [
          {
            path: 'assets/icons',
            type: 'directory',
            children: [],
            lazyDirectoryId: 'assets/icons',
          },
        ],
      },
      {
        path: 'src',
        type: 'directory',
        modified: true,
        lazyDirectoryId: 'current-src',
        children: [
          { path: 'src/a', type: 'directory', children: [], lazyDirectoryId: 'a-id' },
          { path: 'src/z', type: 'directory', children: [], lazyDirectoryId: 'src/z' },
          { path: 'src/cache.ts', type: 'file', modified: true },
        ],
      },
      { path: 'readme.md', type: 'file', modified: false },
    ]);
  });

  it('keeps a lazy directory distinct from a file at the same path', () => {
    expect(
      buildFileTreeFromSessionFileProviderEntries([
        { path: 'same', kind: 'text', sourceState: 'live-readonly', modifiedTime: 123 },
        lazyDirectory('same/child'),
        lazyDirectory('same', 'replacement-id'),
      ])
    ).toEqual([
      {
        path: 'same',
        type: 'directory',
        lazyDirectoryId: 'replacement-id',
        children: [
          { path: 'same/child', type: 'directory', children: [], lazyDirectoryId: 'same/child' },
        ],
      },
      { path: 'same', type: 'file', modified: true },
    ]);
  });

  it('retains every directory and its identity in a broad reverse-ordered snapshot', () => {
    const paths = Array.from(
      { length: 4096 },
      (_, index) => `packages/pkg-${String(index).padStart(4, '0')}`
    );
    const tree = buildFileTreeFromSessionFileProviderEntries(
      [...paths].reverse().map((path) => lazyDirectory(path, `id:${path}`))
    );
    expect(tree).toEqual([
      {
        path: 'packages',
        type: 'directory',
        children: paths.map((path) => ({
          path,
          type: 'directory',
          children: [],
          lazyDirectoryId: `id:${path}`,
        })),
      },
    ]);
  });

  it('maps provider entries into the shared file tree shape', () => {
    expect(
      buildFileTreeFromSessionFileProviderEntries([
        {
          path: 'src/index.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
        {
          path: 'src/components/app.tsx',
          kind: 'text',
          sourceState: 'live-collaborative',
          modifiedTime: 1234,
        },
        {
          path: 'assets/logo.png',
          kind: 'binary',
          sourceState: 'live-collaborative',
        },
      ])
    ).toEqual([
      {
        path: 'assets',
        type: 'directory',
        modified: false,
        children: [{ path: 'assets/logo.png', type: 'file', modified: false }],
      },
      {
        path: 'src',
        type: 'directory',
        modified: true,
        children: [
          {
            path: 'src/components',
            type: 'directory',
            modified: true,
            children: [{ path: 'src/components/app.tsx', type: 'file', modified: true }],
          },
          { path: 'src/index.ts', type: 'file', modified: false },
        ],
      },
    ]);
  });

  it('marks the provider tree load as ready once listFiles returns', async () => {
    const provider = createSessionFileProviderFromSource({
      kind: 'none',
      message: 'Files are unavailable',
    });
    const rendered = await render(createElement(ProviderTreeProbe, { provider }));

    expect(rendered.textContent).toContain('ready:true');
    expect(rendered.textContent).toContain('synced:false');
    expect(rendered.textContent).toContain('Files are unavailable');
  });

  it('replaces lazy and loaded nodes when the provider publishes a new snapshot', async () => {
    const listeners = new Set<(files: readonly SessionFileProviderEntry[]) => void>();
    const provider: SessionFileProvider = {
      ...createReadyProvider([lazyDirectory('old')]),
      subscribeFiles(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const rendered = await render(createElement(ProviderTreeProbe, { provider }));
    expect(rendered.textContent).toContain('old');
    act(() => {
      for (const listener of listeners)
        listener([
          lazyDirectory('src'),
          { path: 'src/new.ts', kind: 'text', sourceState: 'live-readonly', modifiedTime: 123 },
        ]);
    });
    expect(JSON.parse(rendered.querySelector('pre')!.textContent!)).toEqual([
      {
        path: 'src',
        type: 'directory',
        modified: true,
        lazyDirectoryId: 'src',
        children: [{ path: 'src/new.ts', type: 'file', modified: true }],
      },
    ]);
    expect(rendered.textContent).toContain('ready:true synced:true');
  });

  it('treats an empty Code Collab file list as a normal empty directory', async () => {
    const provider = {
      kind: 'code-collab',
      getState: () => ({
        kind: 'code-collab',
        ready: true,
        sourceState: 'live-collaborative',
      }),
      listFiles: vi.fn(async () => []),
    } as unknown as SessionFileProvider;
    const rendered = await render(createElement(ProviderTreeProbe, { provider }));

    expect(rendered.textContent).toContain('ready:true');
    expect(rendered.textContent).toContain('synced:true');
    expect(rendered.textContent).toContain('roots:0');
    expect(rendered.textContent).not.toContain('host has not published');
  });

  it('renders a plain empty-directory message for empty provider file trees', async () => {
    const provider = createReadyProvider([]);
    const session = {
      id: 'session-provider-tree-empty',
      machineId: 'machine-1',
      createdAt: '2026-05-14T00:00:00.000Z',
      userId: 'user-1',
      cliType: 'codex',
      agentType: 'codex',
    } as unknown as SessionMeta;

    const rendered = await render(
      createElement(FileTreeView, {
        session,
        handleOpenFile: () => undefined,
        fileProvider: provider,
        fileProviderPending: false,
      })
    );

    expect(rendered.textContent).toContain('This directory is empty.');
    expect(rendered.textContent).not.toContain('host has not published');
  });

  it('renders provider files without waiting for another file source', async () => {
    const provider = createReadyProvider([
      {
        path: 'src/index.ts',
        kind: 'text',
        sourceState: 'live-readonly',
      },
    ]);
    const session = {
      id: 'session-provider-tree-render',
      machineId: 'machine-1',
      createdAt: '2026-05-14T00:00:00.000Z',
      userId: 'user-1',
      cliType: 'codex',
      agentType: 'codex',
    } as unknown as SessionMeta;

    const rendered = await render(
      createElement(FileTreeView, {
        session,
        handleOpenFile: () => undefined,
        fileProvider: provider,
        fileProviderPending: false,
      })
    );

    expect(rendered.textContent).toContain('src');
    expect(rendered.textContent).not.toContain('Connecting to code session');
  });
});

function createReadyProvider(
  files: Awaited<ReturnType<SessionFileProvider['listFiles']>>
): SessionFileProvider {
  return {
    kind: 'code-collab',
    getState: () => ({
      kind: 'code-collab',
      ready: true,
      sourceState: 'live-readonly',
    }),
    listFiles: vi.fn(async () => files),
  } as unknown as SessionFileProvider;
}

function ProviderTreeProbe({ provider }: { readonly provider: SessionFileProvider }) {
  const tree = useSessionFileProviderTree(provider);
  return createElement(
    'div',
    null,
    `ready:${String(tree.ready)} synced:${String(tree.synced)} roots:${tree.state.length} message:${
      tree.message ?? ''
    }`,
    createElement('pre', null, JSON.stringify(tree.state))
  );
}

function lazyDirectory(path: string, directoryId = path): SessionFileProviderEntry {
  return {
    path,
    directoryId,
    entryType: 'lazy-directory',
    kind: 'special',
    sourceState: 'live-readonly',
  };
}
