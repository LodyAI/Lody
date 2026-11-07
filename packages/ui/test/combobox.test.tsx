import { afterEach, describe, expect, test } from 'vitest';
import { Combobox } from '../src/field/combobox';
import { Field } from '../src/field/field';
import { Input } from '../src/field/input';

import { all, click, mount, one, press, typeInto, type Mounted } from './dom';

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

const input = () => one('input[role="combobox"]') as HTMLInputElement;
const isOpen = () => input().getAttribute('aria-expanded') === 'true';
const options = () => all('[role="listbox"] [role="option"]');
const labels = () => options().map((row) => row.textContent);

describe('Combobox input', () => {
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
});

describe('Combobox input group', () => {
  test('the chevron beside the input opens the same list', async () => {
    mounted = await mount(<Languages grouped />);
    const chevron = one('button[aria-label="Open the list"]');
    expect(chevron.tagName).toBe('BUTTON');
    await click(chevron);
    expect(isOpen()).toBe(true);
    expect(labels()).toEqual(LANGUAGES);
  });
});

describe('Combobox button', () => {
  function Fonts(props: Partial<React.ComponentProps<typeof Combobox.Root<string>>>) {
    return (
      <Combobox.Root items={LANGUAGES} {...props}>
        <Combobox.Button aria-label="Language" placeholder="Pick a language" />
        <Combobox.Content
          search={<Combobox.Search placeholder="Search languages" />}
          empty={<Combobox.Empty>No language matches.</Combobox.Empty>}
        >
          {(item: string) => (
            <Combobox.Item key={item} value={item}>
              {item}
            </Combobox.Item>
          )}
        </Combobox.Content>
      </Combobox.Root>
    );
  }
  const button = () => one('button[aria-label="Language"]') as HTMLButtonElement;
  const search = () =>
    document.querySelector<HTMLInputElement>('input[placeholder="Search languages"]');

  test('opens a list that starts with its own search, and a pick lands on the button', async () => {
    mounted = await mount(<Fonts />);
    await click(button());
    // The search is part of the popup, not the page: the button stays a button.
    expect(search()).not.toBeNull();
    expect(button().contains(search())).toBe(false);

    await typeInto(search()!, 'ru');
    expect(labels()).toEqual(['Rust', 'Ruby']);

    await click(options()[1]);
    expect(button().textContent).toContain('Ruby');
  });
});
