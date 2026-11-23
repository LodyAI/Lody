import { describe, expect, test } from 'vitest';
import { Field } from '../src/field/field';
import { Input } from '../src/field/input';
import { NumberField } from '../src/field/number-field';
import { all, classesOf, click, mount, one, press } from './dom';

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
