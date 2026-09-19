// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { DesktopPermissionModeButton } from '../src/components/sessions/desktop-run-config-menu';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';

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
          TooltipProvider,
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
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    return document.querySelector('[role="menu"]') as HTMLElement;
  };

  it('keeps the group label in sentence case and hides descriptions on the row', async () => {
    const menu = await openMenu();
    const label = [...menu.querySelectorAll('*')].find(
      (node) => node.childNodes.length === 1 && node.textContent === 'Permission'
    );
    expect(label).toBeDefined();
    expect(label?.className).toContain('normal-case');
    expect(menu.textContent).not.toContain('Requires approval');
    expect(menu.textContent).not.toContain('Exercise caution');
    const agent = [...menu.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes('Agent')
    );
    expect(agent?.textContent?.trim()).toBe('Agent');
  });
});
