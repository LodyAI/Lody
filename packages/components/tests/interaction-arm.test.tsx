// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionArmedProvider, useInteractionArm } from '../src/ui/interaction-arm';
import { ContextMenu, Popover, Tooltip } from '../src/ui/armed-overlays';

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
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger
          delay={0}
          render={<button type="button" className="copy" aria-label="Copy message" />}
        >
          copy
        </Tooltip.Trigger>
        <Tooltip.Content>Copy message</Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
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
    // Base UI marks its tooltip triggers; the plain trigger is only the button.
    expect(copyButton().hasAttribute('data-base-ui-tooltip-trigger')).toBe(false);
    expect(copyButton().hasAttribute('delay')).toBe(false);

    act(() => {
      // jsdom has no PointerEvent; React derives enter from `pointerover`.
      row().dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    expect(row().dataset.armed).toBe('true');
    expect(copyButton().hasAttribute('data-base-ui-tooltip-trigger')).toBe(true);
  });

  it('keeps the pressed trigger until its click is dispatched', () => {
    vi.useFakeTimers();
    let clicks = 0;
    act(() =>
      root.render(
        <Row>
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger
                delay={0}
                render={<button type="button" className="copy" onClick={() => (clicks += 1)} />}
              >
                copy
              </Tooltip.Trigger>
              <Tooltip.Content>Copy message</Tooltip.Content>
            </Tooltip.Root>
          </Tooltip.Provider>
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
    expect(copyButton().hasAttribute('data-base-ui-tooltip-trigger')).toBe(true);
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
    // The trigger remounted as Base UI's trigger, and focus followed it.
    expect(copyButton()).not.toBe(before);
    expect(document.activeElement).toBe(copyButton());
  });

  it('mounts an overlay its owner opens even while the row is unarmed', () => {
    act(() =>
      root.render(
        <Row>
          <Popover.Root open>
            <Popover.Trigger render={<button type="button" />}>config</Popover.Trigger>
            <Popover.Content>Run configuration</Popover.Content>
          </Popover.Root>
        </Row>
      )
    );
    expect(document.body.textContent).toContain('Run configuration');
  });

  it('keeps an unarmed context-menu region out of the layout and its menu unmounted', () => {
    act(() =>
      root.render(
        <Row>
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <a href="#ref" className="ref">
                ref
              </a>
            </ContextMenu.Trigger>
            <ContextMenu.Content>
              <ContextMenu.Item>Open reference</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>
        </Row>
      )
    );
    const region = container.querySelector<HTMLElement>('a.ref')!.parentElement!;
    expect(region.style.display).toBe('contents');
    expect(document.body.textContent).not.toContain('Open reference');
  });

  it("passes a trigger's own props to the plain element and drops Base UI's", () => {
    const onClick = vi.fn();
    act(() =>
      root.render(
        <Row>
          <Popover.Root>
            <Popover.Trigger
              openOnHover
              delay={100}
              aria-label="Run configuration"
              className="config"
              onClick={onClick}
              render={<button type="button" className="chip" />}
            >
              config
            </Popover.Trigger>
            <Popover.Content>Run configuration</Popover.Content>
          </Popover.Root>
        </Row>
      )
    );
    const trigger = container.querySelector<HTMLButtonElement>('button.chip')!;
    expect(trigger.className).toBe('chip config');
    expect(trigger.getAttribute('aria-label')).toBe('Run configuration');
    expect(trigger.hasAttribute('delay')).toBe(false);
    expect(trigger.hasAttribute('openonhover')).toBe(false);
    act(() => trigger.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
