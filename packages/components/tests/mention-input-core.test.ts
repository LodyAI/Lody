import { describe, expect, it } from 'vitest';

import {
  applyMentionSplice,
  applyTextEditToMentions,
  findAdjacentMentionForHorizontalNavigation,
  findMentionBeforeCursorForDeletion,
  getMentionValuesFromMentions,
  getTextDiff,
  remapDismissedTrigger,
  removeMentionText,
  resolveMentionInsertPrefix,
} from '../src/ui/mention/mention-input-core';

describe('mention-input-core', () => {
  it('computes diff and shifts mentions after insertion', () => {
    const prev = 'hello @src/file.ts world';
    const next = 'hello !!! @src/file.ts world';
    const diff = getTextDiff(prev, next);

    expect(diff).toEqual({
      start: 6,
      prevEnd: 6,
      nextEnd: 10,
      removedLen: 0,
      insertedLen: 4,
      delta: 4,
    });

    const mentions = [{ value: 'src/file.ts', start: 6, end: 18 }];
    const shifted = applyTextEditToMentions(mentions, diff!.start, diff!.prevEnd, diff!.delta);

    expect(shifted).toEqual([{ value: 'src/file.ts', start: 10, end: 22 }]);
  });

  it('removes intersected mentions when text edit overlaps mention range', () => {
    const mentions = [
      { value: 'src/file.ts', start: 4, end: 16 },
      { value: '#1284', start: 25, end: 30 },
    ];

    const next = applyTextEditToMentions(mentions, 10, 20, -6);

    expect(next).toEqual([{ value: '#1284', start: 19, end: 24 }]);
  });

  it('deduplicates mention values while preserving first appearance order', () => {
    const values = getMentionValuesFromMentions([
      { value: 'src/a.ts', start: 0, end: 8 },
      { value: '#1284', start: 10, end: 15 },
      { value: 'src/a.ts', start: 20, end: 28 },
    ]);

    expect(values).toEqual(['src/a.ts', '#1284']);
  });

  it('finds adjacent mention for horizontal navigation', () => {
    const mentions = [
      { value: 'src/a.ts', start: 6, end: 15 },
      { value: '#1284', start: 17, end: 22 },
    ];
    const value = 'hello @src/a.ts  #1284 done';

    const left = findAdjacentMentionForHorizontalNavigation({
      mentions,
      value,
      cursorPosition: 16,
      direction: 'left',
      isWordJump: false,
    });

    const right = findAdjacentMentionForHorizontalNavigation({
      mentions,
      value,
      cursorPosition: 16,
      direction: 'right',
      isWordJump: false,
    });

    expect(left?.value).toBe('src/a.ts');
    expect(right?.value).toBe('#1284');
  });

  it('finds deletable mention for regular and ctrl/cmd backspace', () => {
    const mentions = [
      { value: 'src/a.ts', start: 6, end: 15 },
      { value: '#1284', start: 16, end: 21 },
    ];
    const value = 'hello @src/a.ts #1284';

    const regular = findMentionBeforeCursorForDeletion({
      mentions,
      value,
      cursorPosition: 21,
      isCtrlOrCmd: false,
    });

    const ctrl = findMentionBeforeCursorForDeletion({
      mentions,
      value,
      cursorPosition: 22,
      isCtrlOrCmd: true,
    });

    expect(regular?.value).toBe('#1284');
    expect(ctrl?.value).toBe('#1284');
  });

  it('removes mention text and optional trailing space', () => {
    const mention = { value: 'src/a.ts', start: 6, end: 15 };
    const value = 'hello @src/a.ts world';

    expect(removeMentionText(value, mention, true)).toBe('hello world');
    expect(removeMentionText(value, mention, false)).toBe('hello  world');
  });
});

/**
 * The one edit both routes to a committed range share: a menu commit replaces
 * the trigger span, an external insert replaces nothing. They used to be two
 * copies of this arithmetic.
 */
describe('applyMentionSplice', () => {
  it('replaces the trigger span and shifts only what follows it', () => {
    const before = [
      { value: 'a', start: 0, end: 2, kind: 'file' },
      { value: 'b', start: 11, end: 13, kind: 'file' },
    ];
    const result = applyMentionSplice('@a see @fi @b', before, {
      replaceStart: 7,
      replaceEnd: 10,
      text: '@fix-ci',
      suffix: ' ',
      value: 'sess_1',
      kind: 'session',
      commitRange: true,
    });

    // The committed suffix space is unconditional, so the space the user had
    // already typed after the trigger span survives beside it.
    expect(result.value).toBe('@a see @fix-ci  @b');
    expect(result.caret).toBe(15);
    expect(result.mentions).toEqual([
      { value: 'a', start: 0, end: 2, kind: 'file' },
      { value: 'sess_1', start: 7, end: 14, kind: 'session' },
      { value: 'b', start: 16, end: 18, kind: 'file' },
    ]);
    expect(result.value.slice(7, 14)).toBe('@fix-ci');
    expect(result.value.slice(16, 18)).toBe('@b');
  });

  it('keeps the prefix outside the committed range', () => {
    const result = applyMentionSplice('hi', [], {
      replaceStart: 2,
      replaceEnd: 2,
      prefix: ' ',
      text: '@fix-ci',
      suffix: ' ',
      value: 'sess_1',
      kind: 'session',
      commitRange: true,
    });

    expect(result.value).toBe('hi @fix-ci ');
    expect(result.mentions).toEqual([{ value: 'sess_1', start: 3, end: 10, kind: 'session' }]);
    expect(result.value.slice(3, 10)).toBe('@fix-ci');
  });

  it('records no range for a navigation rewrite', () => {
    const result = applyMentionSplice('@sr', [], {
      replaceStart: 0,
      replaceEnd: 3,
      text: '@src/',
      value: 'src/',
      commitRange: false,
    });

    expect(result.value).toBe('@src/');
    expect(result.mentions).toEqual([]);
  });
});

/**
 * A splice that lands inside an existing range leaves that range covering text
 * it no longer describes, so it must go — the same rule a typed edit uses. No
 * caller produces one today; the shared rule is what keeps it from becoming a
 * silently corrupt mention when one does.
 */
describe('applyMentionSplice on an existing range', () => {
  const straddled = [{ value: 'src/a.ts', start: 0, end: 9, kind: 'file' }];

  it('drops a range the insert lands inside', () => {
    const result = applyMentionSplice('@src/a.ts', straddled, {
      replaceStart: 4,
      replaceEnd: 4,
      text: '@fix-ci',
      value: 'sess_1',
      kind: 'session',
      commitRange: true,
    });

    expect(result.value).toBe('@src@fix-ci/a.ts');
    expect(result.mentions).toEqual([{ value: 'sess_1', start: 4, end: 11, kind: 'session' }]);
  });

  it('keeps a range the insert lands against', () => {
    const result = applyMentionSplice('@src/a.ts', straddled, {
      replaceStart: 9,
      replaceEnd: 9,
      prefix: ' ',
      text: '@fix-ci',
      value: 'sess_1',
      kind: 'session',
      commitRange: true,
    });

    expect(result.mentions).toEqual([
      { value: 'src/a.ts', start: 0, end: 9, kind: 'file' },
      { value: 'sess_1', start: 10, end: 17, kind: 'session' },
    ]);
  });
});

describe('resolveMentionInsertPrefix', () => {
  it('separates from a preceding word but never doubles existing whitespace', () => {
    expect(resolveMentionInsertPrefix('hi', 2, true)).toBe(' ');
    expect(resolveMentionInsertPrefix('hi ', 3, true)).toBe('');
    expect(resolveMentionInsertPrefix('hi\n', 3, true)).toBe('');
    expect(resolveMentionInsertPrefix('', 0, true)).toBe('');
    expect(resolveMentionInsertPrefix('hi', 2, false)).toBe('');
  });

  it('carries a dismissed trigger through edits by the mention range rule', () => {
    const dismissed = { trigger: '@', index: 4, value: 'user@gm' };

    expect(remapDismissedTrigger(dismissed, 'user@gm')).toBe(dismissed);
    expect(remapDismissedTrigger(dismissed, 'user@gmail')).toEqual({
      ...dismissed,
      value: 'user@gmail',
    });
    expect(remapDismissedTrigger(dismissed, 'my user@gm')).toEqual({
      ...dismissed,
      index: 7,
      value: 'my user@gm',
    });
    expect(remapDismissedTrigger(dismissed, 'usergm')).toBeNull();
    expect(remapDismissedTrigger(dismissed, 'user')).toBeNull();
    expect(remapDismissedTrigger(dismissed, '')).toBeNull();
  });
});
