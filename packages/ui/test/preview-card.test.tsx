import * as stylex from '@stylexjs/stylex';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { PreviewCard } from '../src/popover/preview-card';
import { surface } from '../src/popup/surface';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, mount, press, until, type Mounted } from './dom';

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

  test('stands on the popover surface: the same floating rung, the same panel', async () => {
    mounted = await mount(<AnchoredRow />);
    await until(() => cards().length === 1, 'the card');
    const popup = cards()[0].parentElement as HTMLElement;

    // A second floating surface would drift from the one menus and popovers
    // share, so the card is exactly the popover's classes.
    for (const className of classesFor(surface.popup, surface.popupPanel)) {
      expect(classesOf(popup)).toContain(className);
    }
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
