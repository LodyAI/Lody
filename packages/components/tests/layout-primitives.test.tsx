// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CollapsibleCard,
  CollapsibleCardContent,
  CollapsibleCardHeader,
  CollapsibleCardTitle,
} from '../src/ui/collapsible-card';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('collapsible card public contracts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps the real toggle button connected to controlled open state and content visibility', () => {
    function ControlledCard() {
      const [open, setOpen] = useState(false);
      return (
        <CollapsibleCard open={open} onOpenChange={setOpen}>
          <CollapsibleCardHeader position="relative">
            <CollapsibleCardTitle>Synthetic section</CollapsibleCardTitle>
          </CollapsibleCardHeader>
          <CollapsibleCardContent data-testid="content">Visible while open</CollapsibleCardContent>
        </CollapsibleCard>
      );
    }
    act(() => root.render(<ControlledCard />));
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle section"]'
    )!;
    const trigger = container.querySelector('[aria-expanded]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="content"]')).toBeNull();
    act(() => toggle.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="content"]')?.textContent).toBe(
      'Visible while open'
    );
    act(() => toggle.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="content"]')).toBeNull();
  });
});
