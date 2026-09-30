import * as stylex from '@stylexjs/stylex';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';
import { Accordion } from '../src/disclosure/accordion';
import { Collapsible } from '../src/disclosure/collapsible';
import { disclosureSurface as surface, isCollapsed } from '../src/disclosure/surface';
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

describe('Tabs', () => {
  test('is a strip of tabs over the one panel they name', async () => {
    mounted = await mount(strip());
    expect(tabs()).toHaveLength(2);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    // The pair a screen reader walks: the tab names the panel, the panel is
    // named by the tab, and only the chosen panel is in the document.
    expect(panel().getAttribute('aria-labelledby')).toBe(tabs()[0].id);
    expect(tabs()[0].getAttribute('aria-controls')).toBe(panel().id);
    expect(panel().textContent).toBe('The rendered file');
  });

  test('the list holds the indicator without a caller adding one, and holds it first', async () => {
    mounted = await mount(strip());
    const list = one('[role="tablist"]');
    // Painting order, not decoration: the indicator is out of flow and the tabs
    // are in it, so a pill rendered after them would cover their labels.
    expect(list.firstElementChild?.getAttribute('role')).toBe('presentation');
    // Not through `all`: the indicator is `hidden` until Base UI has measured a
    // tab, and jsdom lays nothing out, so it is never measured here.
    expect(list.querySelectorAll('[role="presentation"]')).toHaveLength(1);
  });

  test('taking a tab moves the selection and swaps the panel under it', async () => {
    mounted = await mount(strip());
    await click(tabs()[1]);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('false');
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
    expect(panel().textContent).toBe('The raw file');
  });

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

  test('the tab you are on is the other one with its colour replaced', async () => {
    mounted = await mount(strip());
    // Exactly the resting tab plus `tabActive`, and exactly the resting tab
    // without it: no fill, no shadow, no weight change between the two states,
    // because the pill under the tab is what says which one you are on.
    expect(classesOf(tabs()[0]).sort()).toEqual(
      classesFor(surface.ring, surface.tab, surface.tabMedium, surface.tabActive).sort()
    );
    expect(classesOf(tabs()[1]).sort()).toEqual(
      classesFor(surface.ring, surface.tab, surface.tabMedium).sort()
    );
  });

  test('a stretched strip splits its width, which is two facts stated once', async () => {
    mounted = await mount(
      <Tabs.Root defaultValue="local">
        <Tabs.List stretch>
          <Tabs.Tab value="local">Local</Tabs.Tab>
          <Tabs.Tab value="github">GitHub</Tabs.Tab>
        </Tabs.List>
      </Tabs.Root>
    );
    // The track stretching and the tabs sharing it are one prop, because a
    // strip that did only the first would be a full-width track with two tabs
    // huddled at its start.
    expect(classesOf(one('[role="tablist"]'))).toEqual(
      expect.arrayContaining(classesFor(surface.trackStretch))
    );
    for (const tab of tabs()) {
      expect(classesOf(tab)).toEqual(expect.arrayContaining(classesFor(surface.tabStretch)));
    }
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

  test('the size is stated once on the strip, and the corner rule follows it', async () => {
    const classesForSize = (size: 'small' | 'medium' | 'large') => {
      const html = renderToStaticMarkup(strip(size));
      const open = html.match(/<button\b[^>]*>/)?.[0] ?? '';
      return (/class="([^"]*)"/.exec(open)?.[1] ?? '').split(' ').filter(Boolean);
    };
    const small = classesForSize('small');
    const medium = classesForSize('medium');
    const large = classesForSize('large');
    // A 28px control takes radius 8 and a 32 or 36px one takes 10, so the top
    // of the ladder shares its corner with the middle and only the small step
    // differs — the same pair `Button` states.
    expect(large).toEqual(medium);
    expect(small).not.toEqual(medium);
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

  test('a row is a button inside the heading that names its panel', async () => {
    mounted = await mount(stack());
    expect(rows()).toHaveLength(2);
    expect(rows()[0].getAttribute('aria-expanded')).toBe('false');
    await click(rows()[0]);
    const region = one('[role="region"]');
    expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
    expect(region.getAttribute('aria-labelledby')).toBe(rows()[0].id);
  });

  test('the chevron is drawn by the part, and turns over when the row opens', async () => {
    mounted = await mount(stack());
    const chevron = () => one('button[aria-expanded] span[aria-hidden="true"]');
    expect(chevron().querySelector('svg')).not.toBeNull();
    const closed = classesOf(chevron());
    await click(rows()[0]);
    const open = classesOf(chevron());
    expect(open.filter((name) => !closed.includes(name))).toEqual(classesFor(surface.chevronOpen));
  });

  test('a row that cannot be used is dimmed from state, for the same reason', async () => {
    mounted = await mount(
      <Accordion.Root>
        <Accordion.Item value="first" disabled>
          <Accordion.Trigger>What it does</Accordion.Trigger>
          <Accordion.Panel>It shows one thing at a time.</Accordion.Panel>
        </Accordion.Item>
      </Accordion.Root>
    );
    expect(rows()[0].hasAttribute('disabled')).toBe(false);
    expect(rows()[0].getAttribute('aria-disabled')).toBe('true');
    expect(classesOf(rows()[0])).toEqual(expect.arrayContaining(classesFor(surface.disabled)));
  });

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

  test("the panel's padding rides on a child, because the panel's height is what moves", async () => {
    mounted = await mount(stack());
    await click(rows()[0]);
    const region = one('[role="region"]');
    const body = classesFor(surface.body);
    // Base UI measures the panel with `scrollHeight`, which counts padding, so
    // a padded panel animates to the wrong height in either box model. The
    // padding is therefore on the child and the panel carries the motion.
    expect(classesOf(region)).toEqual(expect.arrayContaining(classesFor(surface.accordionPanel)));
    expect(body.some((name) => classesOf(region).includes(name))).toBe(false);
    expect(classesOf(region.firstElementChild as HTMLElement)).toEqual(
      expect.arrayContaining(body)
    );
  });
});

describe('Collapsible', () => {
  test('the trigger is whatever the surface already had there', () => {
    const html = renderToStaticMarkup(
      <Collapsible.Root>
        <Collapsible.Trigger>Details</Collapsible.Trigger>
        <Collapsible.Panel>Body</Collapsible.Panel>
      </Collapsible.Root>
    );
    // Nothing of this package's is on it: a lone disclosure is opened by a card
    // header or a row, and a styled control here would be a second Button.
    expect(/<button[^>]*class=/.test(html)).toBe(false);
  });

  test('the panel is the part the primitive owns, and it opens and closes', async () => {
    mounted = await mount(
      <Collapsible.Root>
        <Collapsible.Trigger>Details</Collapsible.Trigger>
        <Collapsible.Panel>What happened</Collapsible.Panel>
      </Collapsible.Root>
    );
    const trigger = () => one('button');
    expect(all('[data-open]').filter((node) => node.tagName === 'DIV')).toHaveLength(0);
    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const opened = document.getElementById(trigger().getAttribute('aria-controls') ?? '');
    if (!opened) throw new Error('the trigger names no panel');
    expect(opened.textContent).toBe('What happened');
    expect(classesOf(opened)).toEqual(expect.arrayContaining(classesFor(surface.collapsiblePanel)));
    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  test('the two panels animate from the variable their own component publishes', () => {
    // Base UI names the height it measured per component, so one shared style
    // would leave whichever of the two it was not written for with no height to
    // move between.
    expect(classesFor(surface.accordionPanel)).not.toEqual(classesFor(surface.collapsiblePanel));
  });

  test('the ends of a reveal are the two Base UI reports, and nothing else', () => {
    // StyleX cannot select `[data-starting-style]`, so this reading is what
    // stands in for it; `idle` is the panel at rest, open or closed.
    expect(isCollapsed('starting')).toBe(true);
    expect(isCollapsed('ending')).toBe(true);
    expect(isCollapsed('idle')).toBe(false);
    expect(isCollapsed(undefined)).toBe(false);
  });
});
