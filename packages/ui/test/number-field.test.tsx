import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Field } from '../src/field/field';
import { Input } from '../src/field/input';
import { NumberField } from '../src/field/number-field';
import { all, classesOf, click, mount, one, press, typeInto } from './dom';

/** The control as a surface writes it: a value with a stepper either side. */
function Stepped(props: {
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (value: number | null) => void;
}) {
  const { onValueChange, ...root } = props;
  return (
    <NumberField.Root {...root} onValueChange={(value) => onValueChange?.(value)}>
      <NumberField.Group>
        <NumberField.Input aria-label="Font size" />
        <NumberField.Decrement />
        <NumberField.Increment />
      </NumberField.Group>
    </NumberField.Root>
  );
}

const input = () => one('input[aria-label="Font size"]') as HTMLInputElement;
const stepper = (label: string) => one(`button[aria-label="${label}"]`);

describe('NumberField', () => {
  test('hands a surface a number, not the string that was typed', async () => {
    const seen: (number | null)[] = [];
    const view = await mount(<Stepped defaultValue={14} onValueChange={(v) => seen.push(v)} />);
    await typeInto(input(), '18');
    expect(seen).toEqual([18]);
    // The point of the primitive: every caller that used `<Input type="number">`
    // parsed `event.target.value` itself, and a half-typed "1" parses to 1.
    expect(seen.every((value) => value === null || typeof value === 'number')).toBe(true);
    await view.unmount();
  });

  test('clamps a stepped value to the range instead of leaving it to the caller', async () => {
    const view = await mount(<Stepped defaultValue={20} min={1} max={20} />);
    await click(stepper('Increase'));
    expect(input().value).toBe('20');
    await view.unmount();
  });

  test('the steppers move by the step, and the arrow keys move the same way', async () => {
    const view = await mount(<Stepped defaultValue={14} min={8} max={32} step={2} />);
    await click(stepper('Increase'));
    expect(input().value).toBe('16');
    await click(stepper('Decrease'));
    expect(input().value).toBe('14');
    input().focus();
    await press('ArrowUp');
    expect(input().value).toBe('16');
    await view.unmount();
  });

  test('a stepper is out of the tab order, because the value takes the arrow keys', async () => {
    const view = await mount(<Stepped defaultValue={14} />);
    for (const label of ['Decrease', 'Increase']) {
      expect(stepper(label).getAttribute('tabindex')).toBe('-1');
    }
    // It is reachable by touch and pointer, so it is not hidden from the tree.
    expect(all('button[aria-hidden="true"]')).toHaveLength(0);
    await view.unmount();
  });

  test('a localised surface renames the steppers, since Base UI names them in English', () => {
    const html = renderToStaticMarkup(
      <NumberField.Root defaultValue={14}>
        <NumberField.Group>
          <NumberField.Input />
          <NumberField.Decrement aria-label="减小" />
          <NumberField.Increment aria-label="增大" />
        </NumberField.Group>
      </NumberField.Root>
    );
    expect(html).toContain('aria-label="减小"');
    expect(html).toContain('aria-label="增大"');
    expect(html).not.toContain('aria-label="Increase"');
  });

  test('the group is the well and the input inside it is bare', () => {
    const grouped = renderToStaticMarkup(
      <NumberField.Root defaultValue={14}>
        <NumberField.Group>
          <NumberField.Input />
        </NumberField.Group>
      </NumberField.Root>
    );
    const alone = renderToStaticMarkup(
      <NumberField.Root defaultValue={14}>
        <NumberField.Input />
      </NumberField.Root>
    );
    const inputClasses = (html: string) =>
      (/<input\b[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ').filter(Boolean);
    // Two wells would draw two edges around one control, so the grouped input
    // carries strictly fewer classes than the one that is the whole control.
    expect(inputClasses(grouped).length).toBeLessThan(inputClasses(alone).length);
    // On its own it is the same well as an Input on the same rung.
    const plain = (/<input\b[^>]*class="([^"]*)"/.exec(renderToStaticMarkup(<Input />))?.[1] ?? '')
      .split(' ')
      .filter(Boolean);
    expect(inputClasses(alone).filter((c) => plain.includes(c)).length).toBeGreaterThan(0);
  });

  test('an invalid field says so to a screen reader, not only to the eye', async () => {
    const plain = await mount(<Stepped defaultValue={14} />);
    const resting = classesOf(input().parentElement as HTMLElement);
    await plain.unmount();

    const view = await mount(
      <Field.Root invalid>
        <Field.Label>Font size</Field.Label>
        <Stepped defaultValue={14} />
      </Field.Root>
    );
    // Base UI marks a number field's input `data-invalid` and stops there, so
    // without this the ring would be the only sign the field is invalid.
    expect(input().getAttribute('aria-invalid')).toBe('true');
    // And the ring is the group's, not the input's: the group is the well.
    const ringed = classesOf(input().parentElement as HTMLElement);
    expect(ringed.filter((name) => !resting.includes(name)).length).toBeGreaterThan(0);
    await view.unmount();
  });

  test('a disabled field reaches the value and both steppers', async () => {
    const plain = await mount(<Stepped defaultValue={14} />);
    const resting = classesOf(input().parentElement as HTMLElement);
    await plain.unmount();

    const view = await mount(
      <Field.Root disabled>
        <Field.Label>Font size</Field.Label>
        <Stepped defaultValue={14} />
      </Field.Root>
    );
    expect(input().disabled).toBe(true);
    for (const label of ['Decrease', 'Increase']) {
      expect((stepper(label) as HTMLButtonElement).disabled).toBe(true);
    }
    // `:disabled` cannot reach a `<div>`, so the group dims from Base UI state.
    const group = input().parentElement as HTMLElement;
    expect(group.getAttribute('data-disabled')).toBe('');
    expect(classesOf(group).filter((name) => !resting.includes(name)).length).toBeGreaterThan(0);
    await view.unmount();
  });
});
