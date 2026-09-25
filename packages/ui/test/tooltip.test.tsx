import * as stylex from '@stylexjs/stylex';
import { afterEach, describe, expect, test } from 'vitest';
import { Button } from '../src/button/button';
import { chip } from '../src/tooltip/chip';
import { Tooltip } from '../src/tooltip/tooltip';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, mount, one, press, step, type Mounted } from './dom';

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

const trigger = () => one('button');

/**
 * The chips on screen.
 *
 * A tooltip has no role to select it by, and that is the component's design
 * rather than an omission: Base UI makes one visual-only, because a tooltip is
 * not reachable by touch or by a screen reader and `role="tooltip"` would
 * promise otherwise. The chip is therefore found where it is — the element
 * inside a positioner, which reports the side it landed on.
 */
const chips = () =>
  all('[data-base-ui-portal] [data-side]').flatMap((positioner) =>
    [...positioner.children].filter((node): node is HTMLElement => node instanceof HTMLElement)
  );

/**
 * The pointer arriving over the trigger.
 *
 * `dom.tsx`'s `hover` moves the pointer, which is what highlights a list row; a
 * tooltip listens for the pointer entering its trigger instead, and jsdom
 * synthesises no enter event from a move. The two are different facts, so this
 * one is stated here rather than widening the shared helper.
 */
async function point(element: Element): Promise<void> {
  await step(() => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
      element.dispatchEvent(
        new PointerEvent(type, { bubbles: type.endsWith('over'), pointerType: 'mouse' })
      );
    }
    element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
  });
}

function Rerun({ ...rest }: { defaultOpen?: boolean }) {
  return (
    <Tooltip.Root {...rest}>
      <Tooltip.Trigger delay={0} render={<Button icon aria-label="Rerun" />}>
        R
      </Tooltip.Trigger>
      <Tooltip.Content>Rerun this turn</Tooltip.Content>
    </Tooltip.Root>
  );
}

describe('Tooltip', () => {
  test('opens when the pointer arrives, and says what it names', async () => {
    mounted = await mount(<Rerun />);
    expect(chips()).toHaveLength(0);

    await point(trigger());

    expect(chips()).toHaveLength(1);
    expect(chips()[0].textContent).toBe('Rerun this turn');
    expect(trigger().getAttribute('data-popup-open')).toBe('');
  });

  test('is visual only, so the trigger still carries its own name', async () => {
    mounted = await mount(<Rerun defaultOpen />);
    // The contract every migrated caller has to meet. A tooltip is not a label:
    // it is not reachable by touch or by a screen reader, so Base UI gives the
    // chip no role and wires no `aria-describedby`, and a control whose only
    // name was its tooltip would have no name at all. The trigger names itself.
    expect(chips()[0].getAttribute('role')).toBeNull();
    expect(trigger().getAttribute('aria-describedby')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('Rerun');
  });

  test('Escape takes it down', async () => {
    mounted = await mount(<Rerun defaultOpen />);
    expect(chips()).toHaveLength(1);

    await press('Escape');

    expect(chips()).toHaveLength(0);
  });

  test('never takes the pointer off what it names', () => {
    // A chip that landed under the cursor and accepted the pointer would take
    // it off its own trigger, closing itself and reopening in a loop. It is the
    // one declaration on the chip that is about behaviour rather than
    // appearance, so it is pinned rather than left reading like a nicety.
    const none = stylex.create({ probe: { pointerEvents: 'none' } });
    for (const className of classesFor(none.probe)) {
      expect(classesFor(chip.popup)).toContain(className);
    }
  });

  test('carries a forced palette across the portal', async () => {
    mounted = await mount(
      <ThemeRoot mode="dark">
        <Rerun defaultOpen />
      </ThemeRoot>
    );
    // A tooltip inverts, so a chip that inherited the document's palette is the
    // one case that is unreadable rather than merely wrong: light ink on a
    // light fill.
    const positioner = chips()[0].parentElement;
    expect(positioner).not.toBeNull();
    for (const className of forcedThemeClassNames('dark')) {
      expect(classesOf(positioner as Element)).toContain(className);
    }
  });
});
