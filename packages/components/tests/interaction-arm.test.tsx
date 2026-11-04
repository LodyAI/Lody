// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionArmedProvider, useInteractionArm } from '../src/ui/interaction-arm';
import { Popover, Tooltip } from '../src/ui/armed-overlays';

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
});
