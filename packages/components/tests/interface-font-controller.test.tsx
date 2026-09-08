// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  interfaceFontFamilyAtom,
  INTERFACE_FONT_FAMILY_MAX_LENGTH,
  normalizeInterfaceFontFamily,
} from '../src/atoms/settings';
import { InterfaceFontController } from '../src/components/interface-font-controller';
import { INTERFACE_FONT_CSS_VARIABLE, listSystemFontFamilies } from '../src/lib/local-fonts';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('InterfaceFontController', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    window.localStorage.clear();
    document.documentElement.style.removeProperty(INTERFACE_FONT_CSS_VARIABLE);
    root = undefined;
    container = undefined;
  });

  it('normalizes persisted font family values', () => {
    expect(normalizeInterfaceFontFamily('  Atkinson Hyperlegible  ')).toBe(
      'Atkinson Hyperlegible'
    );
    expect(
      normalizeInterfaceFontFamily('a'.repeat(INTERFACE_FONT_FAMILY_MAX_LENGTH + 10))
    ).toHaveLength(INTERFACE_FONT_FAMILY_MAX_LENGTH);
    expect(normalizeInterfaceFontFamily(null)).toBe('');
  });

  it('excludes symbol fonts while retaining and deduplicating text fonts', async () => {
    const families = [
      'Webdings',
      'Wingdings',
      'Wingdings 2',
      'Wingdings 3',
      'Symbol',
      'Zapf Dingbats',
    ];
    expect(
      await listSystemFontFamilies(async () =>
        [...families, 'Inter', ' inter ', 'Wawati SC', 'Zilla Slab'].map((family) => ({ family }))
      )
    ).toEqual(['Inter', 'Wawati SC', 'Zilla Slab']);
  });

  it('recovers a persisted symbol font without applying it to the interface', async () => {
    window.localStorage.setItem('lody-interface-font-family', JSON.stringify('Wingdings 2'));
    const store = createStore();
    await act(async () => {
      root?.render(
        <Provider store={store}>
          <InterfaceFontController enabled />
        </Provider>
      );
    });
    expect(store.get(interfaceFontFamilyAtom)).toBe('');
    expect(document.documentElement.style.getPropertyValue(INTERFACE_FONT_CSS_VARIABLE)).toBe('');
  });

  it('updates the global interface font immediately when enabled', async () => {
    const store = createStore();

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <InterfaceFontController enabled />
        </Provider>
      );
    });

    await act(async () => {
      store.set(interfaceFontFamilyAtom, 'Atkinson Hyperlegible');
    });

    expect(document.documentElement.style.getPropertyValue(INTERFACE_FONT_CSS_VARIABLE)).toBe(
      '"Atkinson Hyperlegible", var(--font-sans-default)'
    );

    await act(async () => {
      store.set(interfaceFontFamilyAtom, '');
    });
    expect(document.documentElement.style.getPropertyValue(INTERFACE_FONT_CSS_VARIABLE)).toBe('');
  });

  it('does not apply the stored interface font outside Electron', async () => {
    const store = createStore();
    store.set(interfaceFontFamilyAtom, 'Atkinson Hyperlegible');

    await act(async () => {
      root?.render(
        <Provider store={store}>
          <InterfaceFontController enabled={false} />
        </Provider>
      );
    });

    expect(document.documentElement.style.getPropertyValue(INTERFACE_FONT_CSS_VARIABLE)).toBe('');
  });
});
