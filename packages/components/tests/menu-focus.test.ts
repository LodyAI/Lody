// @vitest-environment jsdom

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { handleMenuCloseAutoFocus } from '../src/lib/menu-focus';

describe('menu-focus', () => {
  it('prevents close auto-focus after selection and focuses the composer', () => {
    const composer = document.createElement('textarea');
    composer.setAttribute('data-keyboard-nav', 'composer');
    document.body.appendChild(composer);
    const menu = document.createElement('div');
    document.body.appendChild(menu);

    let prevented = false;
    const event = {
      preventDefault() {
        prevented = true;
      },
      currentTarget: menu,
    } as unknown as Event;

    handleMenuCloseAutoFocus(event, { didSelectItem: true, menuContent: menu });
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(composer);

    document.body.innerHTML = '';
  });

  it('does not steal focus from an outside click target', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const menu = document.createElement('div');
    document.body.appendChild(menu);

    let prevented = false;
    const event = {
      preventDefault() {
        prevented = true;
      },
      currentTarget: menu,
    } as unknown as Event;

    handleMenuCloseAutoFocus(event, { didSelectItem: false, menuContent: menu });
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(outside);

    document.body.innerHTML = '';
  });
});
