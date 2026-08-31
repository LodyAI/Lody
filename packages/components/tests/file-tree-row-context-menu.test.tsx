// @vitest-environment jsdom

// The file tree's right-click menu picks its actions from WHERE the files are:
// a remote workspace can only be downloaded, a local one is already on disk and
// gets "reveal in the file manager" instead. Mention and copy-path are offered
// either way. Covered here, plus the regression that made the FIRST right-click
// open nothing.

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileTreeProviderView } from '../src/components/sessions/components/file-tree-view';
import type { FileWorkspaceProvider } from '../src/lib/file-workspace-provider';
import { initI18n } from '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installLayoutStubs(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    'DOMRect',
    class {
      constructor(
        readonly x = 0,
        readonly y = 0,
        readonly width = 0,
        readonly height = 0
      ) {}
      static fromRect() {
        return new DOMRect();
      }
    }
  );
}

function createProvider(paths: readonly string[]): FileWorkspaceProvider {
  return {
    kind: 'code-collab',
    getState: () => ({ kind: 'code-collab', ready: true, sourceState: 'live-readonly' }),
    listFiles: async () =>
      paths.map((path) => ({ path, kind: 'text' as const, sourceState: 'live-readonly' as const })),
  } as unknown as FileWorkspaceProvider;
}

describe('file tree row context menu', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    await initI18n('en');
    installLayoutStubs();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    delete (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
    vi.unstubAllGlobals();
  });

  async function render(node: ReactNode): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(node);
    });
    return container;
  }

  function findRow(host: HTMLElement, name: string): HTMLElement {
    const row = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
      (candidate) => candidate.textContent?.trim() === name
    );
    if (!row) throw new Error(`row ${name} not found`);
    return row;
  }

  async function rightClick(row: HTMLElement): Promise<void> {
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
  }

  function menuLabels(): string[] {
    return [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent?.trim() ?? ''
    );
  }

  async function clickMenuItem(label: string): Promise<void> {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent?.trim() === label
    );
    if (!item) throw new Error(`menu item ${label} not found in [${menuLabels().join(', ')}]`);
    await act(async () => {
      // Radix commits an item on pointerup, then fires its own `select`.
      item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      item.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      item.click();
    });
  }

  it('opens on the FIRST right-click, offering Download for a remote workspace', async () => {
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createProvider(['a.ts']),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
        rowMenu: {
          provider: createProvider(['a.ts']),
          workspaceRootPath: '/srv/build/project',
          isLocalMachine: false,
          onMentionFile: () => true,
        },
      })
    );

    // The regression: gating the Radix trigger on "a row is already targeted"
    // swallowed exactly this click, because Radix reads `disabled` from the
    // props it rendered with.
    await rightClick(findRow(host, 'a.ts'));
    expect(menuLabels()).toEqual([
      'Add to conversation',
      'Download',
      'Copy path',
      'Copy relative path',
    ]);
  });

  // Reveal replaces Download, and never appears beside it: the file is already
  // on disk, so a download would write a second copy of it.
  it('offers Reveal instead of Download when the workspace is on this machine', async () => {
    (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createProvider(['a.ts']),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
        rowMenu: {
          provider: createProvider(['a.ts']),
          workspaceRootPath: '/home/me/project',
          isLocalMachine: true,
          onMentionFile: () => true,
        },
      })
    );

    await rightClick(findRow(host, 'a.ts'));
    // No "Open in …": nothing probed as installed without an Electron bridge.
    expect(menuLabels()).toEqual([
      'Add to conversation',
      'Reveal in File Manager',
      'Copy path',
      'Copy relative path',
    ]);
  });

  // Regression: `workspaceRootPath` used to be ANDed into the local check, so a
  // session whose path metadata had not synced yet (dotlodyPath / local-project
  // root unresolved) fell through to the remote branch and offered Download for
  // a file sitting on this very machine. Machine ownership alone decides that;
  // a missing path may only remove reveal/open.
  it('never offers Download on this machine, even with no workspace path resolved', async () => {
    (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createProvider(['a.ts']),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
        rowMenu: {
          provider: createProvider(['a.ts']),
          workspaceRootPath: null,
          isLocalMachine: true,
          onMentionFile: () => true,
        },
      })
    );

    await rightClick(findRow(host, 'a.ts'));
    expect(menuLabels()).not.toContain('Download');
    // Reveal and Copy path drop out with no absolute path to hand the OS; what
    // the row can still do without one stays.
    expect(menuLabels()).toEqual(['Add to conversation', 'Copy relative path']);
  });

  it('copies the machine-absolute path and the workspace-relative one separately', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createProvider(['src/a.ts']),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
        rowMenu: { provider: null, workspaceRootPath: '/home/me/project' },
      })
    );

    const expandRow = findRow(host, 'src');
    await act(async () => expandRow.click());
    await rightClick(findRow(host, 'a.ts'));

    await clickMenuItem('Copy path');
    expect(writeText).toHaveBeenCalledWith('/home/me/project/src/a.ts');

    await rightClick(findRow(host, 'a.ts'));
    await clickMenuItem('Copy relative path');
    expect(writeText).toHaveBeenLastCalledWith('src/a.ts');
  });

  // A directory mention carries the trailing slash the known-path set matches
  // on, which is what `toFileCandidate` commits from the `@` menu too.
  it('mentions a folder with its directory token', async () => {
    const onMentionFile = vi.fn(() => true);
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createProvider(['src/a.ts']),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
        rowMenu: { provider: null, onMentionFile },
      })
    );

    await rightClick(findRow(host, 'src'));
    await clickMenuItem('Add to conversation');
    expect(onMentionFile).toHaveBeenCalledWith({ path: 'src', isDirectory: true });
  });

  it('renders no menu at all when the caller wires no actions', async () => {
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createProvider(['a.ts']),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
      })
    );

    await rightClick(findRow(host, 'a.ts'));
    expect(menuLabels()).toEqual([]);
  });
});
