import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';

import { Popover } from '../src/popover/popover';
import { PopupContainerProvider } from '../src/popup/portal-container';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, click, mount, one, press, type Mounted } from './dom';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const trigger = () => one('button[aria-haspopup="dialog"]');
const panels = () => all('[role="dialog"]');
const panel = () => panels()[0];

describe('Popover', () => {
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
