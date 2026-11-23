import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Field } from '../src/field/field';

import { Input } from '../src/field/input';

function classesOf(html: string, tag: string): string[] {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  return (/class="([^"]*)"/.exec(open)?.[1] ?? '').split(' ').filter(Boolean);
}

function attrOf(html: string, tag: string, attribute: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  return new RegExp(`${attribute}="([^"]*)"`).exec(open)?.[1];
}

/**
 * The classes `aria-invalid` adds on its own. Derived rather than written down,
 * and asserted non-empty here so a regression that stops applying the ring
 * cannot leave the tests below quietly passing against an empty set.
 */
const RING_CLASSES = (() => {
  const valid = classesOf(renderToStaticMarkup(<Input />), 'input');
  const invalid = classesOf(renderToStaticMarkup(<Input aria-invalid="true" />), 'input');
  return invalid.filter((name) => !valid.includes(name));
})();

const named = (
  <Field.Root name="title">
    <Field.Label>Session title</Field.Label>
    <Input placeholder="Describe the task" />
    <Field.Description>Shown in the sidebar.</Field.Description>
    <Field.Error match="valueMissing">Enter a title.</Field.Error>
  </Field.Root>
);

describe('Field', () => {
  test('the parts render outside a field instead of throwing', () => {
    // Base UI's Label, Description and Error require a Field.Root; a surface
    // that only wants a label for its own control must not crash.
    const html = renderToStaticMarkup(
      <div>
        <Field.Label htmlFor="standalone">Session title</Field.Label>
        <input id="standalone" />
        <Field.Description>Shown in the sidebar.</Field.Description>
        <Field.Error>Enter a title.</Field.Error>
      </div>
    );
    expect(attrOf(html, 'label', 'for')).toBe('standalone');
    expect(html).toContain('Session title');
    expect(html).toContain('<p');
    expect(html).toContain('Shown in the sidebar.');
    expect(html).toContain('Enter a title.');
    expect(classesOf(html, 'label').length).toBeGreaterThan(0);
  });

  test('the label is associated with the control the field renders', () => {
    const html = renderToStaticMarkup(named);
    const control = attrOf(html, 'input', 'id');
    expect(control).toBeTruthy();
    expect(attrOf(html, 'label', 'for')).toBe(control);
  });

  test('a field that reports no error keeps it out of the markup', () => {
    const html = renderToStaticMarkup(named);
    expect(html).toContain('Shown in the sidebar.');
    expect(html).not.toContain('Enter a title.');
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('data-invalid');
  });

  test('invalid marks the control, shows the error, and adds a ring class', () => {
    const valid = renderToStaticMarkup(named);
    const invalid = renderToStaticMarkup(
      <Field.Root name="title" invalid>
        <Field.Label>Session title</Field.Label>
        <Input placeholder="Describe the task" />
        <Field.Error match>Enter a title.</Field.Error>
      </Field.Root>
    );
    expect(invalid).toContain('aria-invalid="true"');
    expect(invalid).toContain('Enter a title.');
    const added = classesOf(invalid, 'input').filter(
      (name) => !classesOf(valid, 'input').includes(name)
    );
    expect(added.length).toBeGreaterThan(0);
  });

  test('disabled on the root disables the control and dims the label', () => {
    const enabled = renderToStaticMarkup(named);
    const html = renderToStaticMarkup(
      <Field.Root name="title" disabled>
        <Field.Label>Session title</Field.Label>
        <Input />
      </Field.Root>
    );
    expect(html).toContain('disabled=""');
    const added = classesOf(html, 'label').filter(
      (name) => !classesOf(enabled, 'label').includes(name)
    );
    expect(added.length).toBeGreaterThan(0);
  });
});

describe('Input and Textarea', () => {
  test('the ring follows what ARIA calls invalid, not just the literal true', () => {
    expect(RING_CLASSES.length).toBeGreaterThan(0);
    for (const value of [true, 'true', 'grammar', 'spelling'] as const) {
      const cls = classesOf(renderToStaticMarkup(<Input aria-invalid={value} />), 'input');
      expect(
        RING_CLASSES.every((name) => cls.includes(name)),
        `${String(value)} rings`
      ).toBe(true);
    }
    for (const value of [false, 'false', undefined] as const) {
      const cls = classesOf(renderToStaticMarkup(<Input aria-invalid={value} />), 'input');
      expect(
        RING_CLASSES.some((name) => cls.includes(name)),
        `${String(value)} does not ring`
      ).toBe(false);
    }
  });

  test('a leading part shares the well with the value, and the label still reaches it', () => {
    const html = renderToStaticMarkup(
      <Field.Root>
        <Field.Label>Name</Field.Label>
        <Input leading={<span data-glyph="">🔍</span>} placeholder="Code Reviewer" />
      </Field.Root>
    );
    // One control: the shell is the well, and the glyph comes before the value
    // inside it rather than standing beside it as a second edge.
    const shell = /<div\b[^>]*data-size="medium"[^>]*>([\s\S]*)<\/div>/.exec(html)?.[1] ?? '';
    expect(shell.indexOf('data-glyph')).toBeGreaterThan(-1);
    expect(shell.indexOf('data-glyph')).toBeLessThan(shell.indexOf('<input'));
    const labelFor = /<label\b[^>]*for="([^"]*)"/.exec(html)?.[1];
    const inputId = /<input\b[^>]*id="([^"]*)"/.exec(html)?.[1];
    expect(labelFor).toBeTruthy();
    expect(inputId).toBe(labelFor);
  });
});
