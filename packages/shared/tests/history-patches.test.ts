import { describe, expect, it } from 'vitest';
import type { SessionHistoryInput } from '../src/schema';
import { SessionHistoryChangesSchema } from '../src/message-schemas';
import { applySessionHistoryPatches, SessionHistoryContentPatchSchema } from '../src/session-data';

const entry = (): SessionHistoryInput => ({
  id: 'synthetic-assistant',
  role: 'assistant',
  timestamp: 'synthetic',
  items: [{ type: 'text', text: 'a🙂bc🚀d' }],
});
const textPath = [{ key: 'items' }, { index: 0 }, { key: 'text' }];

describe('history content patches', () => {
  it('rejects ambiguous duplicate patch groups while preserving legacy replies', () => {
    const reply = { state: 'ready', checkpoint: 'next', ids: ['synthetic-assistant'] };
    expect(SessionHistoryChangesSchema.safeParse(reply).success).toBe(true);
    const turn = {
      turnId: 'synthetic-assistant',
      operations: [{ kind: 'appendText', path: textPath, text: 'next' }],
    };
    expect(
      SessionHistoryChangesSchema.safeParse({
        ...reply,
        patches: { baseCheckpoint: 'base', turns: [turn] },
      }).success
    ).toBe(true);
    expect(
      SessionHistoryChangesSchema.safeParse({
        ...reply,
        patches: { baseCheckpoint: 'base', turns: [turn, turn] },
      }).success
    ).toBe(false);
  });
  it('preserves scalar offsets, array order and unknown JSON fields on a detached body', () => {
    const original = entry();
    const result = applySessionHistoryPatches(original, [
      { kind: 'spliceText', path: textPath, index: 2, delete: 2, text: 'XYZ' },
      { kind: 'appendText', path: textPath, text: '尾' },
      {
        kind: 'spliceArray',
        path: [{ key: 'items' }],
        index: 1,
        delete: 0,
        values: [{ type: 'text', text: 'next', futureField: { kept: null } }],
      },
      { kind: 'set', path: [{ key: 'finished' }], value: false },
      { kind: 'remove', path: [{ key: 'finished' }] },
    ]);
    expect(result).toEqual({
      ...original,
      items: [
        { type: 'text', text: 'a🙂XYZ🚀d尾' },
        { type: 'text', text: 'next', futureField: { kept: null } },
      ],
    });
    expect(original).toEqual(entry());
  });

  it('cannot partly mutate a cached row or replace its logical identity', () => {
    const original = entry();
    expect(() =>
      applySessionHistoryPatches(original, [
        { kind: 'appendText', path: textPath, text: 'pending' },
        { kind: 'spliceText', path: textPath, index: 100, delete: 1, text: '' },
      ])
    ).toThrow('Invalid history content patch');
    for (const patch of [
      { kind: 'set' as const, path: [{ key: 'id' }], value: 'other' },
      { kind: 'remove' as const, path: [{ key: 'id' }] },
      { kind: 'remove' as const, path: [{ key: 'items' }, { index: 0 }] },
      { kind: 'set' as const, path: [{ key: 'constructor' }, { key: 'prototype' }], value: {} },
    ])
      expect(() => applySessionHistoryPatches(original, [patch])).toThrow();
    expect(original).toEqual(entry());
  });

  it('treats prototype-looking JSON keys as own data and never traverses inherited objects', () => {
    const result = applySessionHistoryPatches(entry(), [
      { kind: 'set', path: [{ key: '__proto__' }], value: { syntheticKey: 'own data' } },
      { kind: 'set', path: [{ key: '__proto__' }, { key: 'syntheticKey' }], value: 'updated' },
    ]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual({
      syntheticKey: 'updated',
    });
    expect(Object.hasOwn(Object.prototype, 'syntheticKey')).toBe(false);
    expect(() =>
      applySessionHistoryPatches(entry(), [
        { kind: 'set', path: [{ key: '__proto__' }, { key: 'syntheticKey' }], value: true },
      ])
    ).toThrow();
  });

  it('rejects invalid wire offsets, empty paths and undeclared operations', () => {
    for (const index of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        SessionHistoryContentPatchSchema.safeParse({
          kind: 'spliceText',
          path: textPath,
          index,
          delete: 0,
          text: '',
        }).success
      ).toBe(false);
    expect(
      SessionHistoryContentPatchSchema.safeParse({ kind: 'set', path: [], value: null }).success
    ).toBe(false);
    expect(
      SessionHistoryContentPatchSchema.safeParse({ kind: 'execute', path: textPath }).success
    ).toBe(false);
  });
});
