// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import {
  MobileHomeOnboarding,
  MobileHomeScreen,
} from '../src/components/mobile/mobile-home-screen';
import { initI18n } from '../src/i18n';

describe('mobile-home-onboarding', () => {
  describe('MobileHomeOnboarding first-run guide', () => {
    let root: Root | undefined;
    let container: HTMLDivElement | undefined;

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
      Reflect.deleteProperty(navigator, 'clipboard');
      Reflect.deleteProperty(navigator, 'share');
    });

    function renderOnboarding(props: Parameters<typeof MobileHomeOnboarding>[0]) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      flushSync(() => {
        root?.render(createElement(MobileHomeOnboarding, props));
      });
    }

    function click(element: Element) {
      flushSync(() => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    async function settleMicrotasks() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync(() => {});
    }

    function findButton(text: string) {
      return Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
        button.textContent?.includes(text)
      );
    }

    it('guides through the command path, the desktop path, and the follow-up steps', () => {
      renderOnboarding({ labels: {} });

      const text = container?.textContent ?? '';
      // The one-command path is the headline: a copyable `lody daemon start`.
      expect(text).toContain('npx lody daemon start');
      // The "what happens next" preview keeps the three follow-up steps.
      expect(container?.querySelectorAll('ol li')).toHaveLength(3);
      // The phone never links out to the download page — the desktop path
      // only ever copies or shares the link for the computer.
      expect(container?.querySelector('a[href]')).toBeNull();
    });

    it('copies the install command to the clipboard from the command pill', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      renderOnboarding({ labels: {} });
      const button = container?.querySelector<HTMLButtonElement>('button[data-copied]');
      expect(button).not.toBeNull();

      click(button!);
      await settleMicrotasks();

      expect(writeText).toHaveBeenCalledWith('npx lody daemon start');
      // The icon swaps Copy → Check; there is no "Copied" text label.
      const copied = container?.querySelector('button[data-copied="true"]');
      expect(copied).not.toBeNull();
      expect(copied?.querySelector('svg.lucide-check')).not.toBeNull();
    });
  });
});

describe('mobile-session-list-scroll-layer', () => {
  describe('mobile session list scrollbar layer', () => {
    let root: Root | undefined;
    let container: HTMLDivElement | undefined;

    beforeEach(async () => {
      await initI18n('en');
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
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
        flushSync(() => root?.unmount());
      }
      root = undefined;
      container?.remove();
      container = undefined;
      vi.restoreAllMocks();
      delete window.__LODY_HORIZONTAL_DIVISION__;
      document.documentElement.style.removeProperty('--native-keyboard-height');
    });

    function render(node: ReactNode) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      flushSync(() => root?.render(node));
    }

    function expectScrollbarStackingBoundary() {
      const scrollRegion = container?.querySelector('[data-mobile-session-list-scroll-region]');
      expect(scrollRegion).not.toBeNull();
      expect(scrollRegion?.classList).toContain('relative');
      expect(scrollRegion?.classList).toContain('z-0');
      expect(scrollRegion?.classList).toContain('overflow-y-auto');
    }

    it('keeps whole groups on opposite sides of a horizontal fold without duplicating rows', () => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: HTMLElement) {
          const top = this.hasAttribute('data-horizontal-fold-home-body') ? 135 : 0;
          return {
            top,
            bottom: 951,
            left: 0,
            right: 669,
            width: 669,
            height: 951 - top,
            x: 0,
            y: top,
            toJSON: () => ({}),
          };
        }
      );
      window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
      const selected: string[] = [];
      render(
        <MobileHomeScreen
          workspace={{ id: 'workspace', name: 'Workspace' }}
          machines={[]}
          selectedTab="chat"
          localProjects={[]}
          githubRepositories={[]}
          chats={Array.from({ length: 8 }, (_, i) => ({
            id: `${i}`,
            title: `Chat ${i}`,
            isPinned: i < 2,
            openedByRowSessionId: i === 1 ? '0' : null,
          }))}
          onChatSelect={(id) => selected.push(id)}
        />
      );
      const shortcuts = container!.querySelector<HTMLElement>('[data-horizontal-fold-upper-list]')!;
      const fullList = container!.querySelector<HTMLElement>(
        '[data-mobile-session-list-scroll-region]'
      )!;
      expect(shortcuts).not.toBeNull();
      expect(shortcuts.style.flexBasis).toBe('320.5px');
      expect(shortcuts.textContent).toContain('Chat 0');
      expect(shortcuts.textContent).toContain('Chat 1');
      expect(fullList.textContent).not.toContain('Chat 0');
      expect(fullList.textContent).not.toContain('Chat 1');
      const showMore = Array.from(fullList.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Show more')
      )!;
      flushSync(() => showMore.click());
      expect(fullList.textContent).toContain('Chat 7');
      const firstChat = Array.from(shortcuts.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Chat 0')
      )!;
      flushSync(() => firstChat.click());
      expect(selected).toEqual(['0']);
      flushSync(() => {
        document.documentElement.style.setProperty('--native-keyboard-height', '380px');
        window.dispatchEvent(new Event('lody:keyboard-resize'));
      });
      expect(container!.querySelector('[data-horizontal-fold-upper-list]')).toBeNull();
      expect(fullList.textContent).toContain('Chat 7');
    });

    it('shares archive selection across panels and keeps it when unfolded', () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
          function (this: HTMLElement) {
            const top = this.hasAttribute('data-horizontal-fold-home-body') ? 135 : 0;
            return {
              top,
              bottom: 951,
              left: 0,
              right: 669,
              width: 669,
              height: 951 - top,
              x: 0,
              y: top,
              toJSON: () => ({}),
            };
          }
        );
        window.__LODY_HORIZONTAL_DIVISION__ = { top: 455.5, height: 40, viewportHeight: 951 };
        const deleted = vi.fn();
        render(
          <MobileHomeScreen
            workspace={{ id: 'workspace', name: 'Workspace' }}
            machines={[]}
            selectedTab="chat"
            localProjects={[]}
            githubRepositories={[]}
            showArchived
            onChatPermanentDelete={deleted}
            chats={Array.from({ length: 8 }, (_, i) => ({
              id: `${i}`,
              title: `Archive ${i}`,
              isPinned: i < 2,
            }))}
          />
        );
        const upper = container!.querySelector<HTMLElement>(
          '[data-horizontal-fold-archive-upper]'
        )!;
        const lower = container!.querySelector<HTMLElement>(
          '[data-mobile-session-list-scroll-region]'
        )!;
        expect(upper.textContent).toContain('Archive 0');
        expect(lower.textContent).not.toContain('Archive 0');
        expect(lower.textContent).toContain('Archive 2');
        const row = upper.querySelector<HTMLElement>('.mobile-project-conversation-row')!;
        flushSync(() =>
          row.dispatchEvent(
            new MouseEvent('pointerdown', { bubbles: true, clientX: 8, clientY: 8 })
          )
        );
        flushSync(() => vi.advanceTimersByTime(600));
        const selectAll = [...upper.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('已选 1')
        )!;
        expect(selectAll).toBeTruthy();
        flushSync(() => selectAll.click());
        expect(upper.textContent).toContain('已选 8');
        expect(lower.textContent).toContain('Archive 7');
        flushSync(() => {
          document.documentElement.style.setProperty('--native-keyboard-height', '380px');
          window.dispatchEvent(new Event('lody:keyboard-resize'));
        });
        expect(container!.querySelector('[data-horizontal-fold-archive-upper]')).toBeNull();
        expect(container!.textContent).toContain('已选 8');
        flushSync(() => {
          document.documentElement.style.removeProperty('--native-keyboard-height');
          window.dispatchEvent(new Event('lody:keyboard-resize'));
        });
        expect(
          container!.querySelector('[data-horizontal-fold-archive-upper]')?.textContent
        ).toContain('已选 8');
        flushSync(() => {
          delete window.__LODY_HORIZONTAL_DIVISION__;
          window.dispatchEvent(new Event('lody:division-change'));
        });
        expect(container!.querySelector('[data-horizontal-fold-archive-upper]')).toBeNull();
        expect(container!.textContent).toContain('已选 8');
        expect(container!.textContent).toContain('Archive 7');
        expect(deleted).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
