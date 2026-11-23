import { useRef, useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { PreviewCard } from '../src/popover/preview-card';

import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, mount, press, until, type Mounted } from './dom';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const cards = () => all('[data-card]');

/** A row that owns its own hover intent, the way the session list does. */
function AnchoredRow({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const row = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={row} data-row="" data-open={open ? '' : undefined}>
        <button type="button">Fix the sidebar</button>
      </div>
      <PreviewCard.Root open={open} onOpenChange={setOpen}>
        <PreviewCard.Content anchor={row}>
          <div data-card="">LodyAI/Lody</div>
        </PreviewCard.Content>
      </PreviewCard.Root>
    </>
  );
}

describe('PreviewCard', () => {
  test('a controlled card opens against the row it names, without taking focus', async () => {
    mounted = await mount(<AnchoredRow />);
    await until(() => cards().length === 1, 'the card');
    const popup = cards()[0].parentElement as HTMLElement;

    // It previews; it is not a dialog, so a row a pointer sweeps across is not
    // announced as one, and focus stays wherever the person left it.
    expect(popup.getAttribute('role')).not.toBe('dialog');
    expect(popup.contains(document.activeElement)).toBe(false);
  });

  test('Escape asks the owner to close it', async () => {
    mounted = await mount(<AnchoredRow />);
    await until(() => cards().length === 1, 'the card');

    await press('Escape');

    await until(() => cards().length === 0, 'the card to close');
    expect(document.querySelector('[data-row]')?.hasAttribute('data-open')).toBe(false);
  });

  test('carries a forced palette across the portal', async () => {
    mounted = await mount(
      <ThemeRoot mode="dark">
        <AnchoredRow />
      </ThemeRoot>
    );
    await until(() => cards().length === 1, 'the card');
    const positioner = cards()[0].parentElement?.parentElement;
    expect(positioner).not.toBeNull();
    for (const className of forcedThemeClassNames('dark')) {
      expect(classesOf(positioner as Element)).toContain(className);
    }
  });
});
