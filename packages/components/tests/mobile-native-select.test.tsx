// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileNativeSelect } from '../src/components/mobile/mobile-native-select';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('MobileNativeSelect', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('uses a backgroundless native select and reports native changes', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <MobileNativeSelect
          value="machine-1"
          onChange={onChange}
          options={[
            { value: 'machine-1', label: 'Machine 1' },
            { value: 'machine-2', label: 'Machine 2' },
          ]}
          triggerContent={<span>Machine 1</span>}
          ariaLabel="Machine"
        />
      );
    });

    const select = container.querySelector('select');
    expect(select).toBeInstanceOf(HTMLSelectElement);
    expect(select?.closest('div')?.className).not.toMatch(/\bbg-/);
    expect(container.querySelector('svg.lucide-chevrons-up-down')).not.toBeNull();

    await act(async () => {
      if (!select) return;
      select.value = 'machine-2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('machine-2');
  });

  it('hides and disables selection when the current value is the only choice', async () => {
    await act(async () => {
      root.render(
        <MobileNativeSelect
          value="machine-1"
          onChange={() => undefined}
          options={[{ value: 'machine-1', label: 'Machine 1' }]}
          triggerContent={<span>Machine 1</span>}
          ariaLabel="Machine"
        />
      );
    });

    const select = container.querySelector('select');
    expect(select?.disabled).toBe(true);
    expect(select?.className).toContain('outline-none');
    expect(container.querySelector('svg.lucide-chevrons-up-down')).toBeNull();
    expect(select?.closest('div')?.className).not.toMatch(/\b(?:border|ring)-/);
  });

  it('can hide the visual indicator without disabling the native select', async () => {
    await act(async () => {
      root.render(
        <MobileNativeSelect
          value="project-1"
          onChange={() => undefined}
          options={[
            { value: 'project-1', label: 'Project 1' },
            { value: 'project-2', label: 'Project 2' },
          ]}
          triggerContent={<span>Project 1</span>}
          ariaLabel="Project"
          showIndicator={false}
        />
      );
    });

    expect(container.querySelector('select')?.disabled).toBe(false);
    expect(container.querySelector('svg.lucide-chevrons-up-down')).toBeNull();
  });

  it('renders grouped options with native optgroups', async () => {
    await act(async () => {
      root.render(
        <MobileNativeSelect
          value="local:lody"
          onChange={() => undefined}
          options={[
            { value: 'local:lody', label: 'Lody', group: 'Local' },
            { value: 'github:lody', label: 'LodyAI/Lody', group: 'GitHub' },
          ]}
          triggerContent={<span>Lody</span>}
          ariaLabel="Project"
        />
      );
    });

    const groups = Array.from(container.querySelectorAll('optgroup'));
    expect(groups.map((group) => group.label)).toEqual(['Local', 'GitHub']);
    expect(groups.map((group) => group.querySelector('option')?.textContent)).toEqual([
      'Lody',
      'LodyAI/Lody',
    ]);
  });
});
