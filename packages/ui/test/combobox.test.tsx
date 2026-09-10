import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';
import { Combobox } from '../src/field/combobox';
import { Field } from '../src/field/field';
import { Input } from '../src/field/input';
import { Select } from '../src/field/select';
import { all, classesOf, click, mount, one, press, typeInto, type Mounted } from './dom';

const LANGUAGES = ['TypeScript', 'Rust', 'Python', 'Ruby'];

function Languages({
  grouped = false,
  ...rest
}: { grouped?: boolean } & Partial<React.ComponentProps<typeof Combobox.Root<string>>>) {
  return (
    <Combobox.Root items={LANGUAGES} {...rest}>
      {grouped ? (
        <Combobox.InputGroup>
          <Combobox.Input placeholder="Search a language" />
          <Combobox.Trigger aria-label="Open the list" />
        </Combobox.InputGroup>
      ) : (
        <Combobox.Input placeholder="Search a language" />
      )}
      <Combobox.Content empty={<Combobox.Empty>No language matches.</Combobox.Empty>}>
        {(item: string) => (
          <Combobox.Item key={item} value={item}>
            {item}
          </Combobox.Item>
        )}
      </Combobox.Content>
    </Combobox.Root>
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

const input = () => one('input[role="combobox"]') as HTMLInputElement;
/** The control inside one mounted tree, when two are on the page at once. */
const comboboxIn = (root: HTMLElement) =>
  root.querySelector('input[role="combobox"]') as HTMLInputElement;
const isOpen = () => input().getAttribute('aria-expanded') === 'true';
const options = () => all('[role="listbox"] [role="option"]');
const labels = () => options().map((row) => row.textContent);

describe('Combobox input', () => {
  test('is a text control that announces the list it filters', async () => {
    mounted = await mount(<Languages />);
    expect(input().tagName).toBe('INPUT');
    expect(input().getAttribute('aria-autocomplete')).toBe('list');
    expect(isOpen()).toBe(false);
  });

  test('typing narrows the list to what matches', async () => {
    mounted = await mount(<Languages />);
    await click(input());
    expect(labels()).toEqual(LANGUAGES);

    await typeInto(input(), 'ru');
    // The filter is Base UI's, not ours; what this pins is that the primitive
    // hands it the query rather than swallowing it.
    expect(labels()).toEqual(['Rust', 'Ruby']);
  });

  test('a query that matches nothing says so instead of showing an empty box', async () => {
    mounted = await mount(<Languages />);
    await click(input());
    await typeInto(input(), 'zzz');
    expect(options()).toHaveLength(0);
    expect(one('[role="listbox"]').parentElement?.textContent).toContain('No language matches.');
  });

  test('the arrow keys walk the filtered list and Enter takes the highlighted row', async () => {
    mounted = await mount(<Languages />);
    await click(input());
    await typeInto(input(), 'ru');
    await press('ArrowDown');
    expect(options()[0].hasAttribute('data-highlighted')).toBe(true);
    await press('ArrowDown');
    expect(options()[1].hasAttribute('data-highlighted')).toBe(true);

    await press('Enter');
    expect(isOpen()).toBe(false);
    expect(input().value).toBe('Ruby');
  });

  test('Escape closes the list and leaves the value alone', async () => {
    mounted = await mount(<Languages defaultValue="Rust" />);
    await click(input());
    expect(isOpen()).toBe(true);
    await press('Escape');
    expect(isOpen()).toBe(false);
    expect(input().value).toBe('Rust');
  });

  test('the row that holds the value is the one marked selected and ticked', async () => {
    mounted = await mount(<Languages defaultValue="Python" />);
    await click(input());
    const rows = options();
    expect(rows.map((row) => row.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
    expect(rows.filter((row) => row.querySelector('svg'))).toHaveLength(1);
  });

  test('wears the same invalid ring a text control does', async () => {
    expect(RING_CLASSES.length).toBeGreaterThan(0);
    mounted = await mount(
      <Field.Root invalid>
        <Languages />
      </Field.Root>
    );
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(RING_CLASSES.every((name) => classesOf(input()).includes(name))).toBe(true);
  });

  test('a disabled field reaches the control and the list stays shut', async () => {
    mounted = await mount(
      <Field.Root disabled>
        <Languages />
      </Field.Root>
    );
    expect(input().disabled).toBe(true);
    await click(input());
    expect(isOpen()).toBe(false);
  });

  test('a caller className lands after the compiled classes', async () => {
    mounted = await mount(
      <Combobox.Root items={LANGUAGES}>
        <Combobox.Input className="w-64" />
        <Combobox.Content>
          {(item: string) => (
            <Combobox.Item key={item} value={item}>
              {item}
            </Combobox.Item>
          )}
        </Combobox.Content>
      </Combobox.Root>
    );
    const classes = classesOf(input());
    expect(classes[classes.length - 1]).toBe('w-64');
    expect(classes.length).toBeGreaterThan(5);
  });
});

describe('Combobox input group', () => {
  const group = () => one('input[role="combobox"]').parentElement as HTMLElement;

  test('the group is the well and the input inside it is bare', async () => {
    const solo = await mount(<Languages />);
    const alone = classesOf(comboboxIn(solo.container));
    await solo.unmount();

    mounted = await mount(<Languages grouped />);
    const bare = classesOf(input());
    // A control that kept its own well inside the group would draw two: the
    // bare input drops the background, the shadow, the radius and the height,
    // and the group carries them instead.
    expect(bare.length).toBeLessThan(alone.length);
    expect(classesOf(group()).length).toBeGreaterThan(bare.length);
  });

  test('the ring goes around the group when the input inside it takes focus', async () => {
    mounted = await mount(<Languages grouped />);
    const resting = classesOf(group());
    // `:focus-within` is a compiled condition, not a state read in JS, so what
    // the group carries at rest already contains the focused declaration; this
    // pins that the ring is declared on the group rather than on the input.
    expect(resting.length).toBeGreaterThan(10);
    expect(classesOf(input())).not.toEqual(expect.arrayContaining(RING_CLASSES));
  });

  test('an invalid group rings the whole control, not the bare input', async () => {
    mounted = await mount(
      <Field.Root invalid>
        <Languages grouped />
      </Field.Root>
    );
    const invalidGroup = classesOf(comboboxIn(mounted.container).parentElement as HTMLElement);
    const valid = await mount(<Languages grouped />);
    const validGroup = classesOf(comboboxIn(valid.container).parentElement as HTMLElement);
    await valid.unmount();
    expect(invalidGroup.filter((name) => !validGroup.includes(name)).length).toBeGreaterThan(0);
    expect(classesOf(comboboxIn(mounted.container))).not.toEqual(
      expect.arrayContaining(RING_CLASSES)
    );
  });

  test('the chevron beside the input opens the same list', async () => {
    mounted = await mount(<Languages grouped />);
    const chevron = one('button[aria-label="Open the list"]');
    expect(chevron.tagName).toBe('BUTTON');
    await click(chevron);
    expect(isOpen()).toBe(true);
    expect(labels()).toEqual(LANGUAGES);
  });

  test('a disabled field dims the group, which `:disabled` cannot reach', async () => {
    const enabled = await mount(<Languages grouped />);
    const enabledGroup = classesOf(comboboxIn(enabled.container).parentElement as HTMLElement);
    await enabled.unmount();

    mounted = await mount(
      <Field.Root disabled>
        <Languages grouped />
      </Field.Root>
    );
    const disabledGroup = classesOf(group());
    // One class more than the enabled group: the family's one disabled opacity.
    expect(disabledGroup.filter((name) => !enabledGroup.includes(name))).toHaveLength(1);
  });
});

describe('the surface Select and Combobox share', () => {
  test('a row in either list is the same row', async () => {
    const combobox = await mount(<Languages />);
    await click(one('input[role="combobox"]'));
    const comboRow = classesOf(all('[role="listbox"] [role="option"]')[1]);
    await combobox.unmount();

    mounted = await mount(
      <Select.Root items={LANGUAGES.map((label) => ({ value: label, label }))}>
        <Select.Trigger>
          <Select.Value placeholder="Pick" />
        </Select.Trigger>
        <Select.Content>
          {LANGUAGES.map((item) => (
            <Select.Item key={item} value={item}>
              {item}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    );
    await click(one('button[role="combobox"]'));
    const selectRow = classesOf(all('[role="listbox"] [role="option"]')[1]);
    // Neither component styles a row of its own: both take `popup/surface.ts`,
    // so a change to the list appearance cannot land on one and miss the other.
    expect(selectRow).toEqual(comboRow);
  });
});
