import { describe, expect, it } from 'vitest';
import { LoroDoc, LoroList, LoroMap, LoroText, type LoroEventBatch } from 'loro-crdt';
import { applyEventToTurn } from '../src/lib/conversation-view/apply-turn-event';

/** xorshift32 so the op sequence is byte-identical on every run. */
const createRandom = (seed: number) => {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
};

describe('applyEventToTurn', () => {
  it('tracks the turn map through a random op sequence with structural sharing', () => {
    const doc = new LoroDoc();
    const list = doc.getList('history');
    const turn = list.insertContainer(0, new LoroMap());
    turn.set('id', 't');
    turn.set('role', 'assistant');
    const items = turn.setContainer('items', new LoroList());
    doc.commit();

    let state = turn.toJSON() as Record<string, unknown>;
    let fallbacks = 0;
    let applied = 0;
    doc.subscribe((batch: LoroEventBatch) => {
      // A container materialized through `toJSON()` already carries the end
      // state of the batch, so its own child events must be skipped — the
      // same rule the doc-backed view applies.
      const materialized = new Set<string>();
      const underMaterialized = (target: string): boolean => {
        let current = doc.getContainerById(target as never);
        while (current) {
          if (materialized.has(current.id)) return true;
          current = current.parent();
        }
        return false;
      };
      for (const event of batch.events) {
        if (event.path[0] !== 'history') continue;
        if (materialized.size > 0 && underMaterialized(event.target)) continue;
        const next = applyEventToTurn(state, event.path.slice(2) as (string | number)[], event.diff, (c) => {
          materialized.add(c.id);
          return c.toJSON();
        });
        applied += 1;
        if (next === null) {
          fallbacks += 1;
          state = turn.toJSON() as Record<string, unknown>;
        } else {
          state = next;
        }
      }
    });

    const random = createRandom(0x1234_abcd);
    const texts: LoroText[] = [];
    for (let step = 0; step < 200; step += 1) {
      const roll = random();
      const before = state;
      const appliedBefore = applied;
      if (roll < 0.3 || items.length === 0) {
        const item = items.insertContainer(Math.floor(random() * (items.length + 1)), new LoroMap());
        item.set('type', random() < 0.5 ? 'text' : 'thought');
        const text = item.setContainer('text', new LoroText());
        text.insert(0, `t${step}`);
        texts.push(text);
      } else if (roll < 0.7 && texts.length > 0) {
        const text = texts[Math.floor(random() * texts.length)]!;
        if (text.isDeleted()) continue;
        if (random() < 0.7 || text.length === 0) text.insert(text.length, ` w${step}`);
        else text.delete(0, Math.min(text.length, 1 + Math.floor(random() * 3)));
      } else if (roll < 0.85) {
        turn.set(random() < 0.5 ? 'finished' : 'status', random() < 0.5 ? true : `s${step}`);
      } else if (roll < 0.93) {
        const at = Math.floor(random() * items.length);
        items.delete(at, 1);
      } else {
        const meta = turn.setContainer('modelInfo', new LoroMap());
        meta.set('name', `m${step}`);
      }
      doc.commit();
      expect(state).toEqual(turn.toJSON());
      // A no-op write (same scalar again) emits no event and keeps identity.
      if (applied > appliedBefore) expect(state).not.toBe(before);
    }
    expect(fallbacks).toBe(0);
  });

  it('returns null for a path that does not resolve', () => {
    const state = { id: 't', items: [{ type: 'text', text: 'a' }] };
    const result = applyEventToTurn(
      state,
      ['items', 4, 'text'],
      { type: 'text', diff: [{ insert: 'x' }] },
      () => undefined
    );
    expect(result).toBeNull();
  });
});
