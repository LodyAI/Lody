// @vitest-environment jsdom

import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

import { MessageTextWithChips } from '../src/components/mentions/message-text-chips';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('MessageTextWithChips', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it('keeps a ZWJ emoji together with the mention prefix', () => {
    const label = '@👨‍👩‍👧‍👦-reviewer';
    const text = `See ${label}`;

    flushSync(() => {
      root.render(
        <MessageTextWithChips
          text={text}
          spans={[
            {
              start: 4,
              end: 4 + label.length,
              kind: 'file',
              label,
              target: '👨‍👩‍👧‍👦-reviewer',
            },
          ]}
        />
      );
    });

    expect(container.textContent).toBe(text);
    expect(container.querySelector('.whitespace-nowrap')?.textContent).toBe(
      '@👨‍👩‍👧‍👦-r'
    );
  });
});
