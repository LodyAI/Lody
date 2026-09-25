import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Button } from '../src/button/button';
import { Popover } from '../src/popover/popover';
import { PopupContainerProvider } from '../src/popup/portal-container';
import { surface } from '../src/popup/surface';
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

const trigger = () => one('button[aria-haspopup="dialog"]');
const panels = () => all('[role="dialog"]');
const panel = () => panels()[0];

describe('Popover', () => {
  test('is a button that announces the surface it opens, and opens it', async () => {
    mounted = await mount(
      <Popover.Root>
        <Popover.Trigger>Filter</Popover.Trigger>
        <Popover.Content>
          <Popover.Title>Filter sessions</Popover.Title>
        </Popover.Content>
      </Popover.Root>
    );
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(panels()).toHaveLength(0);

    await click(trigger());

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(panel().textContent).toContain('Filter sessions');
  });

  test('a title names the surface rather than being read out as its contents', async () => {
    mounted = await mount(
      <Popover.Root defaultOpen>
        <Popover.Trigger>Filter</Popover.Trigger>
        <Popover.Content>
          <Popover.Header>
            <Popover.Title>Filter sessions</Popover.Title>
            <Popover.Description>Applies to the list under it.</Popover.Description>
          </Popover.Header>
        </Popover.Content>
      </Popover.Root>
    );
    const labelledBy = panel().getAttribute('aria-labelledby');
    const describedBy = panel().getAttribute('aria-describedby');
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Filter sessions');
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
      'Applies to the list under it.'
    );
  });

  test('Escape closes it and the trigger says so again', async () => {
    mounted = await mount(
      <Popover.Root>
        <Popover.Trigger>Filter</Popover.Trigger>
        <Popover.Content>
          <Popover.Title>Filter sessions</Popover.Title>
        </Popover.Content>
      </Popover.Root>
    );
    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    await press('Escape');

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  test('Close runs its own handler and takes the surface down with it', async () => {
    const apply = vi.fn();
    mounted = await mount(
      <Popover.Root>
        <Popover.Trigger>Filter</Popover.Trigger>
        <Popover.Content>
          <Popover.Close render={<Button />} onClick={apply}>
            Apply
          </Popover.Close>
        </Popover.Content>
      </Popover.Root>
    );
    await click(trigger());
    const apply_ = all('[role="dialog"] button').find((node) =>
      node.textContent?.includes('Apply')
    );
    await click(apply_ as HTMLElement);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  test('is the list surface with five declarations replaced, and no more', () => {
    // The claim the token rules make about a popover, pinned as a count. Of the
    // classes a list's surface compiles to, exactly five are gone from a
    // popover's: the width it takes from the control that shows its value, the
    // 4px inset that lets a row bleed to the surface's edge, and the three that
    // make the type a control's — size, weight and tracking — because what a
    // popover holds is prose rather than the labels of commands. A sixth would
    // mean a second floating surface had started to grow beside the one every
    // other popup in this package shares.
    const list = classesFor(surface.popup);
    const popover = classesFor(surface.popup, surface.popupPanel);
    const replaced = list.filter((className) => !popover.includes(className));
    expect(replaced).toHaveLength(5);
  });

  test('mounts into the container a modal named, not on the body', async () => {
    function Host() {
      const [host, setHost] = useState<HTMLDivElement | null>(null);
      return (
        <div ref={setHost} data-host="">
          <PopupContainerProvider container={host}>
            <Popover.Root defaultOpen>
              <Popover.Trigger>Filter</Popover.Trigger>
              <Popover.Content>
                <Popover.Title>Filter sessions</Popover.Title>
              </Popover.Content>
            </Popover.Root>
          </PopupContainerProvider>
        </div>
      );
    }
    mounted = await mount(<Host />);
    // A modal traps focus and locks the scroll by DOM position, so a popover
    // portalled to the body is outside the panel that opened it. Naming the
    // panel puts it back inside the subtree the modal is guarding.
    expect(panel().closest('[data-host]')).not.toBeNull();
  });

  test('carries a forced palette across the portal', async () => {
    mounted = await mount(
      <ThemeRoot mode="dark">
        <Popover.Root defaultOpen>
          <Popover.Trigger>Filter</Popover.Trigger>
          <Popover.Content>
            <Popover.Title>Filter sessions</Popover.Title>
          </Popover.Content>
        </Popover.Root>
      </ThemeRoot>
    );
    // The panel is portalled out of the subtree declaring the palette, so the
    // classes that declare it travel with it and land on the positioner above.
    const positioner = panel().parentElement;
    expect(positioner).not.toBeNull();
    for (const className of forcedThemeClassNames('dark')) {
      expect(classesOf(positioner as Element)).toContain(className);
    }
  });
});
