import { act, createRef } from 'react';
import { mount } from './dom';

import { describe, expect, test } from 'vitest';
import { Card } from '../src/card/card';

describe('Card', () => {
  test('explicit title type updates preserve the heading and clear back to its defaults', async () => {
    const ref = createRef<HTMLHeadingElement>();
    const mounted = await mount(
      <Card.Title ref={ref} as="h2" id="card-title" tabIndex={0}>
        Agents
      </Card.Title>
    );
    try {
      const heading = ref.current!;
      const defaultClasses = heading.className;
      expect(heading.style.fontWeight).toBe('');
      expect(heading.style.letterSpacing).toBe('');
      heading.focus();
      await act(async () => {
        mounted.root.render(
          <Card.Title
            ref={ref}
            as="h2"
            id="card-title"
            tabIndex={0}
            fontWeight={380}
            letterSpacing={0}
          >
            Agents
          </Card.Title>
        );
      });
      expect(ref.current).toBe(heading);
      expect(document.activeElement).toBe(heading);
      expect(heading.style.fontWeight).toBe('380');
      expect(Number.parseFloat(heading.style.letterSpacing)).toBe(0);
      expect(heading.className).toBe(defaultClasses);
      await act(async () => {
        mounted.root.render(
          <Card.Title
            ref={ref}
            as="h2"
            id="card-title"
            tabIndex={0}
            fontWeight="inherit"
            letterSpacing="var(--tracking-tight)"
          >
            Agents
          </Card.Title>
        );
      });
      expect(heading.style.fontWeight).toBe('inherit');
      expect(heading.style.letterSpacing).toBe('var(--tracking-tight)');
      expect(heading.hasAttribute('fontWeight')).toBe(false);
      expect(heading.hasAttribute('letterSpacing')).toBe(false);
      await act(async () => {
        mounted.root.render(
          <Card.Title ref={ref} as="h2" id="card-title" tabIndex={0}>
            Agents
          </Card.Title>
        );
      });
      expect(ref.current).toBe(heading);
      expect(document.activeElement).toBe(heading);
      expect(heading.style.fontWeight).toBe('');
      expect(heading.style.letterSpacing).toBe('');
      expect(heading.className).toBe(defaultClasses);
    } finally {
      await mounted.unmount();
    }
  });
});
