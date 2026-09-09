import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Button } from '../src/button/button';
import { forcedThemeClassNames } from '../src/theme/theme';

describe('Button', () => {
  test('renders a native button with variant and size data attributes', () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).toMatch(/^<button/);
    expect(html).toContain('data-variant="primary"');
    expect(html).toContain('data-size="medium"');
    expect(html).toContain('type="button"');
  });

  test('appends a caller className after the compiled classes', () => {
    const html = renderToStaticMarkup(
      <Button variant="ghost" size="small" className="w-full">
        Go
      </Button>
    );
    const cls = /class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(cls.endsWith(' w-full')).toBe(true);
    expect(cls.split(' ').length).toBeGreaterThan(5);
  });

  test('render swaps the element', () => {
    const html = renderToStaticMarkup(<Button render={<a href="/x" />}>Link</Button>);
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/x"');
  });

  test('forced theme class names exist for light and dark, none for system', () => {
    expect(forcedThemeClassNames('dark').length).toBeGreaterThan(0);
    expect(forcedThemeClassNames('light').length).toBeGreaterThan(0);
    expect(forcedThemeClassNames('dark')).not.toEqual(forcedThemeClassNames('light'));
    expect(forcedThemeClassNames('system')).toEqual([]);
  });
});
