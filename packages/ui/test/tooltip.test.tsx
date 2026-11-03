import { afterEach, describe, expect, test } from 'vitest';
import { Button } from '../src/button/button';

import { Tooltip } from '../src/tooltip/tooltip';

import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';

import { all, classesOf, mount, one, press, type Mounted } from './dom';

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

  test('carries a forced palette across the portal', async () => {
    mounted = await mount(
      <ThemeRoot mode="dark">
        <Rerun defaultOpen />
      </ThemeRoot>
    );
    // A tooltip follows the palette it is opened in. A chip that inherited the
    // document's palette instead would be a dark patch over a surface forced
    // light, or the reverse — the foreign chip this rule exists to rule out.
    const positioner = chips()[0].parentElement;
    expect(positioner).not.toBeNull();
    for (const className of forcedThemeClassNames('dark')) {
      expect(classesOf(positioner as Element)).toContain(className);
    }
  });
});
