// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandPaletteView,
  type PaletteResult,
} from '../src/components/commands/command-palette-view';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS = {
  placeholder: 'Search',
  empty: 'Nothing here',
  navigate: 'Navigate',
  select: 'Select',
  close: 'Close',
};

describe('CommandPaletteView', () => {
  let root: Root;
  let container: HTMLDivElement;
  const ran: string[] = [];

  const result = (key: string, group?: string): PaletteResult => ({
    kind: 'command',
    key,
    title: key,
    subtitle: null,
    shortcut: null,
    group,
    run: () => ran.push(key),
  });

  const render = async (results: PaletteResult[]) => {
    await act(async () => {
      root.render(
        createElement(CommandPaletteView, {
          open: true,
          onOpenChange: () => undefined,
          query: '',
          onQueryChange: () => undefined,
          results,
          labels: LABELS,
        })
      );
    });
  };

  const selectedTitle = () =>
    document.body.querySelector('[cmdk-item][aria-selected="true"]')?.textContent;
  const press = async (key: string) => {
    const input = document.body.querySelector<HTMLInputElement>('[cmdk-input]')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  };

  beforeEach(() => {
    Element.prototype.scrollIntoView = () => undefined;
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    ran.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('heads each run of commands with its group, once', async () => {
    await render([
      result('back', 'Navigation'),
      result('new', 'Session'),
      result('pin', 'Session'),
    ]);
    const headings = [...document.body.querySelectorAll('[cmdk-list] p')].map((p) => p.textContent);
    expect(headings).toEqual(['Navigation', 'Session']);
  });

  it('moves the highlight with the arrow keys and runs the highlighted row on Enter', async () => {
    await render([
      result('back', 'Navigation'),
      result('new', 'Session'),
      result('pin', 'Session'),
    ]);
    expect(selectedTitle()).toBe('back');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(selectedTitle()).toBe('pin');
    await press('Enter');
    expect(ran).toEqual(['pin']);
  });

  it('says so when nothing matches', async () => {
    await render([]);
    expect(document.body.textContent).toContain('Nothing here');
  });
});
