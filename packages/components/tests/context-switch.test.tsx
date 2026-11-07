// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextSwitch, type SessionContextType } from '../src/components/chat/context-switch';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it('keeps connection actions separate from context selection and makes the connected tab selectable', async () => {
  function Fixture() {
    const [value, setValue] = useState<SessionContextType>('chat');
    const [connected, setConnected] = useState(false);
    return (
      <>
        <ContextSwitch
          value={value}
          onChange={setValue}
          tone="light"
          localDisabled={{ label: 'Desktop only' }}
          githubDisabled={
            connected ? undefined : { label: 'Connect GitHub', onClick: () => setConnected(true) }
          }
        />
        <output>{value}</output>
      </>
    );
  }
  await act(async () => root.render(<Fixture />));
  const help = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Local')!;
  await act(async () => help.click());
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(document.querySelector('[data-base-ui-portal] [data-side]')?.textContent).toBe(
    'Desktop only'
  );
  expect(host.querySelector('output')?.textContent).toBe('chat');
  const connect = host.querySelector<HTMLButtonElement>('[data-context-disabled-action]')!;
  await act(async () => connect.click());
  expect(host.querySelector('[data-context-disabled-action]')).toBeNull();
  expect(host.querySelector('output')?.textContent).toBe('chat');
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (node) => node.textContent === 'GitHub'
  )!;
  await act(async () => tab.click());
  expect(host.querySelector('output')?.textContent).toBe('github');
  expect(tab.getAttribute('aria-selected')).toBe('true');
});
