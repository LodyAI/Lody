// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { DesktopPermissionModeButton } from '../src/components/sessions/desktop-run-config-menu';
import { initI18n } from '../src/i18n';
import { menuGroupLabelClassName } from '../src/ui/menu-styles';
import { Tooltip } from '@lody/ui/tooltip';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const modeOptions = [
  {
    value: 'read-only',
    label: 'Read-only',
    description: 'Requires approval to edit files and run commands.',
  },
  {
    value: 'agent',
    label: 'Agent',
    description: 'Read and edit files, and run commands.',
  },
  {
    value: 'agent-full-access',
    label: 'Full access',
    description:
      'Codex can edit files outside this workspace and run commands with network access.\nExercise caution when using.',
  },
];

describe('DesktopPermissionModeButton menu', () => {
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

  const openMenu = async () => {
    await act(async () => {
      root?.render(
        createElement(
          Tooltip.Provider,
          null,
          createElement(DesktopPermissionModeButton, {
            modeOptions,
            selectedModeId: 'agent',
            onModeChange: () => undefined,
          })
        )
      );
    });
    await act(async () => {
      container
        ?.querySelector('button[aria-label="Permission"]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    return document.querySelector('[role="menu"]') as HTMLElement;
  };

  it('lists options without a group label and hides descriptions on the row', async () => {
    const menu = await openMenu();
    // The trigger already carries the "Permission" label, so the menu must not
    // repeat it as a heading.
    const labelClasses = menuGroupLabelClassName.split(/\s+/).filter(Boolean);
    expect(labelClasses.length).toBeGreaterThan(0);
    const label = [...menu.querySelectorAll('*')].find((node) =>
      labelClasses.every((cls) => node.classList.contains(cls))
    );
    expect(label).toBeUndefined();
    expect(menu.textContent).not.toContain('Requires approval');
    expect(menu.textContent).not.toContain('Exercise caution');
    const agent = [...menu.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes('Agent')
    );
    expect(agent?.textContent?.trim()).toBe('Agent');
  });
});
