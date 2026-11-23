import { afterEach, describe, expect, test } from 'vitest';
import { Button } from '../src/button/button';
import { drawerSwipeDirection } from '../src/dialog/surface';

import { Drawer } from '../src/drawer/drawer';
import { Select } from '../src/field/select';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, mount, one, type Mounted } from './dom';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const panels = () => all('[role="dialog"]');
const panel = () => panels()[0];

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
