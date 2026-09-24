// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, Provider } from 'jotai';

import { conversationFontSizeAtom } from '../src/atoms/settings';
import { MobileAppearanceSettings } from '../src/components/mobile/mobile-appearance-settings';
import type { AppIconBridge } from '../src/components/mobile/mobile-app-icon-settings';
import { AppearanceSettingsView } from '../src/components/settings/appearance-setting';
import type { Theme } from '../src/theme-provider';
import { initI18n } from '../src/i18n';
import { Dialog } from '../src/ui/dialog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalScrollIntoView = Element.prototype.scrollIntoView;

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

/** Base UI defers part of opening a popup to a frame that `act` does not flush. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 2; index += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
  });
}

/** The pointer arriving and pressing: a Select opens on the click, a row is picked where it moved. */
async function pointerClick(element: Element): Promise<void> {
  const init = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', detail: 1 };
  await act(async () => {
    element.dispatchEvent(new TestPointerEvent('pointermove', init));
    element.dispatchEvent(new TestPointerEvent('pointerdown', init));
    element.dispatchEvent(new MouseEvent('mousedown', init));
    (element as HTMLElement).focus();
    element.dispatchEvent(new TestPointerEvent('pointerup', init));
    element.dispatchEvent(new MouseEvent('mouseup', init));
    (element as HTMLElement).click();
  });
  await settle();
}

/** The rows of the open list; a closed Select keeps its rows mounted under `[hidden]`. */
function visibleOptions(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).filter(
    (node) => !node.closest('[hidden]')
  );
}

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
  const [fontLigaturesEnabled, setFontLigaturesEnabled] = useState(true);

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
      fontLigaturesEnabled={fontLigaturesEnabled}
      onFontLigaturesEnabledChange={setFontLigaturesEnabled}
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
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    delete window.__LODY_APP_ICON__;
    vi.unstubAllGlobals();
    Element.prototype.scrollIntoView = originalScrollIntoView;
    root = undefined;
    container = undefined;
  });

  it('lets the user pick System in the theme selector', async () => {
    await act(async () => root?.render(<AppearanceHarness isElectron={false} />));

    const themeTrigger = container?.querySelector<HTMLElement>('[aria-label="Theme"]');
    expect(themeTrigger?.textContent).toContain('Light');

    await pointerClick(themeTrigger!);
    const systemOption = visibleOptions().find((node) => node.textContent?.includes('System'));
    expect(systemOption).toBeTruthy();

    await pointerClick(systemOption!);
    expect(themeTrigger?.textContent).toContain('System');
  });

  it('previews the highlighted theme and hands the original back when closed without a pick', async () => {
    const onThemePreview = vi.fn();
    const onThemeCommit = vi.fn();
    const onThemeCancel = vi.fn();
    await act(async () =>
      root?.render(
        <AppearanceSettingsView
          theme="light"
          onThemePreview={onThemePreview}
          onThemeCommit={onThemeCommit}
          onThemeCancel={onThemeCancel}
          conversationFontSize={14}
          onConversationFontSizeChange={vi.fn()}
          isElectron={false}
          interfaceFontFamily=""
          onInterfaceFontFamilyChange={vi.fn()}
          terminalFontFamily=""
          onTerminalFontFamilyChange={vi.fn()}
          systemFontFamilies={[]}
          systemFontLoadState="loaded"
          onSystemFontMenuOpen={vi.fn()}
          terminalFontSize={13}
          onTerminalFontSizeChange={vi.fn()}
        />
      )
    );

    const themeTrigger = container?.querySelector<HTMLElement>('[aria-label="Theme"]');
    await pointerClick(themeTrigger!);
    // Base UI moves focus onto the highlighted row; that focus is the preview.
    const dark = visibleOptions().find((node) => node.textContent?.includes('Dark'));
    await act(async () => dark?.focus());
    expect(onThemePreview).toHaveBeenLastCalledWith('dark');

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    });
    await settle();
    expect(themeTrigger?.getAttribute('aria-expanded')).toBe('false');
    expect(onThemeCancel).toHaveBeenCalledTimes(1);
    expect(onThemeCommit).not.toHaveBeenCalled();
  });

  it('shows theme and language while hiding Electron-only settings outside Electron', async () => {
    await act(async () => root?.render(<AppearanceHarness isElectron={false} />));

    expect(container?.textContent).toContain('Font size');
    expect(container?.textContent).toContain('Theme');
    expect(container?.textContent).toContain('Language');
    expect(container?.textContent).not.toContain('Interface font');
    expect(container?.textContent).not.toContain('Terminal');
    expect(container?.textContent).toContain('Font ligatures');
    expect(container?.textContent).toContain('conversation, code, and tool output');
    const ligaturesSwitch = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Font ligatures"]'
    );
    expect(ligaturesSwitch?.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      ligaturesSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container?.querySelector('button[aria-label="Font ligatures"]')?.getAttribute('aria-checked')
    ).toBe('false');
  });

  it('offers the five named font size tiers and commits the picked one', async () => {
    await act(async () => root?.render(<AppearanceHarness isElectron={false} />));

    const sizeTrigger = container?.querySelector<HTMLElement>('[aria-label="Font size"]');
    expect(sizeTrigger?.textContent).toContain('Default');

    await pointerClick(sizeTrigger!);
    const items = visibleOptions();
    expect(items.map((node) => node.textContent)).toEqual([
      'Smaller',
      'Small',
      'Default',
      'Large',
      'Larger',
    ]);

    const larger = items.find((node) => node.textContent === 'Larger');
    await pointerClick(larger!);
    expect(sizeTrigger?.textContent).toContain('Larger');
  });

  it('persists mobile font size picks, including both limits, across remounts', async () => {
    const store = createStore();
    store.set(conversationFontSizeAtom, 14);
    const renderMobile = (settingsStore: ReturnType<typeof createStore>) => (
      <Provider store={settingsStore}>
        <MobileAppearanceSettings />
      </Provider>
    );
    await act(async () => root?.render(renderMobile(store)));

    const pickSize = async (label: string) => {
      const trigger = container?.querySelector<HTMLButtonElement>('button[aria-label="Font size"]');
      expect(trigger).toBeTruthy();
      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const option = Array.from(
        container?.querySelectorAll<HTMLButtonElement>('[role="option"] button') ?? []
      ).find((node) => node.textContent?.includes(label));
      expect(option).toBeTruthy();
      await act(async () => {
        option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    };

    for (const [label, size] of [
      ['Smaller', 12],
      ['Larger', 16],
      ['Default', 14],
    ]) {
      await pickSize(label!);
      expect(store.get(conversationFontSizeAtom)).toBe(size);
      expect(JSON.parse(localStorage.getItem('lody-conversation-font-size')!)).toBe(size);
      expect(container?.querySelector('button[aria-label="Font size"]')?.textContent).toContain(
        label
      );
    }

    await act(async () => root?.render(null));
    await act(async () => root?.render(renderMobile(createStore())));
    expect(container?.querySelector('button[aria-label="Font size"]')?.textContent).toContain(
      'Default'
    );
    localStorage.removeItem('lody-conversation-font-size');
  });

  it('shows theme and language in mobile appearance settings without terminal settings', async () => {
    await act(async () => root?.render(<MobileAppearanceSettings />));

    expect(container?.textContent).toContain('Theme');
    expect(container?.textContent).toContain('Language');
    expect(container?.textContent).toContain('Font size');
    expect(container?.textContent).not.toContain('Interface font');
    expect(container?.textContent).not.toContain('Terminal');
    expect(container?.textContent).toContain('Font ligatures');
    expect(container?.textContent).toContain('conversation, code, and tool output');
    const ligaturesSwitch = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Font ligatures"]'
    );
    expect(ligaturesSwitch?.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      ligaturesSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container?.querySelector('button[aria-label="Font ligatures"]')?.getAttribute('aria-checked')
    ).toBe('false');
  });

  it('places native app icon selection below font size in narrow and wide appearance layouts', async () => {
    const bridge: AppIconBridge = {
      icons: [
        { name: 'default', previewUrl: '/default.png' },
        { name: 'alternate', previewUrl: '/alternate.png' },
      ],
      getState: async () => ({ supported: true, name: 'default' }),
      setIcon: async ({ name }) => ({ supported: true, name }),
    };
    window.__LODY_APP_ICON__ = bridge;

    const expectIconAfterFontSize = () => {
      const content = container?.textContent ?? '';
      expect(content).toContain('App icon');
      expect(content.indexOf('App icon')).toBeGreaterThan(content.indexOf('Font size'));
    };

    await act(async () => root?.render(<MobileAppearanceSettings />));
    expectIconAfterFontSize();

    await act(async () => root?.render(<AppearanceHarness isElectron={false} />));
    expectIconAfterFontSize();
  });

  it('renders interface and terminal system font selectors in Electron', async () => {
    await act(async () => root?.render(<AppearanceHarness isElectron />));

    const sizeInput = container?.querySelector<HTMLInputElement>('input[aria-label="Font size"]');
    const preview = Array.from(container?.querySelectorAll('code') ?? []).find(
      (node) => node.textContent === 'npx lody daemon start'
    );

    // Each font opens like the selects above it and names the family it holds.
    const interfaceFontTrigger = container?.querySelector<HTMLElement>(
      'button[aria-label="Interface font"]'
    );
    const terminalFontTrigger = container?.querySelector<HTMLElement>('button[aria-label="Font"]');
    expect(container?.textContent).toContain('Interface font');
    expect(container?.textContent).not.toContain('Choose a font installed on this computer.');
    expect(interfaceFontTrigger?.textContent).toContain('Atkinson Hyperlegible');
    expect(terminalFontTrigger?.textContent).toContain('Maple Mono');
    expect(sizeInput).toBeTruthy();
    expect(preview).toBeTruthy();
    // The preview line's face and size are StyleX function styles: the value
    // rides the line's inline style as a custom property, not as `font-family`.
    expect(preview?.parentElement?.getAttribute('style')).toContain('Maple Mono');
    expect(container?.textContent).toContain('$');
    expect(container?.textContent).toContain('Font ligatures');
    expect(container?.textContent).toContain('conversation, code, and tool output');
    const content = container?.textContent ?? '';
    expect(content.indexOf('Font ligatures')).toBeGreaterThan(content.indexOf('Terminal'));

    const ligaturesSwitch = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Font ligatures"]'
    );
    expect(ligaturesSwitch?.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      ligaturesSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      container?.querySelector('button[aria-label="Font ligatures"]')?.getAttribute('aria-checked')
    ).toBe('false');

    await act(async () => {
      setInputValue(sizeInput!, '16');
    });
    expect(preview?.parentElement?.getAttribute('style')).toContain('16px');
  });

  it('keeps the font menu inside a settings dialog so the list can scroll', async () => {
    await act(async () =>
      root?.render(
        <Dialog.Root open>
          <Dialog.Content>
            <Dialog.Title>Appearance</Dialog.Title>
            <Dialog.Description>Electron appearance settings</Dialog.Description>
            <AppearanceHarness isElectron />
          </Dialog.Content>
        </Dialog.Root>
      )
    );

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    const openFonts = dialog?.querySelector<HTMLElement>('button[aria-label="Interface font"]');
    expect(dialog).toBeTruthy();
    expect(openFonts).toBeTruthy();

    await pointerClick(openFonts!);

    // The list mounts into the dialog's own panel, so the dialog's scroll lock
    // does not swallow the wheel over it.
    const fonts = visibleOptions();
    expect(fonts.map((node) => node.textContent)).toContain('Fira Code');
    expect(fonts.every((node) => dialog?.contains(node))).toBe(true);
    // The search the list opens with is inside the same popup.
    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search system fonts..."]'
    );
    expect(dialog?.contains(search ?? null)).toBe(true);
  });
});
