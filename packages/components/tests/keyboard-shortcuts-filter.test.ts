/**
 * Ways the shortcut search can fail, each covered below:
 * - a name match depends on letter case, or on the exact translated label;
 * - a row is only findable by its translated label, not its English title or command id;
 * - a whitespace-only query hides every row instead of filtering nothing;
 * - the key filter only looks at a row's primary binding, missing a secondary one;
 * - equivalent spellings of one combo (aliases, modifier order, `Mod` vs the platform
 *   key) fail to match each other;
 * - a bare key without modifiers (Enter) cannot be searched;
 * - the text and key filters combine as OR instead of AND;
 * - a row with no binding, or an unrelated binding, matches a key filter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isShortcutFilterActive,
  matchesShortcutFilter,
  type ShortcutFilterRow,
} from '../src/components/settings/keyboard-shortcuts-filter';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';

function setPlatform(os: 'darwin' | 'linux') {
  vi.stubGlobal('window', { __LODY_PLATFORM__: { os } });
  __resetPlatformCacheForTests();
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetPlatformCacheForTests();
});

const nextWindow: ShortcutFilterRow = {
  label: '下个窗口',
  title: 'Next window',
  id: 'window.next',
  bindings: ['Mod+Shift+]'],
};

const palette: ShortcutFilterRow = {
  label: 'Open command palette',
  title: 'Open command palette',
  id: 'palette.open',
  bindings: ['Mod+K', 'Mod+Shift+P'],
};

const submit: ShortcutFilterRow = {
  label: 'Send message',
  title: 'Send message',
  id: 'composer.submit',
  bindings: ['Enter'],
};

const unbound: ShortcutFilterRow = {
  label: 'Toggle zen mode',
  title: 'Toggle zen mode',
  id: 'view.zen',
  bindings: [null],
};

describe('matchesShortcutFilter by name', () => {
  it('matches the displayed label case-insensitively', () => {
    expect(matchesShortcutFilter(palette, { query: 'COMMAND pal', keyFilter: null })).toBe(true);
  });

  it('matches the translated label and the untranslated title of the same row', () => {
    expect(matchesShortcutFilter(nextWindow, { query: '下个窗口', keyFilter: null })).toBe(true);
    expect(matchesShortcutFilter(nextWindow, { query: 'next window', keyFilter: null })).toBe(true);
  });

  it('matches the command id', () => {
    expect(matchesShortcutFilter(submit, { query: 'composer.sub', keyFilter: null })).toBe(true);
  });

  it('trims the query and treats whitespace-only as no text filter', () => {
    expect(matchesShortcutFilter(palette, { query: '  palette  ', keyFilter: null })).toBe(true);
    expect(matchesShortcutFilter(unbound, { query: '   ', keyFilter: null })).toBe(true);
    expect(isShortcutFilterActive({ query: '   ', keyFilter: null })).toBe(false);
  });

  it('rejects a row whose label, title, and id all miss the query', () => {
    expect(matchesShortcutFilter(palette, { query: 'window', keyFilter: null })).toBe(false);
  });
});

describe('matchesShortcutFilter by key combo', () => {
  it('matches a non-primary binding', () => {
    setPlatform('linux');
    expect(matchesShortcutFilter(palette, { query: '', keyFilter: 'Mod+Shift+P' })).toBe(true);
  });

  it('compares canonical forms across aliases and modifier order', () => {
    setPlatform('darwin');
    expect(matchesShortcutFilter(palette, { query: '', keyFilter: 'Cmd+K' })).toBe(true);
    expect(matchesShortcutFilter(palette, { query: '', keyFilter: 'shift+cmd+p' })).toBe(true);
    setPlatform('linux');
    expect(matchesShortcutFilter(palette, { query: '', keyFilter: 'Control+K' })).toBe(true);
  });

  it('matches a bare key without modifiers', () => {
    setPlatform('linux');
    expect(matchesShortcutFilter(submit, { query: '', keyFilter: 'Enter' })).toBe(true);
    expect(matchesShortcutFilter(submit, { query: '', keyFilter: 'Mod+Enter' })).toBe(false);
  });

  it('never matches an unbound row or an unrelated combo', () => {
    setPlatform('linux');
    expect(matchesShortcutFilter(unbound, { query: '', keyFilter: 'Mod+K' })).toBe(false);
    expect(matchesShortcutFilter(palette, { query: '', keyFilter: 'Mod+J' })).toBe(false);
  });
});

describe('matchesShortcutFilter with both filters', () => {
  it('requires the name and the key combo to match together', () => {
    setPlatform('linux');
    expect(matchesShortcutFilter(palette, { query: 'palette', keyFilter: 'Mod+K' })).toBe(true);
    expect(matchesShortcutFilter(palette, { query: 'palette', keyFilter: 'Enter' })).toBe(false);
    expect(matchesShortcutFilter(submit, { query: 'palette', keyFilter: 'Enter' })).toBe(false);
  });

  it('reports a filter as active once either part is set', () => {
    expect(isShortcutFilterActive({ query: '', keyFilter: null })).toBe(false);
    expect(isShortcutFilterActive({ query: 'a', keyFilter: null })).toBe(true);
    expect(isShortcutFilterActive({ query: '', keyFilter: 'Enter' })).toBe(true);
  });
});
