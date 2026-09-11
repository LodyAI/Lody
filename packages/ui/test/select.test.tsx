import type { ComponentProps, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';
import { Field } from '../src/field/field';
import { Input } from '../src/field/input';
import { Select } from '../src/field/select';
import { PopupContainerProvider } from '../src/popup/portal-container';
import { ThemeRoot, forcedThemeClassNames } from '../src/theme/theme';
import { all, classesOf, click, mount, one, press, type Mounted } from './dom';

const FRUIT = [
  { value: 'gala', label: 'Gala' },
  { value: 'fuji', label: 'Fuji' },
  { value: 'pink', label: 'Pink Lady' },
];

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

/** What the invalid ring adds to a text control, derived rather than written down. */
const RING_CLASSES = (() => {
  const strip = (html: string) =>
    (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ').filter(Boolean);
  const valid = strip(renderToStaticMarkup(<Input />));
  const invalid = strip(renderToStaticMarkup(<Input aria-invalid="true" />));
  return invalid.filter((name) => !valid.includes(name));
})();

const trigger = () => one('button[role="combobox"]');
/**
 * Whether the list is open. A Select keeps its list mounted once it has been
 * opened and hides the closed one, so this reads what the trigger announces —
 * which is also what a screen reader is told.
 */
const isOpen = () => trigger().getAttribute('aria-expanded') === 'true';
const options = () => all('[role="listbox"] [role="option"]');
/** Base UI's Popup is the box the listbox sits in. */
const popup = () => one('[role="listbox"]').parentElement as HTMLElement;

describe('Select trigger', () => {
  test('is a real button that announces the list it opens', async () => {
    mounted = await mount(<Fruit name="fruit" />);
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(isOpen()).toBe(false);
    // The value goes into a form under the name the caller gave, so a select is
    // submittable without the surface tracking it separately.
    expect(mounted.container.querySelector('input[name="fruit"]')).not.toBeNull();
  });

  test('shows the placeholder until the select holds a value, and the value after', async () => {
    mounted = await mount(<Fruit name="fruit" />);
    expect(trigger().hasAttribute('data-placeholder')).toBe(true);
    expect(trigger().textContent).toContain('Pick a fruit');

    await click(trigger());
    await click(options()[1]);

    expect(trigger().hasAttribute('data-placeholder')).toBe(false);
    expect(trigger().textContent).toContain('Fuji');
    expect(one('input[name="fruit"]').getAttribute('value')).toBe('fuji');
  });

  test('the empty prompt is drawn in the placeholder colour, not the value colour', async () => {
    mounted = await mount(<Fruit />);
    const empty = classesOf(one('button[role="combobox"] > span'));
    await click(trigger());
    await click(options()[0]);
    const filled = classesOf(one('button[role="combobox"] > span'));
    // Exactly one class swaps in and none out: the hint colour, and nothing
    // else about the value changes with it.
    expect(empty.filter((name) => !filled.includes(name))).toHaveLength(1);
    expect(filled.filter((name) => !empty.includes(name))).toHaveLength(0);
  });

  test('shows the label of the row it holds, which it reads from the root items', async () => {
    mounted = await mount(<Fruit defaultValue="pink" />);
    // The rows carry the labels a person reads, but the trigger resolves its
    // own text from `Select.Root items` — so a caller whose row text differs
    // from its value must state the list there as well.
    expect(trigger().textContent).toContain('Pink Lady');
  });

  test('without items it can only show the raw value', async () => {
    mounted = await mount(
      <Select.Root defaultValue="pink">
        <Select.Trigger>
          <Select.Value placeholder="Pick a fruit" />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="pink">Pink Lady</Select.Item>
        </Select.Content>
      </Select.Root>
    );
    // Pinned because it is the trap: this is what a migrated caller gets if it
    // drops `items`, and it is quiet — the control still works, it just names
    // the value instead of the row.
    expect(trigger().textContent).toContain('pink');
    expect(trigger().textContent).not.toContain('Pink Lady');
  });

  test('wears the same invalid ring a text control does', async () => {
    expect(RING_CLASSES.length).toBeGreaterThan(0);
    mounted = await mount(
      <Field.Root invalid>
        <Fruit />
      </Field.Root>
    );
    expect(trigger().getAttribute('aria-invalid')).toBe('true');
    expect(RING_CLASSES.every((name) => classesOf(trigger()).includes(name))).toBe(true);
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

  test('the label points at the trigger without the caller naming an id', async () => {
    mounted = await mount(
      <Field.Root name="fruit">
        <Field.Label>Fruit</Field.Label>
        <Fruit />
      </Field.Root>
    );
    expect(one('label').getAttribute('for')).toBe(trigger().getAttribute('id'));
  });

  test('a caller className lands after the compiled classes', async () => {
    mounted = await mount(
      <Select.Root>
        <Select.Trigger className="w-full">
          <Select.Value placeholder="Pick" />
        </Select.Trigger>
        <Select.Content />
      </Select.Root>
    );
    const classes = classesOf(trigger());
    expect(classes[classes.length - 1]).toBe('w-full');
    expect(classes.length).toBeGreaterThan(5);
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

  test('the row that holds the value is the one marked selected and ticked', async () => {
    mounted = await mount(<Fruit defaultValue="fuji" />);
    await click(trigger());
    const rows = options();
    expect(rows.map((row) => row.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    // The tick box is reserved on every row so the list cannot reflow as the
    // selection moves; only the selected row draws the glyph in it.
    expect(rows.filter((row) => row.querySelector('svg'))).toHaveLength(1);
    expect(rows[1].querySelector('svg')).not.toBeNull();
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

  test('End walks to the last row and Home back to the first', async () => {
    mounted = await mount(<Fruit defaultValue="gala" />);
    await click(trigger());
    await press('End');
    expect(options()[2].hasAttribute('data-highlighted')).toBe(true);
    await press('Home');
    expect(options()[0].hasAttribute('data-highlighted')).toBe(true);
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

  test('the highlight wins the fill from the selected row rather than stacking on it', async () => {
    mounted = await mount(<Fruit defaultValue="gala" />);
    await click(trigger());
    // On open row 0 is both selected and highlighted; after one step down, row 0
    // is selected only and row 1 highlighted only.
    const both = classesOf(options()[0]);
    await press('ArrowDown');
    const selectedOnly = classesOf(options()[0]);
    const highlightedOnly = classesOf(options()[1]);
    expect(selectedOnly).not.toEqual(highlightedOnly);
    // The highlight owns both the fill and its contrast-checked inset ring.
    // StyleX resolves the competing background declarations, so a row that is
    // both selected and highlighted has exactly the highlighted row's classes;
    // its separately rendered tick continues to communicate selection.
    expect(both).toEqual(highlightedOnly);
  });

  test('a caller className lands on the popup after the compiled classes', async () => {
    mounted = await mount(
      <Select.Root>
        <Select.Trigger>
          <Select.Value placeholder="Pick" />
        </Select.Trigger>
        <Select.Content className="max-h-40">
          <Select.Item value="a">Alpha</Select.Item>
        </Select.Content>
      </Select.Root>
    );
    await click(trigger());
    const classes = classesOf(popup());
    expect(classes[classes.length - 1]).toBe('max-h-40');
    expect(classes.length).toBeGreaterThan(5);
  });

  test('a group names the rows under it and a separator divides them', async () => {
    mounted = await mount(
      <Select.Root>
        <Select.Trigger>
          <Select.Value placeholder="Pick" />
        </Select.Trigger>
        <Select.Content>
          <Select.Group>
            <Select.GroupLabel>Apples</Select.GroupLabel>
            <Select.Item value="gala">Gala</Select.Item>
          </Select.Group>
          <Select.Separator />
          <Select.Group>
            <Select.GroupLabel>Pears</Select.GroupLabel>
            <Select.Item value="bosc">Bosc</Select.Item>
          </Select.Group>
        </Select.Content>
      </Select.Root>
    );
    await click(trigger());
    const groups = all('[role="group"]');
    expect(groups).toHaveLength(2);
    // The heading is the group's accessible name rather than a row above it.
    expect(groups[0].getAttribute('aria-labelledby')).toBe(
      groups[0].querySelector('[id]')?.getAttribute('id')
    );
    // A separator inside a listbox is decorative, so Base UI gives it
    // `role="presentation"` rather than announcing it as a landmark.
    expect(all('[role="listbox"] > [role="presentation"]')).toHaveLength(1);
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
