// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { resolveTheme } from '@pierre/diffs';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider, useActiveVSCodeDiffThemeName } from '../src/theme-provider';
import {
  createLodyVSCodeShikiThemeName,
  getBundledVSCodeThemeById,
  getRegisteredLodyVSCodeThemeForDiffs,
  registerLodyVSCodeThemeForDiffs,
  type LodyResolvedVSCodeTheme,
} from '../src/lib/vscode-theme';

const createTheme = (id: string): LodyResolvedVSCodeTheme => ({
  schemaVersion: 1,
  id,
  label: `Theme ${id}`,
  type: 'dark',
  source: { kind: 'test-fixture' },
  colors: {
    'editor.background': '#101010',
    'editor.foreground': '#FFFFFF',
  },
  tokenColors: [
    {
      scope: 'keyword',
      settings: { foreground: '#FFC799' },
    },
  ],
});

function DiffThemeProbe() {
  const diffThemeName = useActiveVSCodeDiffThemeName();
  return createElement('div', {
    id: 'diff-theme-probe',
    'data-diff-theme-name': diffThemeName ?? '',
  });
}

describe('VSCode diff theme registration', () => {
  it('does not report a lazy custom theme as registered until @pierre/diffs has the loader', async () => {
    const theme = createTheme('registration-race');
    const themeName = createLodyVSCodeShikiThemeName(theme);

    const firstRegistration = registerLodyVSCodeThemeForDiffs(theme);
    const secondRegistration = registerLodyVSCodeThemeForDiffs(theme);

    expect(firstRegistration).toBe(secondRegistration);
    expect(getRegisteredLodyVSCodeThemeForDiffs(theme)).toBeUndefined();

    await expect(firstRegistration).resolves.toBe(themeName);
    await expect(secondRegistration).resolves.toBe(themeName);

    expect(getRegisteredLodyVSCodeThemeForDiffs(theme)).toBe(themeName);
    expect((await resolveTheme(themeName, 'highlights')).zed?.style['editor.background']).toBe(
      '#101010'
    );
    expect((await resolveTheme(themeName, 'shiki-js')).textmate?.bg).toBe('#101010');
  });

  it('keeps the React hook on fallback until the lazy custom theme registration finishes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | undefined = createRoot(container);

    try {
      flushSync(() => {
        root?.render(
          createElement(
            ThemeProvider,
            {
              defaultTheme: 'dark',
              storageKey: 'diff-theme-registration-test-theme',
            },
            createElement(DiffThemeProbe)
          )
        );
      });

      const probe = container.querySelector<HTMLElement>('#diff-theme-probe');
      expect(probe?.dataset.diffThemeName).toBe('');

      await act(async () => {
        const theme = await getBundledVSCodeThemeById('vesper');
        if (!theme) throw new Error('Vesper fixture is missing');
        await registerLodyVSCodeThemeForDiffs(theme);
      });

      expect(probe?.dataset.diffThemeName).toBe('lody-vscode-vesper');
    } finally {
      flushSync(() => {
        root?.unmount();
      });
      root = undefined;
      container.remove();
      window.localStorage.clear();
    }
  });
});
