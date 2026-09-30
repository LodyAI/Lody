/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it } from 'vitest';
import { keepAppRootOffBodyTail } from '../src/lib/body-tail-sentinel';

describe('keepAppRootOffBodyTail', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the root off the end of body while portals come and go', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById('root')!;

    keepAppRootOffBodyTail();
    keepAppRootOffBodyTail();

    const portal = document.createElement('div');
    document.body.appendChild(portal);
    expect(root.matches(':last-child')).toBe(false);
    portal.remove();
    expect(root.matches(':last-child')).toBe(false);
    // Idempotent: one sentinel, directly after the root.
    expect(document.body.children).toHaveLength(2);
    expect(root.nextElementSibling?.hasAttribute('data-lody-body-tail')).toBe(true);
  });

  it('leaves a root that is not a direct child of body alone', () => {
    document.body.innerHTML = '<main><div id="root"></div></main>';

    keepAppRootOffBodyTail();

    expect(document.querySelector('[data-lody-body-tail]')).toBeNull();
  });
});
