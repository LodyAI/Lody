// @vitest-environment jsdom

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { AcpBottomBarModeSelector } from '../src/components/shared/acp-inline-selector-group';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '../src/components/shared/acp-selector-options';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';

const selectors: AcpConfigOptionSelector[] = [
  {
    configId: 'fast-mode',
    label: 'Fast Mode',
    type: 'select',
    currentValue: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
  },
  {
    configId: 'plan_mode',
    label: 'Collaboration mode',
    category: 'plan_mode',
    type: 'boolean',
    currentValue: false,
    options: [],
  },
];

describe('AcpBottomBarModeSelector UI', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  function renderSelector(
    configOptionValues: Record<string, AcpConfigOptionValue>,
    options?: {
      selectors?: AcpConfigOptionSelector[];
      modeOptions?: Array<{ value: string; label: string }>;
      selectedModeId?: string;
      onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
    }
  ) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(
          TooltipProvider,
          null,
          createElement(AcpBottomBarModeSelector, {
            tone: 'light',
            configOptionSelectors: options?.selectors ?? selectors,
            configOptionValues,
            modeOptions: options?.modeOptions,
            selectedModeId: options?.selectedModeId,
            onConfigOptionChange: options?.onConfigOptionChange ?? vi.fn(),
          })
        )
      );
    });
  }

  it('uses highlighted active styling for fast mode and labels the plan toggle Plan', () => {
    renderSelector({ 'fast-mode': 'on', plan_mode: true });

    const fastModeButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Fast Mode"]'
    );
    const planModeButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Collaboration mode"]'
    );

    expect(fastModeButton?.className).toContain('bg-primary/[0.12]');
    expect(planModeButton?.textContent).toBe('Plan');
    expect(planModeButton?.className).not.toContain('border');
    expect(
      planModeButton && fastModeButton
        ? (planModeButton.compareDocumentPosition(fastModeButton) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
            0
        : false
    ).toBe(true);
  });

  it('renders on/off select fast options as the fast toggle and writes the next select value', () => {
    const onChange = vi.fn();
    renderSelector(
      { fast: 'on' },
      {
        selectors: [
          {
            configId: 'fast',
            label: 'Fast mode',
            type: 'select',
            currentValue: 'on',
            options: [
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ],
          },
        ],
        onConfigOptionChange: onChange,
      }
    );

    const fastModeButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Fast mode"]'
    );

    expect(fastModeButton?.className).toContain('bg-primary/[0.12]');
    fastModeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('fast', 'off');
  });

  it('shows an explicit permission selector instead of the provider interaction modes', () => {
    renderSelector(
      { permission_mode: 'ask' },
      {
        modeOptions: [
          { value: 'agent', label: 'Agent' },
          { value: 'plan', label: 'Plan' },
        ],
        selectedModeId: 'agent',
        selectors: [
          {
            configId: 'interaction_mode',
            label: 'Interaction Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'agent',
            options: [
              { value: 'agent', label: 'Agent' },
              { value: 'plan', label: 'Plan' },
            ],
          },
          {
            configId: 'permission_mode',
            label: 'Permission Mode',
            category: '_permission',
            type: 'select',
            currentValue: 'ask',
            options: [
              { value: 'ask', label: 'Ask Every Time' },
              { value: 'always-approve', label: 'Always Approve' },
            ],
          },
        ],
      }
    );

    const permissionButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Permission Mode"]'
    );
    expect(permissionButton?.textContent).toContain('Ask Every Time');
    expect(container?.textContent).not.toContain('Agent');
  });
});
