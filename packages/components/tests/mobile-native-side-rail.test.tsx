// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useNativeSideRail } from '../src/components/mobile/native-side-rail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Message = { owner: string; items: Array<{ id: string }> };
let messages: Message[];
let node: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Surface({ name, priority }: { name: string; priority: number }) {
  const [count, setCount] = useState(0);
  const visible = useNativeSideRail(
    [{ id: 'open', label: 'Open', symbol: 'folder', onPress: () => setCount((n) => n + 1) }],
    priority
  );
  return (
    <div>
      {name}:{count}:{visible ? 'rail' : 'fallback'}
    </div>
  );
}

beforeEach(() => {
  messages = [];
  Object.defineProperty(window, 'webkit', {
    configurable: true,
    value: {
      messageHandlers: {
        lodySideRail: { postMessage: (message: Message) => messages.push(message) },
      },
    },
  });
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
});

afterEach(() => {
  act(() => root.unmount());
  node.remove();
  delete (window as Window & { webkit?: unknown }).webkit;
});

function event(detail: { owner: string; visible?: boolean; action?: string }) {
  act(() => {
    window.dispatchEvent(new CustomEvent('lody:side-rail', { detail }));
  });
}

it('hands controls to the active surface and restores them when a dialog opens', async () => {
  act(() => root.render(<Surface name="home" priority={1} />));
  const home = messages.at(-1)!.owner;
  expect(node.textContent).toContain('home:0:fallback');
  event({ owner: home, visible: true });
  event({ owner: home, action: 'open' });
  expect(node.textContent).toContain('home:1:rail');

  act(() =>
    root.render(
      <>
        <Surface name="home" priority={1} />
        <Surface name="chat" priority={2} />
      </>
    )
  );
  const chat = messages.at(-1)!.owner;
  expect(chat).not.toBe(home);
  event({ owner: home, action: 'open' });
  event({ owner: chat, visible: true });
  event({ owner: chat, action: 'open' });
  expect(node.textContent).toContain('home:1:fallback');
  expect(node.textContent).toContain('chat:1:rail');

  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('data-state', 'open');
  await act(async () => {
    document.body.append(dialog);
    await Promise.resolve();
  });
  expect(messages.at(-1)).toEqual({ owner: '', items: [] });
  expect(node.textContent).toContain('chat:1:fallback');
  event({ owner: chat, action: 'open' });
  expect(node.textContent).toContain('chat:1:fallback');
  await act(async () => {
    dialog.remove();
    await Promise.resolve();
  });
  expect(messages.at(-1)!.owner).toBe(chat);

  const modal = document.createElement('div');
  modal.setAttribute('aria-modal', 'true');
  await act(async () => {
    document.body.append(modal);
    await Promise.resolve();
  });
  expect(messages.at(-1)).toEqual({ owner: '', items: [] });
  await act(async () => {
    modal.remove();
    await Promise.resolve();
  });
});
