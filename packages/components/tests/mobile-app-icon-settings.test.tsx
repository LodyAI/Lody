// @vitest-environment jsdom
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import {
  MobileAppIconSettings,
  type AppIconBridge,
  type AppIconState,
} from '../src/components/mobile/mobile-app-icon-settings';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('app icon settings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: string;
  let bridge: AppIconBridge;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    current = 'default';
    bridge = {
      icons: [
        { name: 'default', previewUrl: '/default.png' },
        { name: 'alternate', previewUrl: '/alternate.png' },
      ],
      getState: async () => ({ supported: true, name: current }),
      setIcon: async ({ name }) => {
        current = name;
        return { supported: true, name };
      },
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function button(label: string) {
    const found = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === label
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  }

  it('keeps the old selection and blocks overlapping changes until native completion', async () => {
    let finish!: (state: AppIconState) => void;
    bridge.setIcon = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await act(async () => root.render(<MobileAppIconSettings bridge={bridge} />));
    await act(async () => button('Icon 2').click());
    expect(button('Default').getAttribute('aria-pressed')).toBe('true');
    expect(button('Default').disabled).toBe(true);
    expect(button('Icon 2').disabled).toBe(true);
    await act(async () => finish({ supported: true, name: 'alternate' }));
    expect(button('Icon 2').getAttribute('aria-pressed')).toBe('true');
    expect(button('Default').disabled).toBe(false);
  });

  it('retains the installed selection on rejection and lets the user retry', async () => {
    bridge.setIcon = async () => {
      throw new Error('Native rejection');
    };
    await act(async () => root.render(<MobileAppIconSettings bridge={bridge} />));
    await act(async () => button('Icon 2').click());
    expect(button('Default').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    bridge.setIcon = async ({ name }) => ({ supported: true, name });
    await act(async () => button('Icon 2').click());
    expect(button('Icon 2').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('hides the picker when the native capability is absent or unsupported', async () => {
    await act(async () => root.render(<MobileAppIconSettings />));
    expect(container.textContent).toBe('');
    bridge.getState = async () => ({ supported: false, name: 'default' });
    await act(async () => root.render(<MobileAppIconSettings bridge={bridge} />));
    expect(container.textContent).toBe('');
  });
});
