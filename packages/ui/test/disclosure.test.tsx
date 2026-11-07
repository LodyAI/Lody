import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';

import { afterEach, describe, expect, test } from 'vitest';
import { Accordion } from '../src/disclosure/accordion';

import { disclosureSurface as surface } from '../src/disclosure/surface';
import { Tabs } from '../src/disclosure/tabs';
import { all, classesOf, click, mount, one, press, type Mounted } from './dom';

/** See `menu.test.tsx`: the same loosened call the primitives make. */
function classesFor(...styles: readonly unknown[]): string[] {
  const props = stylex.props as (...args: readonly unknown[]) => { className?: string };
  return (props(...styles).className ?? '').split(' ').filter(Boolean);
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const tabs = () => all('[role="tab"]');
const panel = () => one('[role="tabpanel"]');
const rows = () => all('h3 > button');

function strip(size?: 'small' | 'medium' | 'large') {
  return (
    <Tabs.Root defaultValue="rendered">
      <Tabs.List size={size}>
        <Tabs.Tab value="rendered">Rendered</Tabs.Tab>
        <Tabs.Tab value="raw">Raw</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="rendered">The rendered file</Tabs.Panel>
      <Tabs.Panel value="raw">The raw file</Tabs.Panel>
    </Tabs.Root>
  );
}

const extension = stylex.create({ offset: (offset: number) => ({ marginInlineStart: offset }) });

describe('Tabs', () => {
  test('the keyboard walks the strip, and taking a tab is a second act', async () => {
    mounted = await mount(strip());
    tabs()[0].focus();
    await press('ArrowRight');
    // Focus moved; the panel did not. A tab swaps a panel that may be expensive
    // to build, and arrowing to the fourth tab should not build the second and
    // third on the way. A surface whose panels are cheap says `activateOnFocus`.
    expect(document.activeElement).toBe(tabs()[1]);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(panel().textContent).toBe('The rendered file');
    // Taking it is Enter or Space, which is the platform's own activation of a
    // real `<button>` rather than anything Base UI or this package handles —
    // jsdom does not synthesise it, so the browser pass is what covers it.
  });

  test('a strip that asks for it selects what the keyboard lands on', async () => {
    mounted = await mount(
      <Tabs.Root defaultValue="rendered">
        <Tabs.List activateOnFocus>
          <Tabs.Tab value="rendered">Rendered</Tabs.Tab>
          <Tabs.Tab value="raw">Raw</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="rendered">The rendered file</Tabs.Panel>
        <Tabs.Panel value="raw">The raw file</Tabs.Panel>
      </Tabs.Root>
    );
    tabs()[0].focus();
    await press('ArrowRight');
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  });

  test('a disabled tab is not one a person can land on', async () => {
    mounted = await mount(
      <Tabs.Root defaultValue="rendered">
        <Tabs.List>
          <Tabs.Tab value="rendered">Rendered</Tabs.Tab>
          <Tabs.Tab value="raw" disabled>
            Raw
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="rendered">The rendered file</Tabs.Panel>
      </Tabs.Root>
    );
    await click(tabs()[1]);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs()[1].getAttribute('aria-disabled')).toBe('true');
    // And it is dimmed from that state rather than through `:disabled`: Base UI
    // keeps a disabled tab focusable so a keyboard reaches it and hears why, so
    // the native attribute is never set and the pseudo-class never matches.
    expect(tabs()[1].hasAttribute('disabled')).toBe(false);
    expect(classesOf(tabs()[1])).toEqual(
      expect.arrayContaining(classesFor(surface.disabled, surface.tabDisabled))
    );
    expect(classesOf(tabs()[0])).not.toEqual(expect.arrayContaining(classesFor(surface.disabled)));
  });

  test('keeps dynamic variables and caller styles on each extended part', async () => {
    function Example() {
      const [vertical, setVertical] = useState(false);
      return (
        <>
          <button data-vertical onClick={() => setVertical(true)}>
            Vertical
          </button>
          <Tabs.Root
            data-extension-root
            defaultValue="a"
            orientation={vertical ? 'vertical' : 'horizontal'}
            xstyle={extension.offset(13)}
            style={(state) => ({ marginTop: state.orientation === 'vertical' ? 9 : 7 })}
          >
            <Tabs.List xstyle={extension.offset(15)} style={{ marginTop: 8 }}>
              <Tabs.Tab value="a">A</Tabs.Tab>
              <Tabs.Tab value="b">B</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel
              value="a"
              xstyle={extension.offset(17)}
              style={(state) => ({ marginTop: state.orientation === 'vertical' ? 13 : 11 })}
            >
              Panel A
            </Tabs.Panel>
            <Tabs.Panel value="b">Panel B</Tabs.Panel>
          </Tabs.Root>
        </>
      );
    }
    mounted = await mount(<Example />);
    const root = mounted.container.querySelector<HTMLElement>('[data-extension-root]')!;
    const list = one('[role="tablist"]'),
      content = panel();
    for (const [node, offset, margin] of [
      [root, 13, 7],
      [list, 15, 8],
      [content, 17, 11],
    ] as const) {
      expect(node.style.marginTop).toBe(`${margin}px`);
      const vars = stylex.props(extension.offset(offset)).style!;
      expect(Object.keys(vars).length).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(vars))
        expect(node.style.getPropertyValue(key)).toBe(String(value));
    }
    await click(one('[data-vertical]'));
    expect(root.style.marginTop).toBe('9px');
    expect(list.style.marginTop).toBe('8px');
    expect(content.style.marginTop).toBe('13px');
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
  });
});

describe('Accordion', () => {
  function stack(props: { multiple?: boolean } = {}) {
    return (
      <Accordion.Root {...props}>
        <Accordion.Item value="first">
          <Accordion.Trigger>What it does</Accordion.Trigger>
          <Accordion.Panel>It shows one thing at a time.</Accordion.Panel>
        </Accordion.Item>
        <Accordion.Item value="second">
          <Accordion.Trigger>What it costs</Accordion.Trigger>
          <Accordion.Panel>Nothing at all.</Accordion.Panel>
        </Accordion.Item>
      </Accordion.Root>
    );
  }

  test('one row is open at a time unless the stack says otherwise', async () => {
    mounted = await mount(stack());
    await click(rows()[0]);
    await click(rows()[1]);
    expect(rows()[0].getAttribute('aria-expanded')).toBe('false');
    expect(rows()[1].getAttribute('aria-expanded')).toBe('true');

    await mounted.unmount();
    mounted = await mount(stack({ multiple: true }));
    await click(rows()[0]);
    await click(rows()[1]);
    expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
    expect(rows()[1].getAttribute('aria-expanded')).toBe('true');
  });
});
