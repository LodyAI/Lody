// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FocusScope,
  useFocusScopeSwitcher,
  useListKeyboardNavigation,
} from '../src/ui/focus-scope';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function ListScope({ id, interceptRight = false }: { id: string; interceptRight?: boolean }) {
  useListKeyboardNavigation({ scopeId: id });
  return (
    <FocusScope id={id}>
      <button type="button" data-id={`${id}-1`} data-scope-item="row">
        {id} 1
      </button>
      <button
        type="button"
        aria-current={id === 'middle' ? 'page' : undefined}
        data-id={`${id}-2`}
        data-scope-item="row"
        onKeyDown={(event) => {
          if (interceptRight && event.key === 'ArrowRight') event.preventDefault();
        }}
      >
        {id} 2
      </button>
    </FocusScope>
  );
}

function Harness({ interceptRight = false }: { interceptRight?: boolean }) {
  useFocusScopeSwitcher();
  return (
    <>
      <ListScope id="left" interceptRight={interceptRight} />
      <FocusScope id="content">
        <ListScope id="middle" />
        <ListScope id="right" />
      </FocusScope>
    </>
  );
}

function ModalHarness() {
  useFocusScopeSwitcher();
  return (
    <>
      <ListScope id="background" />
      <div role="dialog" data-state="open">
        <ListScope id="dialog-left" />
        <ListScope id="dialog-right" />
      </div>
    </>
  );
}

function DirectControlHarness() {
  useFocusScopeSwitcher();
  return (
    <>
      <FocusScope id="direct-left">
        <button type="button" data-testid="direct-control">
          Direct control
        </button>
      </FocusScope>
      <ListScope id="direct-right" />
    </>
  );
}

function press(target: HTMLElement, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
}

describe('focus-scope keyboard navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  it('moves only inside the active list and restores its item across scope switches', async () => {
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <Harness />
        </Provider>
      )
    );
    const left1 = container.querySelector<HTMLElement>('[data-id="left-1"]')!;
    const left2 = container.querySelector<HTMLElement>('[data-id="left-2"]')!;
    const middle1 = container.querySelector<HTMLElement>('[data-id="middle-1"]')!;
    const middle2 = container.querySelector<HTMLElement>('[data-id="middle-2"]')!;

    await act(async () => left1.focus());
    await act(async () => press(left1, 'Escape'));
    await act(async () => press(left1, 'ArrowDown'));
    expect(document.activeElement).toBe(left2);

    await act(async () => press(left2, 'ArrowRight'));
    expect(document.activeElement).toBe(middle2);
    await act(async () => press(middle2, 'ArrowUp'));
    expect(document.activeElement).toBe(middle1);

    await act(async () => press(middle1, 'ArrowLeft'));
    expect(document.activeElement).toBe(left2);
  });

  it('lets a scope-local handler keep a horizontal key', async () => {
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <Harness interceptRight />
        </Provider>
      )
    );
    const left2 = container.querySelector<HTMLElement>('[data-id="left-2"]')!;

    await act(async () => left2.focus());
    await act(async () => press(left2, 'ArrowRight'));
    expect(document.activeElement).toBe(left2);
  });

  it('skips disabled list items', async () => {
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <ListScope id="left" />
        </Provider>
      )
    );
    const first = container.querySelector<HTMLElement>('[data-id="left-1"]')!;
    const second = container.querySelector<HTMLButtonElement>('[data-id="left-2"]')!;
    second.disabled = true;

    await act(async () => first.focus());
    await act(async () => press(first, 'ArrowDown'));
    expect(document.activeElement).toBe(first);
  });

  it('keeps scope switching inside an open dialog', async () => {
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <ModalHarness />
        </Provider>
      )
    );
    const dialogLeft = container.querySelector<HTMLElement>('[data-id="dialog-left-1"]')!;
    const dialogRight = container.querySelector<HTMLElement>('[data-id="dialog-right-1"]')!;

    await act(async () => dialogLeft.focus());
    await act(async () => press(dialogLeft, 'ArrowLeft'));
    expect(document.activeElement).toBe(dialogLeft);
    await act(async () => press(dialogLeft, 'ArrowRight'));
    expect(document.activeElement).toBe(dialogRight);
  });

  it('restores a focused control even when it is not a list row', async () => {
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <DirectControlHarness />
        </Provider>
      )
    );
    const direct = container.querySelector<HTMLElement>('[data-testid="direct-control"]')!;
    const right = container.querySelector<HTMLElement>('[data-id="direct-right-1"]')!;

    await act(async () => direct.focus());
    await act(async () => press(direct, 'ArrowRight'));
    expect(document.activeElement).toBe(right);
    await act(async () => press(right, 'ArrowLeft'));
    expect(document.activeElement).toBe(direct);
  });
});
