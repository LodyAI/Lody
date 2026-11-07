import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { UiGallery } from '../src/gallery/gallery';

const board = renderToStaticMarkup(<UiGallery />);

describe('UiGallery', () => {
  test('shows the shared disabled token on a native disabled control in each palette', () => {
    const rendered = document.createElement('div');
    rendered.innerHTML = board;
    const controls = rendered.querySelectorAll<HTMLButtonElement>(
      'button[data-token="control.disabledOpacity"]'
    );
    expect(controls).toHaveLength(2);
    for (const disabledControl of controls) {
      expect(disabledControl.disabled).toBe(true);
      expect(disabledControl.textContent).toBe('Disabled action');
    }
  });

  test('shows media contrast on a loadable image with a non-interactive caption in both palettes', () => {
    const rendered = document.createElement('div');
    rendered.innerHTML = board;
    const samples = rendered.querySelectorAll('[data-media-contrast-sample]');
    expect(samples).toHaveLength(2);
    for (const sample of samples) {
      const image = sample.querySelector('img');
      expect(image?.src.startsWith('data:image/svg+xml;')).toBe(true);
      expect(image?.alt).toBe('White, black, yellow and blue image regions');
      expect(sample.querySelector('[data-media-caption]')?.textContent).toBe(
        'Image caption · Uploading 42%'
      );
      expect(sample.querySelector('button, input, a')).toBeNull();
    }
  });

  test('keeps trailing status inside the field well, with and without a leading part', () => {
    const rendered = document.createElement('div');
    rendered.innerHTML = board;
    const inputs = rendered.querySelectorAll<HTMLInputElement>(
      'input[data-gallery-input-trailing]'
    );
    expect(inputs).toHaveLength(4);
    for (const input of inputs) {
      const shell = input.closest('[data-slot="input-shell"]');
      expect(shell?.querySelectorAll('input')).toHaveLength(1);
      expect(shell?.querySelector('[data-slot="input-trailing"]')?.textContent).toBe(
        input.disabled ? 'Locked' : 'Available for review'
      );
      expect(Boolean(shell?.querySelector('[data-slot="input-leading"]'))).toBe(!input.disabled);
    }
  });
});
