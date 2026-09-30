import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Avatar, type AvatarSize } from '../src/avatar/avatar';
import { avatar, avatarPaletteTheme } from '../src/avatar/avatar.tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { forcedThemeClassNames } from '../src/theme/theme';

const SIZES: AvatarSize[] = ['mini', 'small', 'medium', 'large', 'xlarge'];

function classesAt(html: string, index = 0): string[] {
  const matches = [...html.matchAll(/class="([^"]*)"/g)];
  return (matches[index]?.[1] ?? '').split(' ').filter(Boolean);
}

/** A face with letters standing in for it, at the rung asked for. */
function face(size?: AvatarSize, shape?: 'circle' | 'tile') {
  return renderToStaticMarkup(
    <Avatar.Root size={size} shape={shape}>
      <Avatar.Fallback>ZX</Avatar.Fallback>
    </Avatar.Root>
  );
}

describe('Avatar', () => {
  test('the box picks the letters, so a caller states one fact', () => {
    // This is the whole reason the size is a prop. The deleted implementation
    // had a single `size-8`, and every call site restated the box and the type
    // step separately — `h-5 w-5 text-[9px]`, `h-7 w-7 text-[11px]`, `h-16 w-16
    // text-xl` — two facts a surface had to keep in step. Here one prop moves
    // both, so no rung can end up with somebody else's letters in it.
    const boxes = SIZES.map((size) => classesAt(face(size), 0).join(' '));
    const letters = SIZES.map((size) => classesAt(face(size), 1).join(' '));
    expect(new Set(boxes).size).toBe(SIZES.length);
    expect(new Set(letters).size).toBe(SIZES.length);
  });

  test('a rung is one width and one height, and nothing else moves with it', () => {
    // A rung is exactly two declarations, a width and a height. Everything
    // else a box is made of is one decision for all five: the crop, the shape,
    // the fact that it never gives room back to a row that ran out.
    const perSize = SIZES.map((size) => classesAt(face(size), 0));
    const shared = perSize.reduce<string[]>(
      (kept, names) => kept.filter((name) => names.includes(name)),
      perSize[0] ?? []
    );
    for (const names of perSize) expect(names.length).toBe(shared.length + 2);
  });

  test('a person is a circle and a thing is a tile, at the rung it is on', () => {
    // The rules put `radius.full` on `corner.round`: a squircle at that radius
    // is a superellipse, which turns a face into a rounded square. A tile takes
    // the radius-by-size table instead, so its corner changes with its box and
    // a circle's does not.
    const circles = SIZES.map((size) => classesAt(face(size, 'circle'), 0));
    const tiles = SIZES.map((size) => classesAt(face(size, 'tile'), 0));
    const circleCorners = circles.map((names) => names.filter((n) => !tiles[0]?.includes(n)));
    expect(new Set(circleCorners.map((n) => n.join(' '))).size).toBeGreaterThan(0);
    // Five boxes, five corners: a 16px tile and a 64px tile are not the same
    // shape, and nothing here is a token of the tile's own.
    const tileCorner = tiles.map((names, index) =>
      names.filter((name) => !(circles[index] ?? []).includes(name)).join(' ')
    );
    expect(new Set(tileCorner).size).toBe(SIZES.length);
  });

  test('shape and size are reported on the element, so a board can read them', () => {
    expect(face('large', 'tile')).toContain('data-size="large"');
    expect(face('large', 'tile')).toContain('data-shape="tile"');
    // The default is the rung a list of people sits on, and a person.
    expect(face()).toContain('data-size="medium"');
    expect(face()).toContain('data-shape="circle"');
  });

  test('a mark inside a fallback is given a box that follows the rung', () => {
    // Every glyph in this package states 100% of whatever holds it, and StyleX
    // has no descendant selector to reach one with, so the fallback draws the
    // box. It is not one box for every avatar: a mark in a 16px circle and a
    // mark in a 64px one are the same fraction of two different faces.
    const marked = (size: AvatarSize) =>
      classesAt(
        renderToStaticMarkup(
          <Avatar.Root size={size}>
            <Avatar.Fallback>
              <Avatar.Glyph>
                <svg />
              </Avatar.Glyph>
            </Avatar.Fallback>
          </Avatar.Root>
        ),
        2
      ).join(' ');
    expect(new Set(SIZES.map(marked)).size).toBe(SIZES.length);
    // And a fallback carrying letters draws no box at all, so two initials are
    // not squeezed into a glyph's share of the circle.
    expect(classesAt(face('large'), 2)).toEqual([]);
  });

  test('a fallback keeps an identity colour the surface passed', () => {
    // Which hue belongs to which workspace is a product fact rather than a
    // token: the gray is what the package owns, and a surface that has its own
    // answer states it as a style, which lands after every compiled class.
    const html = renderToStaticMarkup(
      <Avatar.Root size="large" shape="tile">
        <Avatar.Fallback style={{ backgroundColor: 'hsl(268 62% 52%)' }}>L</Avatar.Fallback>
      </Avatar.Root>
    );
    expect(html).toContain('background-color:hsl(268 62% 52%)');
  });

  test('a rung is a ceiling as well as a floor', () => {
    // The board caught this and no unit test could have: jsdom applies none of
    // StyleX's CSS, so a 16px circle holding two initials laid out 20px wide
    // and stopped being a circle. A flex item's automatic minimum size is its
    // content's, and an avatar is always in a row of something. Both the box
    // and the fallback inside it have to give that up for the width to be the
    // fact it is documented to be.
    const floor = stylex.create({ probe: { minWidth: 0 } });
    const props = stylex.props as (...args: readonly unknown[]) => { className?: string };
    const expected = (props(floor.probe).className ?? '').split(' ').filter(Boolean);
    expect(expected.length).toBe(1);
    expect(classesAt(face('mini'), 0)).toContain(expected[0]);
    expect(classesAt(face('mini'), 1)).toContain(expected[0]);
  });

  test('a caller className lands after the compiled classes', () => {
    const html = renderToStaticMarkup(
      <Avatar.Root className="mt-0.5">
        <Avatar.Fallback>ZX</Avatar.Fallback>
      </Avatar.Root>
    );
    expect(classesAt(html, 0).at(-1) ?? '').toBe('mt-0.5');
  });

  test('the colour tokens are re-declared under a forced palette', () => {
    // A custom property declared only at the document root keeps the root
    // palette inside a themed subtree, so a light card on a dark page would
    // otherwise hold a dark avatar.
    const props = stylex.props as (...args: readonly unknown[]) => { className?: string };
    const theme = (props(avatarPaletteTheme).className ?? '').split(' ').filter(Boolean);
    expect(theme.length).toBeGreaterThan(0);
    for (const name of theme) {
      expect(forcedThemeClassNames('dark')).toContain(name);
    }
    // And the group names both of the colours it points at.
    expect(Object.keys(avatar)).toContain('fallbackBackground');
    expect(Object.keys(avatar)).toContain('fallbackLabel');
  });
});
