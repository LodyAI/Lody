// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const requests = vi.hoisted(() => ({ active: new Set<string>(), history: [] as string[] }));
vi.mock('../src/lib/desktop-window', () => ({
  prepareDesktopWindow: (id: string) => {
    requests.active.add(id);
    requests.history.push(id);
    return () => requests.active.delete(id);
  },
}));
vi.mock('../src/lib/electron', () => ({ isMacOSElectronRenderer: () => true }));
import { installWindowPreparationIntent } from '../src/lib/window-preparation-intent';

let stop: (() => void) | undefined;
function setup() {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<div data-sidebar-session-id="a"><button>A</button></div><div data-sidebar-session-id="b">B</div>';
  stop = installWindowPreparationIntent();
  return [...document.body.children] as HTMLElement[];
}
function pointer(target: Element, type: string, relatedTarget?: Element) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget }));
}
afterEach(() => {
  stop?.();
  stop = undefined;
  requests.active.clear();
  requests.history.length = 0;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

it('prepares a row despite stopped bubbling, ignores movement within it, and cancels on exit', () => {
  const [a] = setup();
  a.addEventListener('pointerover', (e) => e.stopPropagation());
  pointer(a, 'pointerover');
  vi.advanceTimersByTime(39);
  expect([...requests.active]).toEqual([]);
  pointer(a, 'pointerout', a.firstElementChild!);
  pointer(a.firstElementChild!, 'pointerover');
  vi.advanceTimersByTime(1);
  expect([...requests.active]).toEqual(['a']);
  pointer(a, 'pointerout');
  expect([...requests.active]).toEqual([]);
});

it('coalesces rapid target changes and cannot prepare after an early click or detached row', () => {
  const [a, b] = setup();
  pointer(a, 'pointerover');
  vi.advanceTimersByTime(20);
  pointer(b, 'pointerover');
  vi.advanceTimersByTime(40);
  expect(requests.history).toEqual(['b']);
  pointer(a, 'pointerover');
  a.click();
  vi.advanceTimersByTime(500);
  expect([...requests.active]).toEqual([]);
  expect(requests.history).toEqual(['b']);
  pointer(b, 'pointerover');
  b.remove();
  vi.advanceTimersByTime(40);
  expect(requests.history).toEqual(['b']);
});

it('supports keyboard focus and stops all pending preparation on disposal', () => {
  const [a, b] = setup();
  a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  vi.advanceTimersByTime(40);
  expect([...requests.active]).toEqual(['a']);
  pointer(b, 'pointerover');
  stop!();
  vi.advanceTimersByTime(40);
  expect([...requests.active]).toEqual([]);
  expect(requests.history).toEqual(['a']);
});

it('starts immediately for Command hover, keyboard focus and modifier promotion', () => {
  const [a, b] = setup();
  a.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, metaKey: true }));
  expect([...requests.active]).toEqual(['a']);
  pointer(b, 'pointerover');
  expect([...requests.active]).toEqual([]);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }));
  expect([...requests.active]).toEqual(['b']);
  a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  expect([...requests.active]).toEqual(['a']);
  window.dispatchEvent(new Event('blur'));
  vi.advanceTimersByTime(100);
  expect([...requests.active]).toEqual([]);
});

it('ignores touch hover and stale virtualized row identities', () => {
  const [a] = setup();
  const event = new MouseEvent('pointerover', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  a.dispatchEvent(event);
  vi.advanceTimersByTime(40);
  expect([...requests.active]).toEqual([]);
  pointer(a, 'pointerover');
  a.setAttribute('data-sidebar-session-id', 'replacement');
  vi.advanceTimersByTime(40);
  expect([...requests.active]).toEqual([]);
});
