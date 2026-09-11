import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom implements neither `PointerEvent` nor `Element.scrollIntoView`, and
 * Base UI's popups reach for both while opening. Installed once per module so
 * every suite here drives a control the way a browser would rather than around
 * the parts jsdom is missing.
 */
class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  readonly pointerId: number;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    // The spec's default is the empty string, and Base UI reads exactly that to
    // tell a keyboard-generated click from a mouse one: a stand-in that defaults
    // to `mouse` makes every synthesized Enter look like a stray pointer click
    // and the item refuses to commit.
    this.pointerType = init.pointerType ?? '';
    this.pointerId = 1;
  }
}

if (!('PointerEvent' in globalThis)) {
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

export interface Mounted {
  container: HTMLElement;
  root: Root;
  unmount: () => Promise<void>;
}

/** Renders a tree into a live document and hands back the node it went into. */
export async function mount(ui: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/**
 * Waits for animation frames to run. Base UI defers part of opening a popup to
 * one, and `act` flushes React's own work but not the frame queue, so without
 * this an interaction that follows lands between a popup being asked to open
 * and its opening — and the deferred frame then undoes what the second
 * interaction did.
 */
async function frames(count = 2): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

/** Runs an interaction and lets every effect and frame it schedules settle. */
export async function step(run: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await run();
    await frames();
  });
}

/** The pointer moving onto something, which is what highlights a list row. */
export async function hover(element: Element): Promise<void> {
  await step(() => {
    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
}

/**
 * The pointer arriving and pressing, in full. Every part of the sequence is
 * load-bearing here: a list row is picked where the pointer moved, a Select
 * opens on the click and a Combobox on the mousedown, so a shortcut that fires
 * only one of them silently tests half the family.
 */
export async function click(element: Element): Promise<void> {
  await hover(element);
  await step(() => {
    const pointer = { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, detail: 1 };
    element.dispatchEvent(new PointerEvent('pointerdown', pointer));
    element.dispatchEvent(new MouseEvent('mousedown', pointer));
    if (element instanceof HTMLElement) element.focus();
    element.dispatchEvent(new PointerEvent('pointerup', pointer));
    element.dispatchEvent(new MouseEvent('mouseup', pointer));
    (element as HTMLElement).click();
  });
}

/**
 * A key press on whatever holds focus. The two halves are aimed separately,
 * because a key that closes a popup moves focus between them and a keyup fired
 * at the element that has gone is not what the browser would deliver.
 */
export async function press(key: string): Promise<void> {
  const at = () => document.activeElement ?? document.body;
  await step(() => {
    at().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await step(() => {
    at().dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
}

/** Types into a text control the way a person does, one value change at a time. */
export async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await step(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Every element matching a selector that is actually on screen.
 *
 * A Select keeps its list mounted once it has been opened and marks the closed
 * positioner `hidden`, which takes the rows out of the accessibility tree and
 * off the screen without removing them from the document. Counting raw matches
 * would therefore count a list nobody can see.
 */
export function all(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (node) => node.closest('[hidden]') == null
  );
}

/** The first element matching a selector, or a failure the caller can read. */
export function one(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`no element matched ${selector}`);
  return node;
}

export function classesOf(element: Element): string[] {
  return [...element.classList];
}
