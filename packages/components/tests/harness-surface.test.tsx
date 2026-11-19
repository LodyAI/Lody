// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Harness } from '../src/components/harness';
import { harness } from '../src/components/harness/store';

/**
 * The harness surface is one page of the settings dialog, and what it shows is
 * decided by state: no device is pairing, a paired device is setup, a finished
 * one is the pages. A surface that drew the provider list before anything was
 * paired — or forgot which device it was scoped to — is what these cases catch.
 */
// jsdom has no layout, and the surface measures the group its selection pill
// travels in. The observer only has to exist here; nothing is laid out.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

describe('harness surface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    harness.reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () =>
    act(async () => {
      root.render(<Harness />);
    });

  it('asks where the agent should run before anything is paired', async () => {
    await render();

    expect(container.textContent).toContain('Where should your agent run?');
    expect(container.textContent).toContain('This computer');
    expect(container.textContent).toContain('Remote machine');
    expect(container.textContent).toContain('Cloud sandbox');
  });

  it('walks the setup wizard until the profile is written', async () => {
    act(() => {
      harness.pair('local');
    });
    await render();

    expect(container.textContent).toContain('Connect a model provider');
    expect(container.textContent).toContain('Sign in to a provider');
    expect(container.textContent).toContain('/ 5');

    // The first step is the one that can be blocked: no provider, no continue.
    const next = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Continue')
    );
    expect(next?.disabled).toBe(true);
  });

  it('lists the providers a configured device can sign in to', async () => {
    act(() => {
      harness.pair('local');
      harness.connect('deepseek', 'key', 'ada@studio.dev');
      harness.finish();
    });
    await render();

    // The device the pages are scoped to rides in the pane header, and the
    // provider list is the page a person lands on.
    expect(container.textContent).toContain('MacBook Pro');
    expect(container.textContent).toContain('Subscriptions');
    expect(container.textContent).toContain('API keys');
    expect(container.textContent).toContain('API key');
  });
});
