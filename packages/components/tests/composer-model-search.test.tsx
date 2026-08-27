// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import {
  getAgentConfigRoomId,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineId,
} from '@lody/shared';

// The menu resolves its default agent pool from machine presence; these
// surfaces pass their agent in explicitly, so the pool is not under test.
vi.mock('../src/hooks/use-online-machines', () => ({ useOnlineMachines: () => [] }));

import { agentConfigMetaCacheAtom } from '../src/atoms/doc-meta';
import { DesktopRunConfigMenu } from '../src/components/sessions/desktop-run-config-menu';
import { MobileRunConfigSheet } from '../src/components/mobile/mobile-run-config-sheet';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, so nothing can be scrolled into view.
Element.prototype.scrollIntoView = () => undefined;

const machineId = 'machine-1' as MachineId;
const agentConfig: AgentConfigMeta = {
  id: 'config-1' as AgentConfigId,
  machineId,
  name: 'Codex',
  description: undefined,
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
};
const deepseekAgentConfig: AgentConfigMeta = {
  ...agentConfig,
  id: 'config-deepseek' as AgentConfigId,
  name: 'DeepSeek Harness',
  agentType: 'deepseek',
};
const deepseekModels = [
  { value: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
];

/* A provider that publishes far more models than a list can be scanned for —
   the case the search field exists for. */
const manyModels = [
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' },
  { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
  { value: 'grok-4', label: 'Grok 4' },
  { value: 'kimi-k2', label: 'Kimi K2' },
];
const fewModels = manyModels.slice(0, 2);

const typeInto = async (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('composer model picker search', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = undefined;
    }
    container?.remove();
    container = undefined;
  });

  /* ── Desktop: the run-config dropdown's Model submenu ── */

  type MenuProps = ComponentProps<typeof DesktopRunConfigMenu>;
  const desktopProps: MenuProps = {
    agentSelection: { agentId: agentConfig.id, machineId },
    availableAgentConfigs: [agentConfig],
    modelOptions: manyModels,
    selectedModelId: 'claude-sonnet-5',
    onModelChange: () => undefined,
    configOptionSelectors: [],
    configOptionValues: {},
    onConfigOptionChange: () => undefined,
  };

  const openModelSubmenu = async (props: Partial<MenuProps> = {}) => {
    await act(async () => {
      root?.render(createElement(DesktopRunConfigMenu, { ...desktopProps, ...props }));
    });
    // Radix opens the menu on pointerdown, not click.
    await act(async () => {
      container
        ?.querySelector('button[aria-label="Run configuration"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const modelRow = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.trim().startsWith('Model')
    );
    await act(async () => {
      (modelRow as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
    return {
      search,
      // The submenu's own rows: the parent menu's Model/Agent rows are in a
      // different content element.
      rows: () => {
        const submenu = search
          ? search.closest('[data-radix-menu-content]')
          : [...document.querySelectorAll('[data-radix-menu-content]')].at(-1);
        return [...(submenu?.querySelectorAll('[role="menuitemradio"]') ?? [])].map((node) =>
          node.textContent?.trim()
        );
      },
    };
  };

  it('opens the Model submenu with every model and a way to search them', async () => {
    const { search, rows } = await openModelSubmenu();
    expect(search).not.toBeNull();
    expect(rows()).toHaveLength(manyModels.length);
  });

  it('narrows the list to fuzzy matches as the user types', async () => {
    const { search, rows } = await openModelSubmenu();
    // Not a substring of the label OR the id — a subsequence of both.
    await typeInto(search as HTMLInputElement, 'op5');
    expect(rows()).toEqual(['Opus 5']);
  });

  it('finds a model by its id, which the row does not even show', async () => {
    const { search, rows } = await openModelSubmenu();
    await typeInto(search as HTMLInputElement, 'haiku-4');
    expect(rows()).toEqual(['Haiku 4.5']);
  });

  it('says so when nothing matches instead of showing an empty menu', async () => {
    const { search, rows } = await openModelSubmenu();
    await typeInto(search as HTMLInputElement, 'zzz');
    expect(rows()).toEqual([]);
    const submenu = (search as HTMLInputElement).closest('[data-radix-menu-content]');
    expect(submenu?.textContent).toContain('No models match');
  });

  it('takes the top match on Enter, so a search never needs the mouse', async () => {
    const onModelChange = vi.fn();
    const { search } = await openModelSubmenu({ onModelChange });
    await typeInto(search as HTMLInputElement, 'grok');
    await act(async () => {
      (search as HTMLInputElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });
    expect(onModelChange).toHaveBeenCalledWith('grok-4');
  });

  it('moves into the list on ArrowDown, since the field is not a menu row', async () => {
    const { search } = await openModelSubmenu();
    await act(async () => {
      (search as HTMLInputElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      );
    });
    const submenu = (search as HTMLInputElement).closest('[data-radix-menu-content]');
    expect(document.activeElement).toBe(submenu?.querySelector('[role="menuitemradio"]'));
  });

  /* The pointer moving over the list takes focus off the field (Radix focuses
     the row under the cursor). Typing then has to keep filtering — otherwise it
     drives the menu's own typeahead and the search box looks broken. */
  it('keeps typing in the search field when focus has moved onto a row', async () => {
    const { search, rows } = await openModelSubmenu();
    const submenu = (search as HTMLInputElement).closest('[data-radix-menu-content]');
    const firstRow = submenu?.querySelector<HTMLElement>('[role="menuitemradio"]');
    await act(async () => {
      firstRow?.focus();
      firstRow?.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    });
    expect((search as HTMLInputElement).value).toBe('k');
    expect(rows()[0]).toBe('Kimi K2');
    expect(rows()).not.toContain('Opus 5');
    expect(document.activeElement).toBe(search);
  });

  it('leaves a short list alone — a search field there costs more than it saves', async () => {
    const { search, rows } = await openModelSubmenu({
      modelOptions: fewModels,
      selectedModelId: fewModels[0]?.value ?? null,
    });
    expect(search).toBeNull();
    expect(rows()).toHaveLength(fewModels.length);
  });

  it('links the upstream delegation warning for a builtin DeepSeek non-Pro model', async () => {
    await act(async () => {
      root?.render(
        createElement(DesktopRunConfigMenu, {
          ...desktopProps,
          agentSelection: { agentId: deepseekAgentConfig.id, machineId },
          availableAgentConfigs: [deepseekAgentConfig],
          modelOptions: deepseekModels,
          selectedModelId: 'deepseek-v4-flash',
        })
      );
    });
    await act(async () => {
      container
        ?.querySelector('button[aria-label="Run configuration"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    const warning = document.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/deepseek-ai/deepseek-harness/discussions/4065"]'
    );
    expect(warning?.textContent).toContain('delegated subagents may use');
    expect(warning?.textContent).toContain('Upstream discussion');
  });

  it('does not warn when the builtin DeepSeek session already uses Pro', async () => {
    await act(async () => {
      root?.render(
        createElement(DesktopRunConfigMenu, {
          ...desktopProps,
          agentSelection: { agentId: deepseekAgentConfig.id, machineId },
          availableAgentConfigs: [deepseekAgentConfig],
          modelOptions: deepseekModels,
          selectedModelId: 'deepseek-v4-pro',
        })
      );
    });
    await act(async () => {
      container
        ?.querySelector('button[aria-label="Run configuration"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    expect(
      document.querySelector(
        'a[href="https://github.com/deepseek-ai/deepseek-harness/discussions/4065"]'
      )
    ).toBeNull();
  });

  /* ── Mobile: the same rule inside the run-config sheet ── */

  type SheetProps = ComponentProps<typeof MobileRunConfigSheet>;
  const mobileProps: SheetProps = {
    open: true,
    onOpenChange: () => undefined,
    agentSelection: { agentId: agentConfig.id, machineId },
    allowedMachineIds: [machineId],
    onAgentConfigChange: () => undefined,
    modelOptions: manyModels,
    selectedModelId: 'claude-sonnet-5',
    onModelChange: () => undefined,
    modeOptions: [],
    selectedModeId: null,
    onModeChange: () => undefined,
    configOptionSelectors: [],
    configOptionValues: {},
    onConfigOptionChange: () => undefined,
  };

  const openMobileModelPicker = async (props: Partial<SheetProps> = {}) => {
    const store = createStore();
    store.set(agentConfigMetaCacheAtom, { [getAgentConfigRoomId(agentConfig.id)]: agentConfig });
    await act(async () => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(MobileRunConfigSheet, { ...mobileProps, ...props })
        )
      );
    });
    await act(async () => {
      document.querySelector<HTMLElement>('button[aria-label="Model"]')?.click();
    });
    const list = document.querySelector('[role="listbox"][aria-label="Model"]');
    return {
      search: list?.querySelector<HTMLInputElement>('input[aria-label="Search models"]') ?? null,
      rows: () =>
        [...(list?.querySelectorAll('[role="option"]') ?? [])].map((node) =>
          node.textContent?.trim()
        ),
    };
  };

  it('offers the same search in the mobile sheet, matching fuzzily', async () => {
    const { search, rows } = await openMobileModelPicker();
    expect(search).not.toBeNull();
    expect(rows()).toHaveLength(manyModels.length);

    await typeInto(search as HTMLInputElement, 'gem3');
    expect(rows()).toEqual(['Gemini 3 Pro']);
  });

  it('names its empty state on mobile too', async () => {
    const { search, rows } = await openMobileModelPicker();
    await typeInto(search as HTMLInputElement, 'zzz');
    expect(rows()).toEqual([]);
    expect(document.querySelector('[role="listbox"][aria-label="Model"]')?.textContent).toContain(
      'No models match'
    );
  });

  /* The field declines `type="search"` precisely so the browser draws no cancel
     glyph of its own; this is the one we draw. */
  it('clears the mobile search from a button of our own, keeping the field focused', async () => {
    const { search, rows } = await openMobileModelPicker();
    await typeInto(search as HTMLInputElement, 'gem3');
    expect(rows()).toHaveLength(1);

    const list = document.querySelector('[role="listbox"][aria-label="Model"]');
    const clear = list?.querySelector<HTMLElement>('button[aria-label="Clear"]');
    expect(clear).not.toBeNull();
    await act(async () => {
      clear?.click();
    });
    expect((search as HTMLInputElement).value).toBe('');
    expect(rows()).toHaveLength(manyModels.length);
    // Blurring here would drop the soft keyboard the user is still typing on.
    expect(document.activeElement).toBe(search);
    // The button is only there while there is something to clear.
    expect(list?.querySelector('button[aria-label="Clear"]')).toBeNull();
  });

  it('leaves a short mobile list without a search field', async () => {
    const { search } = await openMobileModelPicker({
      modelOptions: fewModels,
      selectedModelId: fewModels[0]?.value ?? null,
    });
    expect(search).toBeNull();
  });

  it('shows the linked DeepSeek delegation warning in the mobile sheet', async () => {
    const store = createStore();
    store.set(agentConfigMetaCacheAtom, {
      [getAgentConfigRoomId(deepseekAgentConfig.id)]: deepseekAgentConfig,
    });
    await act(async () => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(MobileRunConfigSheet, {
            ...mobileProps,
            agentSelection: { agentId: deepseekAgentConfig.id, machineId },
            modelOptions: deepseekModels,
            selectedModelId: 'deepseek-v4-flash',
          })
        )
      );
    });

    const warning = document.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/deepseek-ai/deepseek-harness/discussions/4065"]'
    );
    expect(warning?.textContent).toContain('delegated subagents may use');
    expect(warning?.textContent).toContain('Upstream discussion');
  });
});
