// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionArmedProvider, useInteractionArm } from '../src/ui/interaction-arm';
import { Popover, PopoverContent, PopoverTrigger } from '../src/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../src/ui/tooltip';

let root: Root;
let container: HTMLDivElement;

function Row({ children }: { children: ReactNode }) {
  const { armed, armHandlers } = useInteractionArm();
  return (
    <InteractionArmedProvider value={armed}>
      <div data-testid="row" data-armed={armed} {...armHandlers}>
        {children}
      </div>
    </InteractionArmedProvider>
  );
}

function CopyButton() {
  return (
    <TooltipProvider>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <button type="button" className="copy" aria-label="Copy message">
            copy
          </button>
        </TooltipTrigger>
        <TooltipContent>Copy message</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const row = () => container.querySelector<HTMLElement>('[data-testid="row"]')!;
const copyButton = () => container.querySelector<HTMLButtonElement>('button.copy')!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // A hover-capable pointer: touch devices mount eagerly.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('interaction-armed overlays', () => {
  it('renders only the trigger until the row is entered, then the real tooltip', () => {
    act(() =>
      root.render(
        <Row>
          <CopyButton />
        </Row>
      )
    );
    expect(copyButton().getAttribute('aria-label')).toBe('Copy message');
    // Radix marks its triggers with their open state; the plain trigger has none.
    expect(copyButton().hasAttribute('data-state')).toBe(false);

    act(() => {
      // jsdom has no PointerEvent; React derives enter from `pointerover`.
      row().dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    expect(row().dataset.armed).toBe('true');
    expect(copyButton().getAttribute('data-state')).toBe('closed');
  });

  it('keeps the pressed trigger until its click is dispatched', () => {
    vi.useFakeTimers();
    let clicks = 0;
    act(() =>
      root.render(
        <Row>
          <TooltipProvider>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button type="button" className="copy" onClick={() => (clicks += 1)}>
                  copy
                </button>
              </TooltipTrigger>
              <TooltipContent>Copy message</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </Row>
      )
    );
    const pressed = copyButton();

    // A press with no pointer entry first (a row scrolled under a still
    // pointer): the focus it brings must not swap the node mid-press, or the
    // browser drops the click.
    act(() => {
      pressed.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      pressed.focus();
    });
    expect(row().dataset.armed).toBe('false');
    expect(copyButton()).toBe(pressed);

    act(() => {
      pressed.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
      pressed.click();
    });
    expect(clicks).toBe(1);
    expect(copyButton()).toBe(pressed);

    act(() => {
      vi.runAllTimers();
    });
    expect(row().dataset.armed).toBe('true');
    expect(copyButton().getAttribute('data-state')).toBe('closed');
    vi.useRealTimers();
  });

  it('hands a focus that armed the row back to the same trigger', () => {
    act(() =>
      root.render(
        <Row>
          <button type="button" className="first">
            first
          </button>
          <CopyButton />
        </Row>
      )
    );
    const before = copyButton();
    act(() => {
      before.focus();
    });

    expect(row().dataset.armed).toBe('true');
    // The trigger remounted under its Radix wrapper, and focus followed it.
    expect(copyButton()).not.toBe(before);
    expect(document.activeElement).toBe(copyButton());
  });

  it('mounts an overlay its owner opens even while the row is unarmed', () => {
    act(() =>
      root.render(
        <Row>
          <Popover open>
            <PopoverTrigger asChild>
              <button type="button">config</button>
            </PopoverTrigger>
            <PopoverContent>Run configuration</PopoverContent>
          </Popover>
        </Row>
      )
    );
    expect(document.body.textContent).toContain('Run configuration');
  });
});
