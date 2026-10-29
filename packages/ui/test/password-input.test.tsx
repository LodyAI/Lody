import { renderToStaticMarkup } from 'react-dom/server';
import { act, createRef } from 'react';
import { describe, expect, test } from 'vitest';
import { Field } from '../src/field/field';
import { PasswordInput } from '../src/field/password-input';
import { classesOf, click, mount, one } from './dom';

const secret = () => one('input[type="password"], input[type="text"]') as HTMLInputElement;
const reveal = () => one('button') as HTMLButtonElement;

describe('PasswordInput', () => {
  test('resizing the shell preserves the input ref, native height, style callback and reveal state', async () => {
    const ref = createRef<HTMLInputElement>();
    const view = await mount(
      <PasswordInput
        ref={ref}
        controlHeight={40}
        height={17}
        defaultValue="Retained secret"
        style={() => ({ height: 23, letterSpacing: '1px' })}
      />
    );
    const input = ref.current!;
    expect(input.style.height).toBe('23px');
    expect(input.getAttribute('height')).toBe('17');
    await click(reveal());
    input.focus();
    await act(async () => {
      view.root.render(
        <PasswordInput
          ref={ref}
          controlHeight={0}
          height={18}
          defaultValue="Retained secret"
          style={() => ({ height: 22 })}
        />
      );
    });
    expect(ref.current).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.type).toBe('text');
    expect(input.value).toBe('Retained secret');
    expect(input.style.height).toBe('22px');
    expect(input.style.letterSpacing).toBe('');
    expect(input.getAttribute('height')).toBe('18');
    await act(async () => {
      view.root.render(<PasswordInput ref={ref} defaultValue="Retained secret" />);
    });
    expect(ref.current).toBe(input);
    expect(input.type).toBe('text');
    expect(input.style.height).toBe('');
    expect(input.getAttribute('height')).toBeNull();
    await click(reveal());
    expect(input.type).toBe('password');
    expect(input.value).toBe('Retained secret');
    await view.unmount();
  });

  test('masks the value until somebody asks, and says which it will do next', async () => {
    const view = await mount(<PasswordInput />);
    expect(secret().type).toBe('password');
    expect(reveal().getAttribute('aria-label')).toBe('Show password');
    expect(reveal().getAttribute('aria-pressed')).toBe('false');

    await click(reveal());
    expect(secret().type).toBe('text');
    expect(reveal().getAttribute('aria-label')).toBe('Hide password');
    expect(reveal().getAttribute('aria-pressed')).toBe('true');

    await click(reveal());
    expect(secret().type).toBe('password');
    await view.unmount();
  });

  test('what a person typed survives the reveal', async () => {
    const view = await mount(<PasswordInput defaultValue="hunter2" />);
    await click(reveal());
    expect(secret().value).toBe('hunter2');
    await view.unmount();
  });

  test('a localised surface renames the reveal in both of its states', async () => {
    const view = await mount(<PasswordInput labels={{ show: '显示密码', hide: '隐藏密码' }} />);
    expect(reveal().getAttribute('aria-label')).toBe('显示密码');
    await click(reveal());
    expect(reveal().getAttribute('aria-label')).toBe('隐藏密码');
    await view.unmount();
  });

  test('the label reaches the value, and the reveal points at it', () => {
    // The shell is built from the input's own `render`, so the input stays the
    // field's one control: a shell that opened a labelable scope of its own
    // would leave this label pointing at a control that does not exist.
    const html = renderToStaticMarkup(
      <Field.Root>
        <Field.Label>Password</Field.Label>
        <PasswordInput />
      </Field.Root>
    );
    const labelFor = /<label\b[^>]*for="([^"]*)"/.exec(html)?.[1];
    const inputId = /<input\b[^>]*id="([^"]*)"/.exec(html)?.[1];
    expect(labelFor).toBeTruthy();
    expect(inputId).toBe(labelFor);
    expect(html).toContain(`aria-controls="${inputId}"`);
  });

  test('a disabled field reaches the reveal, not only the value', async () => {
    const view = await mount(
      <Field.Root disabled>
        <Field.Label>Password</Field.Label>
        <PasswordInput />
      </Field.Root>
    );
    expect(secret().disabled).toBe(true);
    // The whole point of reading the state rather than taking a prop: nothing
    // here passed `disabled` to the reveal, and a bright eye on a dimmed field
    // is a control that looks pressable and is not.
    expect(reveal().disabled).toBe(true);
    await view.unmount();
  });

  test('an invalid field rings the shell, which is the control', async () => {
    const plain = await mount(<PasswordInput />);
    const resting = classesOf(secret().parentElement as HTMLElement);
    await plain.unmount();

    const view = await mount(
      <Field.Root invalid>
        <Field.Label>Password</Field.Label>
        <PasswordInput />
      </Field.Root>
    );
    expect(secret().getAttribute('aria-invalid')).toBe('true');
    const shell = secret().parentElement as HTMLElement;
    expect(classesOf(shell).filter((name) => !resting.includes(name)).length).toBeGreaterThan(0);
    // The input inside the shell is bare: two wells would draw two edges.
    expect(classesOf(secret()).length).toBeLessThan(classesOf(shell).length);
    await view.unmount();
  });

  test('a caller constrains the control through the shell, and the value through the input', () => {
    const html = renderToStaticMarkup(
      <PasswordInput className="w-64" inputClassName="font-mono" aria-label="Password" />
    );
    const shell = /<div\b[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    const value = /<input\b[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    // The shell is the control, so a width lands there and reaches the value
    // below it; only what the value alone wears goes on the input.
    expect(shell.split(' ')).toContain('w-64');
    expect(shell.split(' ')).not.toContain('font-mono');
    expect(value.split(' ')).toContain('font-mono');
    expect(value.split(' ')).not.toContain('w-64');
  });
});
