import * as stylex from '@stylexjs/stylex';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Button } from '../src/button/button';
import { modal, drawerSwipeDirection } from '../src/dialog/surface';
import { Drawer } from '../src/drawer/drawer';
import { Select } from '../src/field/select';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
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

const panels = () => all('[role="dialog"]');
const panel = () => panels()[0];
const buttonNamed = (label: string) => {
  const node = all('button').find((element) => element.textContent?.trim() === label);
  if (!node) throw new Error(`no button named ${label}`);
  return node;
};

function Filters({
  side = 'end',
  inset,
  ...rest
}: {
  side?: 'top' | 'bottom' | 'start' | 'end';
  inset?: boolean;
  defaultOpen?: boolean;
}) {
  return (
    <Drawer.Root side={side} {...rest}>
      <Drawer.Trigger>Open filters</Drawer.Trigger>
      <Drawer.Content side={side} inset={inset}>
        <Drawer.Header>
          <Drawer.Title>Filters</Drawer.Title>
          <Drawer.Description>They apply to the session list.</Drawer.Description>
        </Drawer.Header>
        <Drawer.Footer>
          <Drawer.Close render={<Button variant="secondary" />}>Reset</Drawer.Close>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer.Root>
  );
}

describe('Drawer', () => {
  test('a trigger opens the panel, and the panel names itself', async () => {
    mounted = await mount(<Filters />);
    expect(panels()).toHaveLength(0);

    await click(one('button'));

    const labelledBy = panel().getAttribute('aria-labelledby');
    const describedBy = panel().getAttribute('aria-describedby');
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Filters');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
      'They apply to the session list.'
    );
  });

  test('states the edge it came in on, and the cross closes it', async () => {
    mounted = await mount(<Filters side="bottom" defaultOpen />);
    expect(panel().getAttribute('data-side')).toBe('bottom');

    await click(one('[role="dialog"] button[aria-label="Close"]'));
    expect(panels()).toHaveLength(0);
  });

  test('Escape closes it, and a footer answer runs before it does', async () => {
    const reset = vi.fn();
    mounted = await mount(
      <Drawer.Root defaultOpen>
        <Drawer.Content>
          <Drawer.Title>Filters</Drawer.Title>
          <Drawer.Close render={<Button />} onClick={reset}>
            Reset
          </Drawer.Close>
        </Drawer.Content>
      </Drawer.Root>
    );
    await click(buttonNamed('Reset'));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(panels()).toHaveLength(0);

    await mounted.unmount();
    mounted = await mount(<Filters defaultOpen />);
    await press('Escape');
    expect(panels()).toHaveLength(0);
  });

  test('the edge picks the swipe, and the inline pair flips right to left', () => {
    // The one derivation this package does on Base UI's behalf. Base UI names a
    // swipe in physical directions because a finger moves in physical space;
    // this package names an edge in writing-direction terms, so "away from the
    // start edge" is left in one document and right in another.
    expect(drawerSwipeDirection('top', false)).toBe('up');
    expect(drawerSwipeDirection('bottom', false)).toBe('down');
    expect(drawerSwipeDirection('start', false)).toBe('left');
    expect(drawerSwipeDirection('end', false)).toBe('right');

    expect(drawerSwipeDirection('start', true)).toBe('right');
    expect(drawerSwipeDirection('end', true)).toBe('left');
    // The block axis does not reverse with writing direction.
    expect(drawerSwipeDirection('top', true)).toBe('up');
    expect(drawerSwipeDirection('bottom', true)).toBe('down');
  });

  test('the panel keeps its transform for the gesture, unlike a dialog', () => {
    // The reason a drawer is not a dialog pinned to an edge. A dialog centres
    // itself with `translate(-50%, -50%)`, which spends the one property CSS
    // has for movement; a drawer is laid out by its viewport and leaves that
    // property to Base UI's swipe variables. If the drawer panel ever picked up
    // the dialog's centring class, the drag would fight the position.
    const centring = stylex.create({ probe: { transform: 'translate(-50%, -50%)' } });
    const centringClasses = classesFor(centring.probe);
    expect(centringClasses.length).toBeGreaterThan(0);
    for (const className of centringClasses) {
      expect(classesFor(modal.popup)).toContain(className);
      expect(classesFor(modal.drawerPopup)).not.toContain(className);
    }
  });

  test('a flush drawer squares the corners it meets; an inset one keeps all four', () => {
    // The two are one axis of the same component, so the difference is checked
    // as a difference rather than each being described on its own.
    for (const side of ['top', 'bottom', 'start', 'end'] as const) {
      const flush = classesFor(modal.drawerPopup, modal[`flush${cap(side)}`]);
      const insetPanel = classesFor(modal.drawerPopup);
      expect(flush.length).toBeGreaterThan(insetPanel.length);
    }
  });

  test('every popup inside it mounts into the panel rather than on the body', async () => {
    mounted = await mount(
      <Drawer.Root defaultOpen>
        <Drawer.Content>
          <Drawer.Title>Pick a fruit</Drawer.Title>
          <Select.Root defaultOpen items={[{ value: 'gala', label: 'Gala' }]}>
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="gala">Gala</Select.Item>
            </Select.Content>
          </Select.Root>
        </Drawer.Content>
      </Drawer.Root>
    );
    const list = one('[role="listbox"]');
    expect(list.closest('[role="dialog"]')).toBe(panel());
  });

  test('carries a forced palette across the portal', async () => {
    mounted = await mount(
      <ThemeRoot mode="dark">
        <Filters defaultOpen />
      </ThemeRoot>
    );
    // The portal wraps the backdrop, the viewport and the panel, so it is where
    // the classes declaring the palette land.
    const portal = panel().closest('[data-base-ui-portal]') ?? panel().parentElement;
    expect(portal).not.toBeNull();
    for (const className of forcedThemeClassNames('dark')) {
      expect(classesOf(portal as Element)).toContain(className);
    }
  });
});

function cap<T extends string>(value: T): Capitalize<T> {
  return (value.charAt(0).toUpperCase() + value.slice(1)) as Capitalize<T>;
}
