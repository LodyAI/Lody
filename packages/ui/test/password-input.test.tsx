import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Field } from '../src/field/field';
import { PasswordInput } from '../src/field/password-input';
import { click, mount, one } from './dom';

const secret = () => one('input[type="password"], input[type="text"]') as HTMLInputElement;
const reveal = () => one('button') as HTMLButtonElement;

describe('PasswordInput', () => {
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
});
