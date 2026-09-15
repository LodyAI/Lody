// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';

import { conversationFontSizeAtom } from '../src/atoms/settings';
import { MobileAppearanceSettings } from '../src/components/mobile/mobile-appearance-settings';
import { AppearanceSettingsView } from '../src/components/settings/appearance-setting';
import type { Theme } from '../src/theme-provider';
import { initI18n } from '../src/i18n';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../src/ui/dialog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalScrollIntoView = Element.prototype.scrollIntoView;

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function AppearanceHarness({ isElectron }: { isElectron: boolean }) {
  const [theme, setTheme] = useState<Theme>('light');
  const [interfaceFontFamily, setInterfaceFontFamily] = useState('Atkinson Hyperlegible');
  const [terminalFontFamily, setTerminalFontFamily] = useState('Maple Mono');
  const [conversationFontSize, setConversationFontSize] = useState(14);
  const [fontSize, setFontSize] = useState(13);

  return (
    <AppearanceSettingsView
      theme={theme}
      onThemePreview={setTheme}
      onThemeCommit={setTheme}
      onThemeCancel={vi.fn()}
      conversationFontSize={conversationFontSize}
      onConversationFontSizeChange={setConversationFontSize}
      isElectron={isElectron}
      interfaceFontFamily={interfaceFontFamily}
      onInterfaceFontFamilyChange={setInterfaceFontFamily}
      terminalFontFamily={terminalFontFamily}
      onTerminalFontFamilyChange={setTerminalFontFamily}
      systemFontFamilies={['Atkinson Hyperlegible', 'Fira Code', 'Maple Mono', 'SF Mono']}
      systemFontLoadState="loaded"
      onSystemFontMenuOpen={vi.fn()}
      terminalFontSize={fontSize}
      onTerminalFontSizeChange={setFontSize}
    />
  );
}

describe('AppearanceSettingsView', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Element.prototype.scrollIntoView = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = originalScrollIntoView;
    root = undefined;
    container = undefined;
  });

  it('lets the user pick System in the theme selector', async () => {
    await act(async () => root?.render(<AppearanceHarness isElectron={false} />));

    const themeTrigger = Array.from(container?.querySelectorAll('button') ?? []).find((node) =>
      node.textContent?.includes('Light')
    );
    expect(themeTrigger).toBeTruthy();

    await act(async () => {
      themeTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const systemOption = Array.from(document.body.querySelectorAll('[data-preview-item]')).find(
      (node) => node.textContent?.includes('System')
    );
    expect(systemOption).toBeTruthy();

    await act(async () => {
      systemOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(themeTrigger?.textContent).toContain('System');
  });

  it('shows theme and language while hiding Electron-only settings outside Electron', async () => {
    await act(async () => root?.render(<AppearanceHarness isElectron={false} />));

    expect(container?.textContent).toContain('Conversation font size');
    expect(container?.textContent).toContain('Theme');
    expect(container?.textContent).toContain('Language');
    expect(container?.textContent).not.toContain('Interface font');
    expect(container?.textContent).not.toContain('Terminal');
  });

  it('updates the conversation font size readout while sliding', async () => {
    await act(async () => root?.render(<AppearanceHarness isElectron={false} />));

    const sizeInput = container?.querySelector<HTMLInputElement>(
      'input[type="range"][aria-label="Conversation font size"]'
    );
    expect(sizeInput?.value).toBe('2');

    await act(async () => {
      setInputValue(sizeInput!, '5');
    });

    expect(sizeInput?.value).toBe('5');
    expect(container?.querySelector('output')?.textContent).toBe('24 px');
    expect(
      container?.querySelector<HTMLElement>('[aria-label="Conversation preview"] p')?.style.fontSize
    ).toBe('24px');
  });

  it('persists mobile slider changes, including both limits, across remounts', async () => {
    const store = createStore();
    store.set(conversationFontSizeAtom, 14);
    const renderMobile = (settingsStore: ReturnType<typeof createStore>) => (
      <Provider store={settingsStore}>
        <MobileAppearanceSettings />
      </Provider>
    );
    await act(async () => root?.render(renderMobile(store)));

    const slider = container?.querySelector<HTMLInputElement>('input[type="range"]');
    expect(slider).toBeTruthy();
    for (const [index, size] of [
      [0, 8],
      [7, 32],
      [4, 20],
    ]) {
      await act(async () => setInputValue(slider!, String(index)));
      expect(store.get(conversationFontSizeAtom)).toBe(size);
      expect(
        container?.querySelector<HTMLElement>('[aria-label="Conversation preview"] p')?.style
          .fontSize
      ).toBe(`${size}px`);
      expect(container?.querySelector('output')?.textContent).toBe(`${size} px`);
      expect(JSON.parse(localStorage.getItem('lody-conversation-font-size')!)).toBe(size);
    }

    await act(async () => root?.render(null));
    await act(async () => root?.render(renderMobile(createStore())));
    expect(container?.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe('4');
    localStorage.removeItem('lody-conversation-font-size');
  });

  it('shows theme and language in mobile appearance settings without terminal settings', async () => {
    await act(async () => root?.render(<MobileAppearanceSettings />));

    expect(container?.textContent).toContain('Theme');
    expect(container?.textContent).toContain('Language');
    expect(container?.textContent).toContain('Conversation font size');
    expect(container?.textContent).not.toContain('Interface font');
    expect(container?.textContent).not.toContain('Terminal');
  });

  it('renders interface and terminal system font selectors in Electron', async () => {
    await act(async () => root?.render(<AppearanceHarness isElectron />));

    const sizeInput = container?.querySelector<HTMLInputElement>('input[aria-label="Font size"]');
    const preview = Array.from(container?.querySelectorAll('code') ?? []).find(
      (node) => node.textContent === 'npx lody daemon start'
    );

    const interfaceFontTrigger = Array.from(container?.querySelectorAll('button') ?? []).find(
      (node) => node.textContent?.includes('Atkinson Hyperlegible')
    );
    const terminalFontTrigger = Array.from(container?.querySelectorAll('button') ?? []).find(
      (node) => node.textContent?.includes('Maple Mono')
    );
    expect(container?.textContent).toContain('Interface font');
    expect(container?.textContent).not.toContain('Choose a font installed on this computer.');
    expect(interfaceFontTrigger).toBeTruthy();
    expect(terminalFontTrigger).toBeTruthy();
    expect(sizeInput).toBeTruthy();
    expect(preview).toBeTruthy();
    expect(preview?.parentElement?.style.fontFamily).toContain('Maple Mono');
    expect(preview?.style.fontFamily).toBe('inherit');
    expect(container?.textContent).toContain('$');

    await act(async () => {
      setInputValue(sizeInput!, '16');
    });
    expect(preview?.parentElement?.style.fontSize).toBe('16px');
  });

  it('keeps the font menu inside a settings dialog so the list can scroll', async () => {
    await act(async () =>
      root?.render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Appearance</DialogTitle>
            <DialogDescription>Electron appearance settings</DialogDescription>
            <AppearanceHarness isElectron />
          </DialogContent>
        </Dialog>
      )
    );

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const fontTrigger = Array.from(dialog?.querySelectorAll('button') ?? []).find((node) =>
      node.textContent?.includes('Atkinson Hyperlegible')
    );
    expect(dialog).toBeTruthy();
    expect(fontTrigger).toBeTruthy();

    await act(async () => {
      fontTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const searchInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search system fonts..."]'
    );
    expect(searchInput).toBeTruthy();
    expect(dialog?.contains(searchInput ?? null)).toBe(true);
  });
});
