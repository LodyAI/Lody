import * as stylex from '@stylexjs/stylex';

import { mount, typeInto } from './dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, createRef, useState } from 'react';
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

  test.each([
    { name: 'plain', leading: undefined, trailing: undefined },
    { name: 'leading', leading: '/', trailing: undefined },
    { name: 'trailing', leading: undefined, trailing: <span>Connected to preview server</span> },
    { name: 'both slots', leading: '/', trailing: <span>Connected to preview server</span> },
  ])(
    'a resized input retains native attributes, ref and caller style ($name)',
    async ({ leading, trailing }) => {
      const ref = createRef<HTMLInputElement>();
      const view = await mount(
        <Input
          ref={ref}
          leading={leading}
          trailing={trailing}
          controlHeight={40}
          height={17}
          defaultValue="Retained input"
          style={(state) => ({ height: state.disabled ? 19 : 44, letterSpacing: '1px' })}
        />
      );
      const input = ref.current!;
      input.focus();
      expect(input.getAttribute('height')).toBe('17');
      expect(input.style.height).toBe('44px');
      expect(input.style.letterSpacing).toBe('1px');
      await act(async () => {
        view.root.render(
          <Input
            ref={ref}
            leading={leading}
            trailing={trailing}
            controlHeight={0}
            height={18}
            defaultValue="Retained input"
            disabled
            style={(state) => ({ height: state.disabled ? 19 : 44 })}
          />
        );
      });
      expect(ref.current).toBe(input);
      expect(input.value).toBe('Retained input');
      expect(input.disabled).toBe(true);
      expect(input.getAttribute('height')).toBe('18');
      expect(input.style.height).toBe('19px');
      expect(input.style.letterSpacing).toBe('');
      await act(async () => {
        view.root.render(
          <Input
            ref={ref}
            leading={leading}
            trailing={trailing}
            defaultValue="Retained input"
            style={{ height: 46 }}
          />
        );
      });
      expect(ref.current).toBe(input);
      expect(input.getAttribute('height')).toBeNull();
      expect(input.disabled).toBe(false);
      expect(input.value).toBe('Retained input');
      expect(input.style.height).toBe('46px');
      await view.unmount();
    }
  );

  test('both slots keep the label, editing, keyboard action and dynamic shell styling on one input', async () => {
    const ref = createRef<HTMLInputElement>();
    const extension = stylex.create({ width: (width: number) => ({ maxWidth: width }) });
    function Address() {
      const [value, setValue] = useState('https://preview.local');
      const [submitted, setSubmitted] = useState('');
      return (
        <Field.Root name="preview-url" invalid>
          <Field.Label>Preview address</Field.Label>
          <Input
            ref={ref}
            leading="/"
            trailing={<span data-status>Connected to preview server</span>}
            value={value}
            onValueChange={setValue}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setSubmitted(event.currentTarget.value);
            }}
            xstyle={extension.width(280)}
            className="shell-hook"
            inputClassName="value-hook"
            style={{ letterSpacing: '1px' }}
          />
          <output>{submitted}</output>
        </Field.Root>
      );
    }
    const view = await mount(<Address />);
    try {
      const input = ref.current!;
      const shell = input.closest<HTMLElement>('[data-slot="input-shell"]')!;
      expect(shell.querySelectorAll('input')).toHaveLength(1);
      expect(shell.classList.contains('shell-hook')).toBe(true);
      expect(input.classList.contains('value-hook')).toBe(true);
      expect(input.classList.contains('shell-hook')).toBe(false);
      expect(input.style.letterSpacing).toBe('1px');
      const variables = stylex.props(extension.width(280)).style!;
      expect(Object.keys(variables).length).toBeGreaterThan(0);
      for (const [name, value] of Object.entries(variables)) {
        expect(shell.style.getPropertyValue(name)).toBe(value);
        expect(input.style.getPropertyValue(name)).toBe('');
      }
      expect(input.previousElementSibling?.getAttribute('data-slot')).toBe('input-leading');
      expect(input.nextElementSibling?.getAttribute('data-slot')).toBe('input-trailing');
      expect(input.nextElementSibling?.textContent).toBe('Connected to preview server');
      expect(view.container.querySelector('label')?.htmlFor).toBe(input.id);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      input.focus();
      await typeInto(input, 'https://preview.local/updated');
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(ref.current).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(view.container.querySelector('output')?.textContent).toBe(
        'https://preview.local/updated'
      );
    } finally {
      await view.unmount();
    }
  });
});
