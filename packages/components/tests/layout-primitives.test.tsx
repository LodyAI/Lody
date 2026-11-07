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

  it('preserves caller inline styles on the root, header, title and scrolling content', () => {
    act(() => {
      root.render(
        <CollapsibleCard defaultOpen data-testid="card" style={{ maxWidth: 430 }}>
          <CollapsibleCardHeader data-testid="header" style={{ height: 37 }}>
            <CollapsibleCardTitle data-testid="title" style={{ color: 'rgb(12, 34, 56)' }}>
              Synthetic title
            </CollapsibleCardTitle>
          </CollapsibleCardHeader>
          <CollapsibleCardContent data-testid="content" style={{ paddingBottom: 3 }}>
            Synthetic content
          </CollapsibleCardContent>
        </CollapsibleCard>
      );
    });

    const element = (testId: string) =>
      container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
    expect(element('card').style.maxWidth).toBe('430px');
    expect(element('header').style.height).toBe('37px');
    expect(element('title').style.color).toBe('rgb(12, 34, 56)');
    expect(element('content').style.paddingBottom).toBe('3px');
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
