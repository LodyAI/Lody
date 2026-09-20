// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import {
  resolveSidebarAvatarTone,
  resolveUpdatedItemProjectLabel,
  SidebarUpdatedSessionList,
  type SidebarUpdatedItem,
} from '../src/components/sidebar-updated-session-list';
import { initI18n } from '../src/i18n';

function makeItem(overrides: Partial<SidebarUpdatedItem> & { id: string }): SidebarUpdatedItem {
  return {
    kind: 'chat',
    title: `Session ${overrides.id}`,
    sectionLabel: 'Chats',
    latestMessageAt: '2026-04-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveUpdatedItemProjectLabel', () => {
  it('prefers subtitle, then section label', () => {
    expect(
      resolveUpdatedItemProjectLabel(
        makeItem({
          id: 'local',
          kind: 'local',
          subtitle: 'lody',
          sectionLabel: 'Local Projects · lody',
        })
      )
    ).toBe('lody');
    expect(
      resolveUpdatedItemProjectLabel(
        makeItem({
          id: 'github',
          kind: 'github',
          subtitle: 'loro-dev/lody',
          sectionLabel: 'loro-dev/lody',
        })
      )
    ).toBe('loro-dev/lody');
    expect(resolveUpdatedItemProjectLabel(makeItem({ id: 'chat', subtitle: null }))).toBe('Chats');
  });
});

describe('resolveSidebarAvatarTone', () => {
  const solidPixels = (value: number) =>
    new Uint8ClampedArray([value, value, value, 255, value, value, value, 255]);

  it('lightens dark avatars without changing light-source luminance', () => {
    const darkTone = resolveSidebarAvatarTone(solidPixels(16));
    const opaqueMidDarkTone = resolveSidebarAvatarTone(solidPixels(96));
    const transparentMidDarkTone = resolveSidebarAvatarTone(
      new Uint8ClampedArray([96, 96, 96, 255, 0, 0, 0, 0])
    );
    const lightTone = resolveSidebarAvatarTone(solidPixels(240));

    expect(darkTone.brightness).toBeGreaterThan(1);
    expect(darkTone.contrast).toBeLessThan(1);
    expect(transparentMidDarkTone.brightness).toBeGreaterThan(opaqueMidDarkTone.brightness);
    expect(transparentMidDarkTone.contrast).toBeLessThan(opaqueMidDarkTone.contrast);
    expect(lightTone).toEqual({ brightness: 1, contrast: 1 });
  });
});

describe('SidebarUpdatedSessionList project context', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function render(items: SidebarUpdatedItem[], showProjectContext = true, selectedItemId?: string) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const store = createStore();
    flushSync(() => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(SidebarUpdatedSessionList, {
            items,
            now: new Date('2026-04-22T12:00:00.000Z'),
            showProjectContext,
            selectedItemId,
          })
        )
      );
    });
  }

  it('does not show a project line unless Updated mode asks for it', () => {
    render(
      [
        makeItem({
          id: 'local',
          kind: 'local',
          title: 'Local session',
          subtitle: 'lody',
          sectionLabel: 'Local Projects · lody',
        }),
      ],
      false
    );
    expect(container?.querySelector('[data-sidebar-updated-project]')).toBeNull();
  });

  it('shows folder + project name on local rows and owner mark + repo on GitHub rows', () => {
    render([
      makeItem({
        id: 'local',
        kind: 'local',
        title: 'Local session',
        subtitle: 'lody',
        sectionLabel: 'Local Projects · lody',
        latestMessageAt: '2026-04-22T11:00:00.000Z',
      }),
      makeItem({
        id: 'github',
        kind: 'github',
        title: 'GitHub session',
        subtitle: 'loro-dev/lody',
        repoFullName: 'loro-dev/lody',
        sectionLabel: 'loro-dev/lody',
        latestMessageAt: '2026-04-22T10:00:00.000Z',
      }),
      makeItem({
        id: 'chat',
        kind: 'chat',
        title: 'Chat session',
        subtitle: null,
        sectionLabel: 'Chats',
        latestMessageAt: '2026-04-22T09:00:00.000Z',
      }),
    ]);

    const local = container?.querySelector('[data-sidebar-updated-id="local"]');
    const github = container?.querySelector('[data-sidebar-updated-id="github"]');
    const chat = container?.querySelector('[data-sidebar-updated-id="chat"]');

    const localProject = local?.querySelector('[data-sidebar-updated-project="local"]');
    expect(localProject).not.toBeNull();
    expect(localProject?.textContent).toContain('lody');
    expect(localProject?.querySelector('.lucide-folder')).not.toBeNull();

    const githubProject = github?.querySelector('[data-sidebar-updated-project="github"]');
    expect(githubProject).not.toBeNull();
    expect(githubProject?.textContent).toContain('loro-dev/lody');
    expect(githubProject?.querySelector('img')?.getAttribute('src') ?? '').toContain(
      'avatars.githubusercontent.com/loro-dev'
    );
    expect(
      githubProject
        ?.querySelector('img')
        ?.classList.contains(
          '[filter:grayscale(1)_contrast(var(--sidebar-avatar-contrast))_brightness(var(--sidebar-avatar-brightness))]'
        )
    ).toBe(true);
    expect(githubProject?.querySelector('img')?.classList.contains('opacity-80')).toBe(true);
    expect(githubProject?.querySelector('img')?.getAttribute('crossorigin')).toBe('anonymous');

    const chatProject = chat?.querySelector('[data-sidebar-updated-project="chat"]');
    expect(chatProject).not.toBeNull();
    expect(chatProject?.textContent).toContain('Chats');
    expect(chatProject?.querySelector('.lucide-message-circle')).not.toBeNull();
  });

  it('restores the original avatar color only for the active row', () => {
    render(
      [
        makeItem({
          id: 'github',
          kind: 'github',
          subtitle: 'wibus-wee/lody',
          repoFullName: 'wibus-wee/lody',
          sectionLabel: 'wibus-wee/lody',
        }),
      ],
      true,
      'github'
    );

    const avatar = container?.querySelector<HTMLImageElement>(
      '[data-sidebar-updated-project="github"] img'
    );
    expect(avatar?.classList.contains('opacity-100')).toBe(true);
    expect(avatar?.classList.contains('[filter:grayscale(0)_contrast(1)_brightness(1)]')).toBe(
      true
    );
    expect([...(avatar?.classList ?? [])].some((name) => name.startsWith('group-hover/'))).toBe(
      false
    );
  });

  it('hides the project line on nested opened Sessions', () => {
    render([
      makeItem({
        id: 'opener',
        kind: 'local',
        title: 'Opener',
        subtitle: 'lody',
        sectionLabel: 'Local Projects · lody',
        latestMessageAt: '2026-04-22T11:00:00.000Z',
      }),
      makeItem({
        id: 'opened',
        kind: 'local',
        title: 'Opened child',
        subtitle: 'lody',
        sectionLabel: 'Local Projects · lody',
        openedBySessionId: 'opener',
        latestMessageAt: '2026-04-22T10:00:00.000Z',
      }),
    ]);

    expect(
      container
        ?.querySelector('[data-sidebar-updated-id="opener"]')
        ?.querySelector('[data-sidebar-updated-project]')
    ).not.toBeNull();
    expect(
      container
        ?.querySelector('[data-sidebar-updated-id="opened"]')
        ?.querySelector('[data-sidebar-updated-project]')
    ).toBeNull();
  });
});
