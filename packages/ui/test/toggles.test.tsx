import * as stylex from '@stylexjs/stylex';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Checkbox } from '../src/field/checkbox';
import { Field } from '../src/field/field';
import { Input } from '../src/field/input';
import { Radio, RadioGroup } from '../src/field/radio';
import { Switch } from '../src/field/switch';
import { corner } from '../src/tokens/scales.stylex';

function classesOf(html: string, tag: string, occurrence = 0): string[] {
  const open = html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g'))?.[occurrence] ?? '';
  return (/class="([^"]*)"/.exec(open)?.[1] ?? '').split(' ').filter(Boolean);
}

function attrOf(html: string, tag: string, attribute: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  return new RegExp(`${attribute}="([^"]*)"`).exec(open)?.[1];
}

/** What the invalid ring adds to a text control, derived rather than written down. */
const RING_CLASSES = (() => {
  const valid = classesOf(renderToStaticMarkup(<Input />), 'input');
  const invalid = classesOf(renderToStaticMarkup(<Input aria-invalid="true" />), 'input');
  return invalid.filter((name) => !valid.includes(name));
})();

describe('Checkbox', () => {
  test('renders a real button carrying the checkbox role, with a hidden input beside it', () => {
    const html = renderToStaticMarkup(<Checkbox name="notify" />);
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('<input');
    expect(html).toContain('type="checkbox"');
  });

  test('the tick appears only once the box holds a value', () => {
    expect(renderToStaticMarkup(<Checkbox />)).not.toContain('<svg');
    expect(renderToStaticMarkup(<Checkbox defaultChecked />)).toContain('<svg');
  });

  test('a mixed box announces mixed and draws the dash instead of the tick', () => {
    const mixed = renderToStaticMarkup(<Checkbox indeterminate />);
    expect(mixed).toContain('aria-checked="mixed"');
    // The tick is a polyline and the dash a single horizontal run; the mixed box
    // must not fall back to the tick, which would state a value it does not hold.
    expect(mixed).toContain('d="M2.2 5h5.6"');
    expect(mixed).not.toContain('d="M1.6 5.2 3.9 7.5 8.4 2.7"');
  });

  test('a mixed box wears the same ink as a checked one', () => {
    const checked = classesOf(renderToStaticMarkup(<Checkbox defaultChecked />), 'button');
    const mixed = classesOf(renderToStaticMarkup(<Checkbox indeterminate />), 'button');
    expect(mixed).toEqual(checked);
  });

  test('checked swaps the well for the ink fill rather than adding to it', () => {
    const off = classesOf(renderToStaticMarkup(<Checkbox />), 'button');
    const on = classesOf(renderToStaticMarkup(<Checkbox defaultChecked />), 'button');
    expect(on.filter((name) => !off.includes(name)).length).toBeGreaterThan(0);
    expect(off.filter((name) => !on.includes(name)).length).toBeGreaterThan(0);
  });
});

describe('Switch', () => {
  test('renders a real button carrying the switch role', () => {
    const html = renderToStaticMarkup(<Switch name="beta" />);
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
  });

  test('the thumb differs between the two tracks by its travel alone', () => {
    const off = classesOf(renderToStaticMarkup(<Switch />), 'span');
    const on = classesOf(renderToStaticMarkup(<Switch defaultChecked />), 'span');
    // One class swaps for one class: the resting transform for the travelled
    // one. Anything more would be the thumb restyling itself per state.
    expect(on.filter((name) => !off.includes(name))).toHaveLength(1);
    expect(off.filter((name) => !on.includes(name))).toHaveLength(1);
  });
});

describe('RadioGroup', () => {
  const group = (
    <RadioGroup name="mode" defaultValue="ask">
      <Radio value="ask" />
      <Radio value="auto" />
    </RadioGroup>
  );

  test('the group and its options carry the roles a screen reader needs', () => {
    const html = renderToStaticMarkup(group);
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
  });

  test('only the selected option shows its dot', () => {
    const html = renderToStaticMarkup(group);
    expect(html.match(/<span/g)).toHaveLength(1);
  });

  test('the group submits one name for every option', () => {
    const html = renderToStaticMarkup(group);
    expect(html.match(/name="mode"/g)).toHaveLength(2);
    expect(html.match(/value="ask"|value="auto"/g)).toHaveLength(2);
  });
});

/**
 * StyleX hashes a class per property, value and condition, so re-declaring the
 * two corner shapes here yields the same classes the primitives carry. Derived
 * rather than written down, so this cannot drift from the compiler.
 */
const CORNERS = stylex.create({
  squircle: { cornerShape: corner.shape },
  round: { cornerShape: corner.round },
});
const SQUIRCLE = stylex.props(CORNERS.squircle).className ?? '';
const ROUND = stylex.props(CORNERS.round).className ?? '';

describe('pills are round, not squircles', () => {
  test('the two corner shapes really are different classes', () => {
    expect(SQUIRCLE).not.toBe('');
    expect(ROUND).not.toBe('');
    expect(SQUIRCLE).not.toBe(ROUND);
  });

  test('a switch track and a radio drop the well squircle', () => {
    // A squircle at radius.full is a superellipse: it would make the track a
    // rounded rectangle and the radio a squircle rather than a circle.
    for (const [control, name] of [
      [<Switch key="s" />, 'switch'],
      [
        <RadioGroup key="g" name="mode">
          <Radio value="ask" />
        </RadioGroup>,
        'radio',
      ],
    ] as const) {
      const cls = classesOf(renderToStaticMarkup(control), 'button');
      expect(cls, `${name} is round`).toContain(ROUND);
      expect(cls, `${name} is not a squircle`).not.toContain(SQUIRCLE);
    }
  });

  test('a checkbox keeps the squircle, which is what its radius is for', () => {
    const cls = classesOf(renderToStaticMarkup(<Checkbox />), 'button');
    expect(cls).toContain(SQUIRCLE);
    expect(cls).not.toContain(ROUND);
  });
});

describe('the family the three join', () => {
  test('they share the box styles rather than each defining their own', () => {
    const checkbox = classesOf(renderToStaticMarkup(<Checkbox />), 'button');
    const radio = classesOf(
      renderToStaticMarkup(
        <RadioGroup name="mode">
          <Radio value="ask" />
        </RadioGroup>
      ),
      'button'
    );
    const toggle = classesOf(renderToStaticMarkup(<Switch />), 'button');
    const shared = checkbox.filter((name) => radio.includes(name) && toggle.includes(name));
    expect(shared.length).toBeGreaterThan(10);
  });

  test('an unchecked control wears the same invalid ring as a text control', () => {
    expect(RING_CLASSES.length).toBeGreaterThan(0);
    for (const control of [
      <Checkbox key="c" aria-invalid="true" />,
      <Switch key="s" aria-invalid="true" />,
    ]) {
      const cls = classesOf(renderToStaticMarkup(control), 'button');
      expect(RING_CLASSES.every((name) => cls.includes(name))).toBe(true);
    }
  });

  test('a checked control keeps the invalid ring on its own ink edge', () => {
    const checked = classesOf(renderToStaticMarkup(<Checkbox defaultChecked />), 'button');
    const invalid = classesOf(
      renderToStaticMarkup(<Checkbox defaultChecked aria-invalid="true" />),
      'button'
    );
    const added = invalid.filter((name) => !checked.includes(name));
    expect(added.length).toBeGreaterThan(0);
    // The ring is composed with the ink edge, so it cannot be the class a
    // welled control uses; a checked box that reused it would lose its edge.
    expect(added.some((name) => RING_CLASSES.includes(name))).toBe(false);
  });

  test('the field owns disabled, validity and the label association', () => {
    const html = renderToStaticMarkup(
      <Field.Root name="notify" disabled>
        <Field.Label>
          Notify me
          <Checkbox />
        </Field.Label>
      </Field.Root>
    );
    // A native button takes the disabled attribute, so the same `:disabled`
    // rule that dims an Input dims these without a second mechanism.
    expect(html).toContain('disabled=""');
    expect(attrOf(html, 'label', 'for')).toBe(attrOf(html, 'button', 'id'));
  });

  test('a field marked invalid rings the control without the caller repeating it', () => {
    expect(RING_CLASSES.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(
      <Field.Root name="notify" invalid>
        <Checkbox />
      </Field.Root>
    );
    expect(html).toContain('aria-invalid="true"');
    expect(RING_CLASSES.every((name) => classesOf(html, 'button').includes(name))).toBe(true);
  });

  test('a caller className lands after the compiled classes', () => {
    for (const [control, tag] of [
      [<Checkbox key="c" className="mt-1" />, 'button'],
      [<Switch key="s" className="mt-1" />, 'button'],
      [
        <RadioGroup key="g" name="mode">
          <Radio value="ask" className="mt-1" />
        </RadioGroup>,
        'button',
      ],
    ] as const) {
      const cls = classesOf(renderToStaticMarkup(control), tag);
      expect(cls[cls.length - 1]).toBe('mt-1');
      expect(cls.length).toBeGreaterThan(5);
    }
  });
});
