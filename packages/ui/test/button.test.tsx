import { renderToStaticMarkup } from 'react-dom/server';
import { act, createRef, useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { Button, type ButtonVariant } from '../src/button/button';
import { mount, type Mounted } from './dom';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('Button', () => {
  test('renders a native button with variant and size data attributes', () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).toMatch(/^<button/);
    expect(html).toContain('data-variant="primary"');
    expect(html).toContain('data-size="medium"');
    expect(html).toContain('type="button"');
  });

  test('an icon-only button gives what it holds a box, and a text one does not', () => {
    // This package's glyphs state their size as 100% of whatever holds them,
    // and StyleX has no descendant selector with which a button could reach
    // one — so without the box a 16px cross fills a 28px button edge to edge.
    const icon = renderToStaticMarkup(
      <Button variant="ghost" size="small" icon aria-label="Close">
        <svg />
      </Button>
    );
    expect(icon).toMatch(/<button[^>]*><span class="[^"]*"><svg><\/svg><\/span><\/button>/);
    // A label flows on its own; wrapping it would put the words in a 16px box.
    const text = renderToStaticMarkup(<Button>Save</Button>);
    expect(text).toMatch(/<button[^>]*>Save<\/button>/);
  });

  test('box, typography and variant updates preserve the button, glyph, focus, caller class and native disabled behavior', async () => {
    const ref = createRef<HTMLElement>();
    function Example() {
      const [box, setBox] = useState<{
        width?: number;
        height?: number;
        fontSize?: number;
        lineHeight?: number;
      }>({
        width: 96,
        height: 28,
        fontSize: 18,
        lineHeight: 1.25,
      });
      const [disabled, setDisabled] = useState(false);
      const [variant, setVariant] = useState<ButtonVariant>('primary');
      const [clicks, setClicks] = useState(0);
      return (
        <>
          <button
            data-zero
            onClick={() => {
              setBox({ width: 0, height: 0, fontSize: 0, lineHeight: 0 });
              setVariant('solid');
            }}
          >
            Zero
          </button>
          <button
            data-omit
            onClick={() => {
              setBox({});
              setVariant('ghost');
            }}
          >
            Omit
          </button>
          <button data-disable onClick={() => setDisabled(true)}>
            Disable
          </button>
          <Button
            ref={ref}
            icon
            width={box.width}
            height={box.height}
            fontSize={box.fontSize}
            lineHeight={box.lineHeight}
            disabled={disabled}
            variant={variant}
            className="caller-owned"
            style={{ width: 999, height: 999 }}
            data-target
            onClick={() => setClicks((n) => n + 1)}
            aria-label="Target"
          >
            <svg />
          </Button>
          <output>{clicks}</output>
        </>
      );
    }
    mounted = await mount(<Example />);
    const target = mounted.container.querySelector<HTMLButtonElement>('[data-target]')!;
    const glyph = target.firstElementChild;
    expect(target.style.fontSize).toBe('18px');
    expect(target.style.lineHeight).toBe('1.25');
    target.focus();
    expect(ref.current).toBe(target);
    for (const action of ['zero', 'omit']) {
      await act(async () =>
        mounted!.container.querySelector<HTMLButtonElement>(`[data-${action}]`)!.click()
      );
      expect(ref.current).toBe(target);
      expect(target.firstElementChild).toBe(glyph);
      expect(document.activeElement).toBe(target);
      expect(target.classList.contains('caller-owned')).toBe(true);
      expect(target.getAttribute('data-variant')).toBe(action === 'zero' ? 'solid' : 'ghost');
      expect(target.hasAttribute('width')).toBe(false);
      expect(target.hasAttribute('height')).toBe(false);
      expect(target.hasAttribute('fontSize')).toBe(false);
      expect(target.hasAttribute('lineHeight')).toBe(false);
      expect(target.style.width).toBe('');
      expect(target.style.height).toBe('');
      expect(target.style.fontSize).toBe(action === 'zero' ? '0px' : '');
      expect(target.style.lineHeight).toBe(action === 'zero' ? '0' : '');
      await act(async () => target.click());
    }
    expect(mounted.container.querySelector('output')?.textContent).toBe('2');
    await act(async () =>
      mounted!.container.querySelector<HTMLButtonElement>('[data-disable]')!.click()
    );
    expect(target.disabled).toBe(true);
    await act(async () => target.click());
    expect(mounted.container.querySelector('output')?.textContent).toBe('2');
  });

  test('a rendered anchor keeps its ref, inline dimensions and actual click state', async () => {
    const ref = createRef<HTMLElement>();
    function Example() {
      const [clicks, setClicks] = useState(0);
      return (
        <Button
          ref={ref}
          nativeButton={false}
          width={96}
          height={28}
          fontSize={12}
          lineHeight={1.3}
          render={
            <a href="/x" style={{ width: 105, height: 31, fontSize: 21, lineHeight: '31px' }} />
          }
          onClick={(event) => {
            event.preventDefault();
            setClicks((n) => n + 1);
          }}
        >
          Clicks: {clicks}
        </Button>
      );
    }
    mounted = await mount(<Example />);
    const anchor = mounted.container.querySelector('a')!;
    expect(ref.current).toBe(anchor);
    expect(anchor.getAttribute('href')).toBe('/x');
    expect(anchor.style.width).toBe('105px');
    expect(anchor.style.height).toBe('31px');
    expect(anchor.style.fontSize).toBe('21px');
    expect(anchor.style.lineHeight).toBe('31px');
    await act(async () => anchor.click());
    expect(ref.current).toBe(anchor);
    expect(anchor.textContent).toBe('Clicks: 1');
    expect(anchor.hasAttribute('width')).toBe(false);
    expect(anchor.hasAttribute('height')).toBe(false);
  });
});
