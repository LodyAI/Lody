import * as stylex from '@stylexjs/stylex';
import { act, createRef } from 'react';
import { mount } from './dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Card } from '../src/card/card';
import { cardPaletteTheme } from '../src/card/card.tokens.stylex';
import { forcedThemeClassNames } from '../src/theme/theme';

/** The class list of an element, read off static markup. */
function classesAt(html: string, index = 0): string[] {
  const matches = [...html.matchAll(/class="([^"]*)"/g)];
  return (matches[index]?.[1] ?? '').split(' ').filter(Boolean);
}

describe('Card', () => {
  test('the block is a div with no role, because a card is not a control', () => {
    // A card holds controls; it is not one. Nothing here takes focus, answers a
    // pointer or reports a state, so the rung is the whole of what it says.
    const html = renderToStaticMarkup(<Card.Root>Sessions</Card.Root>);
    expect(html).toMatch(/^<div/);
    expect(html).not.toContain('role=');
    expect(html).not.toContain('tabindex');
  });

  test('interactive adds the pointer’s answer and nothing else', () => {
    const rest = classesAt(renderToStaticMarkup(<Card.Root>a</Card.Root>));
    const pressable = classesAt(renderToStaticMarkup(<Card.Root interactive>a</Card.Root>));
    // The rung is unchanged: a card that lifted on hover would be claiming a
    // rung it is not on, so only the fill and the cursor are added.
    for (const name of rest) expect(pressable).toContain(name);
    expect(pressable.length).toBeGreaterThan(rest.length);
  });

  test('the title is a real heading, and which level it is belongs to the page', () => {
    // An Alert's title is a line, because an alert owns no section; a card owns
    // a region of the page, so a person walking the headings lands on it. The
    // step is the card's and the level is not.
    expect(renderToStaticMarkup(<Card.Title>Agents</Card.Title>)).toMatch(/^<h3/);
    const page = renderToStaticMarkup(<Card.Title as="h1">Sign in</Card.Title>);
    expect(page).toMatch(/^<h1/);
    // The step does not move with the level.
    expect(classesAt(page)).toEqual(classesAt(renderToStaticMarkup(<Card.Title>x</Card.Title>)));
  });

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

  test('the parts are four different blocks', () => {
    const of = (html: string) => classesAt(html).join(' ');
    const parts = [
      of(renderToStaticMarkup(<Card.Header>a</Card.Header>)),
      of(renderToStaticMarkup(<Card.Title>a</Card.Title>)),
      of(renderToStaticMarkup(<Card.Description>a</Card.Description>)),
      of(renderToStaticMarkup(<Card.Footer>a</Card.Footer>)),
    ];
    expect(new Set(parts).size).toBe(4);
    expect(renderToStaticMarkup(<Card.Description>a</Card.Description>)).toMatch(/^<p/);
  });

  test('a caller className lands after the compiled classes', () => {
    const html = renderToStaticMarkup(<Card.Root className="max-w-md">a</Card.Root>);
    const cls = /class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(cls.endsWith(' max-w-md')).toBe(true);
    expect(cls.split(' ').length).toBeGreaterThan(3);
  });

  test('the card’s colours travel into a forced palette', () => {
    // A component token group declared only at the document root keeps the root
    // palette inside a themed subtree, so a light card on a dark page would
    // read the dark one. `ThemeRoot` has to carry this group with the palette.
    const theme = (stylex.props(cardPaletteTheme).className ?? '').split(' ').filter(Boolean);
    expect(theme.length).toBeGreaterThan(0);
    for (const name of theme) {
      expect(forcedThemeClassNames('dark'), `${name} is not applied by ThemeRoot`).toContain(name);
      expect(forcedThemeClassNames('light'), `${name} is not applied by ThemeRoot`).toContain(name);
    }
  });
});
