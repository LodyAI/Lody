import * as stylex from '@stylexjs/stylex';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { avatar } from '../src/avatar/avatar.tokens.stylex';
import { badge } from '../src/badge/badge.tokens.stylex';
import { card } from '../src/card/card.tokens.stylex';
import { dialog } from '../src/dialog/dialog.tokens.stylex';
import { disclosure } from '../src/disclosure/disclosure.tokens.stylex';
import { feedback } from '../src/feedback/feedback.tokens.stylex';
import { kbd } from '../src/kbd/kbd.tokens.stylex';
import { UiGallery } from '../src/gallery/gallery';
import { popup } from '../src/popup/popup.tokens.stylex';
import { table } from '../src/table/table.tokens.stylex';
import { toggle } from '../src/toggle/toggle.tokens.stylex';
import { tooltip } from '../src/tooltip/tooltip.tokens.stylex';
import { surface } from '../src/popup/surface';
import { forcedThemeClassNames } from '../src/theme/theme';
import { colors, shadow, sheen } from '../src/tokens/colors.stylex';
import { control, duration, radius, space, text, z } from '../src/tokens/scales.stylex';

/** StyleX adds bookkeeping keys to the runtime token objects. */
function tokenNames(tokens: object): string[] {
  return Object.keys(tokens).filter((key) => !key.startsWith('__'));
}

const board = renderToStaticMarkup(<UiGallery />);

describe('UiGallery', () => {
  test('names every colour, shadow and sheen token', () => {
    for (const name of tokenNames(colors)) {
      expect(board, `colour token ${name} is missing from the board`).toContain(`>${name}<`);
    }
    for (const name of tokenNames(shadow)) {
      expect(board, `shadow token ${name} is missing from the board`).toContain(`>shadow.${name}<`);
    }
    for (const name of tokenNames(sheen)) {
      expect(board, `sheen token ${name} is missing from the board`).toContain(`>sheen.${name}<`);
    }
  });

  test('names every scale token', () => {
    const scales: [string, object][] = [
      ['radius', radius],
      ['control', control],
      ['space', space],
      ['duration', duration],
      ['z', z],
    ];
    for (const [group, tokens] of scales) {
      for (const name of tokenNames(tokens)) {
        expect(board, `${group}.${name} is missing from the board`).toContain(`${group}.${name}`);
      }
    }
    const typeSteps = new Set(tokenNames(text).map((name) => name.replace(/(Size|Leading)$/, '')));
    for (const step of typeSteps) {
      expect(board, `type step ${step} is missing from the board`).toContain(step);
    }
  });

  test('renders each sample under both forced palettes', () => {
    for (const className of [...forcedThemeClassNames('light'), ...forcedThemeClassNames('dark')]) {
      expect(board).toContain(className);
    }
    expect(board).toContain('Lody Light');
    expect(board).toContain('Vesper');
  });

  test('shows every Button variant and size', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'destructive', 'link']) {
      expect(board).toContain(`data-variant="${variant}"`);
    }
    for (const size of ['mini', 'small', 'medium', 'large']) {
      expect(board).toContain(`data-size="${size}"`);
    }
    expect(board).toContain('disabled=""');
  });

  test('shows the field family: both controls, every size, and each state', () => {
    expect(board).toContain('<textarea');
    expect(board).toContain('placeholder="Describe the task"');
    for (const legend of ['small · 28', 'medium · 32', 'large · 36']) {
      expect(board, `field size ${legend} is missing from the board`).toContain(legend);
    }
    // Base UI marks these on the rendered parts, so their presence is the state
    // reaching the control rather than the board describing it.
    expect(board).toContain('aria-invalid="true"');
    expect(board).toContain('data-disabled=""');
    for (const name of [
      'field.background',
      'field.value',
      'field.label',
      'field.placeholder',
      'field.hint',
      'field.error',
      'field.ring',
      'field.invalidRing',
      'field.well',
    ]) {
      expect(board, `${name} is missing from the board`).toContain(name);
    }
  });

  test('shows the choice controls: every state of each, and their own tokens', () => {
    expect(board).toContain('role="checkbox"');
    expect(board).toContain('role="radiogroup"');
    expect(board).toContain('role="switch"');
    // Base UI marks these on the rendered control, so their presence is the
    // state reaching it rather than the board describing it.
    expect(board).toContain('aria-checked="mixed"');
    expect(board).toContain('data-checked=""');
    expect(board).toContain('data-unchecked=""');
    for (const name of [
      'field.checkedFill',
      'field.checkedMark',
      'field.checkedEdge',
      'field.thumb',
      'field.thumbShadow',
    ]) {
      expect(board, `${name} is missing from the board`).toContain(name);
    }
  });

  test('shows the number and the secret, each with what sits beside the value', () => {
    // Both are real controls on the board, not stand-ins: neither is portalled.
    expect(board).toContain('aria-roledescription="Number field"');
    expect(board).toContain('type="password"');
    // The steppers and the reveal are the states they are in, read off the
    // rendered node: a stepper out of the tab order, a reveal that says it
    // will show rather than that it is showing.
    expect(board).toContain('aria-label="Increase"');
    expect(board).toContain('aria-label="Decrease"');
    expect(board).toContain('aria-label="Show password"');
    expect(board).toContain('aria-pressed="false"');
    // The gap Base UI leaves on a number field, closed here: an invalid one
    // says so to a screen reader and not only through the ring.
    expect(board).toMatch(/<input[^>]*inputMode="numeric"[^>]*aria-invalid="true"/);
    // The size legends are the password ladder's, which name themselves: the
    // field family's own "small · 28" is already on the board further up, so
    // asserting that would pass with this section deleted.
    for (const legend of [
      'bare',
      'stepped',
      'password \u00b7 small \u00b7 28',
      'password \u00b7 large \u00b7 36',
    ]) {
      expect(board, `the ${legend} row is missing from the board`).toContain(legend);
    }
  });

  test('shows the trigger every state and names the popup tokens', () => {
    // A trigger is a button that announces a listbox; a Combobox is an input
    // that announces one. Their presence is the board holding the real
    // controls rather than a picture of them.
    expect(board).toContain('aria-haspopup="listbox"');
    expect(board).toContain('data-placeholder=""');
    expect(board).toContain('aria-autocomplete="list"');
    for (const legend of ['small · 28', 'medium · 32', 'large · 36']) {
      expect(board, `select size ${legend} is missing from the board`).toContain(legend);
    }
    for (const name of tokenNames(popup)) {
      expect(board, `popup.${name} is missing from the board`).toContain(`popup.${name}`);
    }
    expect(board, 'field.icon is missing from the board').toContain('field.icon');
  });

  test('shows the three ways into a menu, and every row state a menu holds', () => {
    // The ways in are the real controls: a dropdown trigger, a bar of them, and
    // an area that answers a right click.
    expect(board).toContain('aria-haspopup="menu"');
    expect(board).toContain('role="menubar"');
    expect(board).toContain('Right-click this area');
    // The rows are a stand-in, because a menu is portalled and unmounted while
    // it is closed — the board would otherwise show three triggers and nothing
    // a reader could compare.
    for (const row of ['New task', 'Copy link', 'Sort by name', 'Export', 'Archive']) {
      expect(board, `the ${row} row is missing from the board`).toContain(row);
    }
    // A destructive command is a state of the one row rather than a component
    // of its own, and it has two: at rest, and under the keyboard.
    for (const state of [surface.itemDestructive, surface.itemDestructiveHighlighted]) {
      for (const name of (stylex.props(state).className ?? '').split(' ').filter(Boolean)) {
        expect(board, `a destructive row state is missing from the board`).toContain(name);
      }
    }
  });

  test('shows a popover, and names the two declarations it replaces', () => {
    // The real popover is a trigger; its surface is a stand-in, because a popup
    // is portalled and unmounted while it is closed.
    expect(board).toContain('aria-haspopup="dialog"');
    for (const name of ['popup.panelPadding', 'popup.panelGap', 'popup.description']) {
      expect(board, `${name} is missing from the board`).toContain(name);
    }
  });

  test('shows the modal rung: all three ways onto it, and every dialog token', () => {
    // Base UI marks the panel, so its presence is the real component on the
    // board rather than a picture of one. A dialog is unmounted while closed,
    // so what a reader compares against is the stand-in beside the triggers.
    expect(board).toContain('Rename session');
    expect(board).toContain('Delete session');
    // A drawer has two axes and both belong on the board: the edge it arrives
    // from — each laid out against a different side and swiped a different way
    // — and whether it meets that edge or floats off it.
    for (const side of ['top', 'end', 'bottom', 'start']) {
      expect(board, `the ${side} drawer is missing from the board`).toContain(`>${side}<`);
      expect(board, `the inset ${side} drawer is missing from the board`).toContain(
        `${side} · inset`
      );
    }
    for (const name of tokenNames(dialog)) {
      expect(board, `dialog.${name} is missing from the board`).toContain(`dialog.${name}`);
    }
  });

  test('shows the three disclosures, and names every token they share', () => {
    // None of the three is portalled, so what the board renders is the real
    // thing in both states rather than a stand-in: a strip with its pill, a
    // stack with one row open and two closed, and a lone collapsible.
    expect(board).toContain('role="tablist"');
    expect(board).toContain('role="tabpanel"');
    // The pill is the list's own doing rather than a caller's, and the board
    // does not add one: its presence here is the part assembling it.
    expect(board).toContain('role="presentation"');
    for (const legend of ['small \u00b7 28', 'medium \u00b7 32', 'large \u00b7 36']) {
      expect(board, `strip size ${legend} is missing from the board`).toContain(legend);
    }
    // A stack states both states at once: one row open, the rest closed.
    expect(board).toContain('aria-expanded="true"');
    expect(board).toContain('aria-expanded="false"');
    expect(board).toContain('What a session is');
    for (const name of tokenNames(disclosure)) {
      expect(board, `disclosure.${name} is missing from the board`).toContain(`disclosure.${name}`);
    }
  });

  test('shows the tooltip, and names every token it reads', () => {
    expect(board).toContain('Rerun this turn');
    for (const name of tokenNames(tooltip)) {
      expect(board, `tooltip.${name} is missing from the board`).toContain(`tooltip.${name}`);
    }
  });

  test('shows both halves of the feedback family, and every token they share', () => {
    // An Alert renders in place, so the board holds the real thing in each of
    // the four tones; a Toast is portalled and gone again, so what a reader
    // compares against is the stand-in beside the button that reports one.
    expect(board).toContain('role="alert"');
    expect(board).toContain('role="status"');
    expect(board).toContain('Session archived');
    expect(board).toContain('role="progressbar"');
    // A bar with no value is a different report from a bar at zero, and both
    // are on the board.
    expect(board).toContain('aria-valuenow="0"');
    expect(board).toContain('indeterminate');
    for (const name of tokenNames(feedback)) {
      expect(board, `feedback.${name} is missing from the board`).toContain(`feedback.${name}`);
    }
  });

  test('shows the table and the pager, and every token the two share', () => {
    // Nothing here is a stand-in: a table draws no surface and a pager is not
    // portalled, so the board holds both of them for real.
    expect(board).toContain('<table');
    expect(board).toContain('<caption');
    expect(board).toContain('<tfoot');
    for (const legend of ['small \u00b7 28', 'medium \u00b7 32', 'large \u00b7 36']) {
      expect(board, `table size ${legend} is missing from the board`).toContain(legend);
    }
    // A row that is taken, a row that can be pressed, and a head that stays.
    expect(board).toContain('data-selected=""');
    expect(board).toContain('tabindex="0"');
    // The box in the head is derived rather than passed: some of the rows are
    // taken, so it is mixed.
    expect(board).toContain('aria-checked="mixed"');
    expect(board).toContain('aria-label="Select all"');
    // Nothing to show is a row of the table rather than a panel over it, so the
    // column names are still standing beside it. What it crosses is pinned in
    // `table.test.tsx`, against a real DOM rather than this markup.
    expect(board).toContain('No sessions on this machine');
    // A sortable column states its direction where a screen reader reads it,
    // and a column with no way to take it says nothing about sorting at all.
    expect(board).toContain('aria-sort="descending"');
    expect(board).toContain('aria-sort="none"');
    // The pager: the page you are on says so twice, and the gaps name no page.
    expect(board).toContain('aria-current="page"');
    expect(board).toContain('aria-label="Page 20"');
    expect(board).toContain('Page 4212 of 9214');
    for (const name of tokenNames(table)) {
      expect(board, `table.${name} is missing from the board`).toContain(`table.${name}`);
    }
  });

  test('shows the card rung as a component, and names every token it takes', () => {
    // A card is not portalled, so what the board holds is the real thing in
    // both of its states: a block with a heading, a body and the answers, and
    // the same block marked as the pressable thing inside the caller's button.
    expect(board).toContain('Worktree setup');
    expect(board).toContain('<h4');
    expect(board).toContain('<button type="button"');
    for (const name of tokenNames(card)) {
      expect(board, `card.${name} is missing from the board`).toContain(`card.${name}`);
    }
  });

  test('shows a badge on three rungs, a line in both axes, and their tokens', () => {
    // A badge is on no rung, and the board is where that either holds or does
    // not: the same four tones sit on the page, on a card and on the floating
    // rung where the ladder's own named fills collapse.
    for (const rung of ['on a page', 'on a card', 'on a menu']) {
      expect(board, `the badge row ${rung} is missing from the board`).toContain(rung);
    }
    // The line is the primitive rather than a hand-drawn div, in both axes.
    expect(board).toContain('role="separator"');
    expect(board).toContain('aria-orientation="vertical"');
    for (const name of tokenNames(badge)) {
      expect(board, `badge.${name} is missing from the board`).toContain(`badge.${name}`);
    }
  });

  test('shows every avatar rung, both shapes, and each stand-in', () => {
    // The board is where the ladder either holds or does not: the point of the
    // size prop is that the box picks the letters, so all five rungs are on it
    // rather than one with a note about the rest.
    for (const legend of [
      'mini \u00b7 16',
      'small \u00b7 20',
      'medium \u00b7 24',
      'large \u00b7 32',
      'xlarge \u00b7 64',
    ]) {
      expect(board, `avatar rung ${legend} is missing from the board`).toContain(legend);
    }
    expect(board).toContain('data-shape="tile"');
    expect(board).toContain('data-shape="circle"');
    // The letters where a picture has not arrived, and the identity colour a
    // surface brought itself. There is no `<img>` in this markup and that is
    // the component working: Base UI mounts the picture only once it has
    // loaded, so a static render is every avatar showing its stand-in.
    expect(board).not.toContain('<img');
    expect(board).toContain('background-color:hsl(268 62% 52%)');
    for (const name of tokenNames(avatar)) {
      expect(board, `avatar.${name} is missing from the board`).toContain(`avatar.${name}`);
    }
  });

  test('shows a key cap, a chord, and the same cap on a tooltip', () => {
    // Nothing here is a stand-in for the cap; the chip is, because a tooltip is
    // portalled and opens on a pointer the board has not got. It is composed
    // from the very style `Tooltip.Content` applies, so a chip this package no
    // longer draws cannot be reported here.
    expect(board).toContain('<kbd');
    expect(board).toContain('Open the command palette');
    // A chord is a kbd around kbds, which is the shape HTML gives one gesture.
    expect(board).toMatch(/<kbd[^>]*>\s*<kbd/);
    for (const name of tokenNames(kbd)) {
      expect(board, `kbd.${name} is missing from the board`).toContain(`kbd.${name}`);
    }
  });

  test('shows a control that stays pressed, a set of them, and the bar holding them', () => {
    // Nothing here is a stand-in. None of the three is portalled, so the board
    // holds a real toggle in both of its states, a set in each of its two
    // kinds, and a bar with the one line between its clusters.
    expect(board).toContain('aria-pressed="true"');
    expect(board).toContain('aria-pressed="false"');
    expect(board).toContain('role="toolbar"');
    // The 24px rung is this family's own: the ladder a Button is on starts at
    // 28, and a toggle in a file viewer's strip of actions is smaller than that.
    expect(board, "the toggle's 24px rung is missing from the board").toContain('mini \u00b7 24');
    // The comparison the section exists to make, on one row: the same three
    // choices as a set and as a Tabs strip, so a reader can see that only the
    // strip — which is one control — has a track under it.
    expect(board).toContain('Timeline');
    expect(board).toContain('role="tablist"');
    for (const name of tokenNames(toggle)) {
      expect(board, `toggle.${name} is missing from the board`).toContain(`toggle.${name}`);
    }
  });

  test('renders one palette when asked for one', () => {
    const light = renderToStaticMarkup(<UiGallery palettes="light" />);
    expect(light).toContain('Lody Light');
    expect(light).not.toContain('Vesper');
    // createTheme also emits a marker class shared by both themes of a variable
    // group; only the palette-specific classes tell the two renders apart.
    const darkOnly = forcedThemeClassNames('dark').filter(
      (className) => !forcedThemeClassNames('light').includes(className)
    );
    expect(darkOnly.length).toBeGreaterThan(0);
    for (const className of darkOnly) {
      expect(light).not.toContain(className);
    }
  });
});
