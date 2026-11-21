// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpCapabilityCacheEntry } from '@lody/shared';

import { ModelsPanel } from '../src/components/harness/panels';
import { harness } from '../src/components/harness/store';
import type { DeviceCapabilities } from '../src/components/harness/device-capabilities';

// The machine bridge is mocked at the boundary the panel reads: the resolved
// Sorbet target plus the ACP capability fold. The full <Harness/> surface —
// machine index, pairing sheet, settings chrome — is exercised by the shell's
// own consumers; this suite asserts the Models page's real-data mapping.
const capabilities = vi.hoisted(() => ({
  current: { status: 'ready', models: [] } as DeviceCapabilities,
}));
vi.mock('../src/components/harness/device-capabilities', () => ({
  useDeviceCapabilities: () => capabilities.current,
}));

const sorbetEntry = (overrides: Partial<AcpCapabilityCacheEntry>): AcpCapabilityCacheEntry => ({
  cliType: 'builtin',
  agentType: 'sorbet',
  modes: [],
  models: [],
  fetchedAt: 0,
  ...overrides,
});

const withCapabilities = (current: DeviceCapabilities) => {
  capabilities.current = current;
};

/**
 * The Models page draws what the agent's capability probe advertised — the
 * model pool, its group names and the effort ladder — never the drawn
 * catalogue. A page that fell back to `MODELS`, or drew a three-rung ladder
 * the agent does not offer, is what these cases exist to catch.
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

describe('harness models page', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    harness.reset();
    capabilities.current = { status: 'ready', models: [] };
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
      root.render(<ModelsPanel scope="profile" />);
    });

  it('draws the Models page from the probe, not the catalogue', async () => {
    withCapabilities({
      status: 'ready',
      capability: sorbetEntry({}),
      models: [
        { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5', meta: '200K' },
        { id: 'gateway/meridian-2', name: 'Meridian 2', group: 'Gateway' },
      ],
      modelOption: undefined,
      effortOption: {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'minimal', name: 'Minimal' },
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'Extra high' },
        ],
      },
    });
    await render();

    // Both model selects read the capability fold — and the effort Segmented
    // shows the agent's own ladder with its current rung selected, not the
    // catalogue's Low/Medium/High. The list stays closed, so the names ride
    // in the hidden listbox markup; the trigger's value text resolves them.
    const combobox = container.querySelector('[role="combobox"]') as HTMLElement;
    expect(combobox).toBeTruthy();
    await act(async () => {
      combobox.click();
    });
    const names = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map(
      (el) => el.textContent
    );
    expect(names.join('\n')).toContain('Claude Fable 5');
    expect(names).toContain('Meridian 2');
    // Group labels come from the option's own `group`, not a provider guess.
    expect(document.body.textContent).toContain('Gateway');
    const effort = [...container.querySelectorAll('[role="radio"]')].map((el) => el.textContent);
    expect(effort).toEqual(['Minimal', 'Low', 'High', 'Extra high']);
    expect(
      [...container.querySelectorAll('[role="radio"]')]
        .find((el) => el.textContent === 'High')
        ?.getAttribute('aria-checked')
    ).toBe('true');
    expect(container.textContent).not.toContain('DeepSeek Reasoner');
  });

  it('disables the effort ladder when the agent advertises none', async () => {
    withCapabilities({
      status: 'ready',
      capability: sorbetEntry({}),
      models: [{ id: 'anthropic/claude-fable-5', name: 'Claude Fable 5' }],
      modelOption: undefined,
      effortOption: undefined,
    });
    await render();

    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('Not advertised by this agent');
    for (const button of container.querySelectorAll('[role="radio"]')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('says what it can when the agent advertises no models', async () => {
    withCapabilities({
      status: 'ready',
      capability: sorbetEntry({}),
      models: [],
      modelOption: undefined,
      effortOption: undefined,
    });
    await render();

    expect(container.textContent).toContain('Connect a provider first');
  });
});
