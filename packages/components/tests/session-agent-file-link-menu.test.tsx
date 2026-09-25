// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let localMachineId: string | null = 'machine-local';
vi.mock('../src/atoms/local-probe', () => ({
  localHomeDirAtom: atom('/Users/dev'),
  localMachineIdAtom: atom(() => localMachineId),
}));
vi.mock('../src/hooks/use-machine-flock-rows', () => ({
  useMachineFlockRows: () => ({}),
}));
vi.mock('../src/lib/native-platform', () => ({ isNativeAppShell: () => false }));

const revealLocalPath = vi.fn(async () => ({ revealed: true }));
const openLocalPath = vi.fn(async () => ({ opened: true }));
const launchLocalPath = vi.fn(async () => ({ launched: true }));
const probePathLaunchers = vi.fn(async (payload: { launchers: Array<{ launcherId: string }> }) => ({
  availableIds: payload.launchers.map((launcher) => launcher.launcherId),
}));
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({
    app: { revealLocalPath, openLocalPath, launchLocalPath, probePathLaunchers },
  }),
}));

const writeTextToClipboard = vi.fn(async () => true);
vi.mock('../src/lib/clipboard', () => ({
  writeTextToClipboard: (text: string) => writeTextToClipboard(text),
}));
vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import type { SessionMeta } from '@lody/shared';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import { SessionAgentFileLinkMenuProvider } from '../src/components/sessions/session-agent-file-link-menu';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT_SESSION = {
  id: 'root-local',
  machineId: 'machine-local',
  createdAt: '2026-09-17T00:00:00.000Z',
  userId: 'user-1',
} as unknown as SessionMeta;
const SIDE_SESSION = {
  ...ROOT_SESSION,
  id: 'side-remote',
  machineId: 'machine-remote',
  parentSessionId: ROOT_SESSION.id,
  childSessionPlacement: 'side-panel',
} as SessionMeta;
const FILE_LINK = '[submit.ts](/tmp/build/Lody.zip:366)';

describe('SessionAgentFileLinkMenuProvider', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    localMachineId = ROOT_SESSION.machineId;
    revealLocalPath.mockClear();
    openLocalPath.mockClear();
    launchLocalPath.mockClear();
    probePathLaunchers.mockClear();
    writeTextToClipboard.mockClear();
    (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__ = true;
    (window as { __LODY_PLATFORM__?: { os: string } }).__LODY_PLATFORM__ = { os: 'darwin' };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    document
      .querySelectorAll('[role="menu"]')
      .forEach((node) => node.remove());
    delete (window as { __LODY_ELECTRON__?: boolean }).__LODY_ELECTRON__;
    delete (window as { __LODY_PLATFORM__?: { os: string } }).__LODY_PLATFORM__;
  });

  const openContextMenu = async (region: HTMLElement) => {
    const link = region.querySelector('button[title]');
    if (!link) throw new Error('Markdown file link did not render');
    await act(async () => {
      link.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        })
      );
      await Promise.resolve();
    });
    const openMenus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
      .filter((menu) => menu.hasAttribute('data-open') || menu.dataset.state === 'open');
    const menu = openMenus[0];
    if (openMenus.length !== 1 || !menu) throw new Error('Exactly one context menu must be open');
    return menu;
  };

  const closeContextMenu = async () => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(
      [...document.querySelectorAll<HTMLElement>('[role="menu"]')].filter(
        (menu) => menu.hasAttribute('data-open') || menu.dataset.state === 'open'
      )
    ).toHaveLength(0);
  };

  it('does not let a remote side Session inherit its local root Session actions', async () => {
    await act(async () => {
      root?.render(
        createElement(
          Provider,
          null,
          createElement(
            'section',
            { 'data-testid': 'root-session' },
            createElement(
              SessionAgentFileLinkMenuProvider,
              { session: ROOT_SESSION },
              createElement(MarkdownRenderer, { text: FILE_LINK })
            )
          ),
          createElement(
            'section',
            { 'data-testid': 'side-session' },
            createElement(
              SessionAgentFileLinkMenuProvider,
              { session: SIDE_SESSION },
              createElement(MarkdownRenderer, { text: FILE_LINK })
            )
          )
        )
      );
      await Promise.resolve();
    });

    const rootRegion = container?.querySelector<HTMLElement>('[data-testid="root-session"]');
    const sideRegion = container?.querySelector<HTMLElement>('[data-testid="side-session"]');
    if (!rootRegion || !sideRegion) throw new Error('Session regions did not render');

    expect((await openContextMenu(rootRegion)).textContent).toContain('Open File');
    await closeContextMenu();

    const sideMenu = await openContextMenu(sideRegion);
    expect(sideMenu.textContent).toBe('Copy Path');
    const copyPath = sideMenu.querySelector<HTMLElement>('[role="menuitem"]');
    if (!copyPath) throw new Error('Copy Path action did not render');
    await act(async () => {
      copyPath.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(writeTextToClipboard).toHaveBeenLastCalledWith('/tmp/build/Lody.zip');
    expect(openLocalPath).not.toHaveBeenCalled();
    expect(revealLocalPath).not.toHaveBeenCalled();
    expect(launchLocalPath).not.toHaveBeenCalled();
  });
});
