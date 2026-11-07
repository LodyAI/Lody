import type { ComponentProps, ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { Field } from '../src/field/field';
import { Select } from '../src/field/select';
import { PopupContainerProvider } from '../src/popup/portal-container';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, click, mount, one, press, type Mounted } from './dom';

const FRUIT = [
  { value: 'gala', label: 'Gala' },
  { value: 'fuji', label: 'Fuji' },
  { value: 'pink', label: 'Pink Lady' },
];

const extension = stylex.create({ width: (value: number) => ({ width: value }) });

function Fruit({
  children,
  ...rest
}: { children?: ReactNode } & ComponentProps<typeof Select.Root<string>>) {
  return (
    <Select.Root items={FRUIT} {...rest}>
      <Select.Trigger>
        <Select.Value placeholder="Pick a fruit" />
      </Select.Trigger>
      <Select.Content>
        {FRUIT.map((item) => (
          <Select.Item key={item.value} value={item.value}>
            {item.label}
          </Select.Item>
        ))}
        {children}
      </Select.Content>
    </Select.Root>
  );
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const trigger = () => one('button[role="combobox"]');
/**
 * Whether the list is open. A Select keeps its list mounted once it has been
 * opened and hides the closed one, so this reads what the trigger announces —
 * which is also what a screen reader is told.
 */
const isOpen = () => trigger().getAttribute('aria-expanded') === 'true';
const options = () => all('[role="listbox"] [role="option"]');

describe('Select trigger', () => {
  test('shows the label of the row it holds, which it reads from the root items', async () => {
    mounted = await mount(<Fruit defaultValue="pink" />);
    // The rows carry the labels a person reads, but the trigger resolves its
    // own text from `Select.Root items` — so a caller whose row text differs
    // from its value must state the list there as well.
    expect(trigger().textContent).toContain('Pink Lady');
  });

  test('a disabled field reaches the trigger and the list stays shut', async () => {
    mounted = await mount(
      <Field.Root disabled>
        <Fruit />
      </Field.Root>
    );
    // A native button takes the disabled attribute, so the same `:disabled`
    // rule that dims an Input dims this without a second mechanism.
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    await click(trigger());
    expect(isOpen()).toBe(false);
  });

  test('keeps dynamic styles and the caller callback through a disabled state change', async () => {
    function Example() {
      const [disabled, setDisabled] = useState(false);
      return (
        <>
          <button data-disable-select onClick={() => setDisabled(true)}>
            Disable select
          </button>
          <Select.Root items={FRUIT} disabled={disabled}>
            <Select.Trigger
              xstyle={extension.width(disabled ? 0 : 220)}
              style={(state) => ({ opacity: state.disabled ? 0.5 : 1 })}
            >
              <Select.Value placeholder="Pick a fruit" />
            </Select.Trigger>
          </Select.Root>
        </>
      );
    }
    mounted = await mount(<Example />);
    expect(trigger().style.opacity).toBe('1');
    for (const [key, value] of Object.entries(stylex.props(extension.width(220)).style!))
      expect(trigger().style.getPropertyValue(key)).toBe(String(value));
    await click(one('[data-disable-select]'));
    expect(trigger().matches(':disabled')).toBe(true);
    expect(trigger().style.opacity).toBe('0.5');
    for (const [key, value] of Object.entries(stylex.props(extension.width(0)).style!))
      expect(trigger().style.getPropertyValue(key)).toBe(String(value));
  });
});

describe('Select list', () => {
  test('opens on click and closes on Escape without changing the value', async () => {
    mounted = await mount(<Fruit defaultValue="gala" />);
    await click(trigger());
    expect(isOpen()).toBe(true);
    expect(options()).toHaveLength(3);

    await press('Escape');
    expect(isOpen()).toBe(false);
    // The rows go with it: the closed list is hidden, so nothing in it is on
    // screen or in the accessibility tree.
    expect(options()).toHaveLength(0);
    expect(trigger().textContent).toContain('Gala');
    // Escape hands focus back, so the keyboard is not stranded on a gone popup.
    expect(document.activeElement).toBe(trigger());
  });

  test('the arrow keys walk the list and Enter takes the highlighted row', async () => {
    mounted = await mount(<Fruit defaultValue="gala" />);
    await click(trigger());
    expect(options().map((row) => row.hasAttribute('data-highlighted'))).toEqual([
      true,
      false,
      false,
    ]);

    await press('ArrowDown');
    expect(options().map((row) => row.hasAttribute('data-highlighted'))).toEqual([
      false,
      true,
      false,
    ]);

    await press('Enter');
    expect(isOpen()).toBe(false);
    expect(trigger().textContent).toContain('Fuji');
  });

  test('a disabled row is dimmed and cannot be picked', async () => {
    mounted = await mount(
      <Fruit>
        <Select.Item value="sold-out" disabled>
          Sold out
        </Select.Item>
      </Fruit>
    );
    await click(trigger());
    const row = options()[3];
    expect(row.hasAttribute('data-disabled')).toBe(true);
    // `:disabled` cannot reach a row, so the family's one disabled value is
    // applied from Base UI's state: the opacity and the dropped pointer, and
    // nothing else, against a row that is neither selected nor highlighted.
    const enabled = classesOf(options()[1]);
    expect(classesOf(row).filter((name) => !enabled.includes(name))).toHaveLength(2);

    await click(row);
    expect(trigger().textContent).toContain('Pick a fruit');
  });
});

describe('the palette a portalled popup uses', () => {
  const positioner = () => one('[role="listbox"]').parentElement?.parentElement as HTMLElement;

  test('follows the forced palette of the subtree the trigger is in', async () => {
    mounted = await mount(
      <ThemeRoot mode="dark">
        <Fruit />
      </ThemeRoot>
    );
    await click(trigger());
    // A forced theme works by cascade and a popup is portalled out of the
    // subtree that declares it, so without this a dark panel on a light page
    // opens a light list. The classes travel to the element it mounts on.
    const dark = forcedThemeClassNames('dark');
    expect(dark.length).toBeGreaterThan(0);
    expect(classesOf(positioner())).toEqual(expect.arrayContaining(dark));

    const lightOnly = forcedThemeClassNames('light').filter((name) => !dark.includes(name));
    expect(lightOnly.length).toBeGreaterThan(0);
    for (const name of lightOnly) {
      expect(classesOf(positioner())).not.toContain(name);
    }
  });

  test('carries nothing when nothing is forced, so the document palette wins', async () => {
    mounted = await mount(<Fruit />);
    await click(trigger());
    const forced = [...forcedThemeClassNames('light'), ...forcedThemeClassNames('dark')];
    for (const name of forced) {
      expect(classesOf(positioner())).not.toContain(name);
    }
  });
});

describe('where the popup mounts', () => {
  function Hosted() {
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div>
        <div data-host="" ref={ref} />
        <PopupContainerProvider container={host}>
          <Fruit />
        </PopupContainerProvider>
        <button
          type="button"
          data-adopt=""
          onClick={() => {
            setHost(ref.current);
          }}
        />
      </div>
    );
  }

  test('defaults to the document and follows the nearest container when one is stated', async () => {
    mounted = await mount(<Hosted />);
    await click(trigger());
    expect(one('[data-host=""]').querySelector('[role="option"]')).toBeNull();
    await press('Escape');

    await click(one('[data-adopt=""]'));
    await click(trigger());
    // A modal that owns its own focus scope and scroll lock treats a popup
    // mounted outside its subtree as outside; naming the container puts the
    // list back inside it.
    expect(one('[data-host=""]').querySelector('[role="option"]')).not.toBeNull();
  });
});
