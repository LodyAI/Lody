import type { SessionHistory } from '@lody/shared';
import type { AcceptedSessionHistoryProjection } from '@/atoms/session-history-projection';
import { indexRowFromEntry } from './index-row';
import type { ConversationView, ConversationViewChange, TurnIndexRow } from './types';

type Slot = { base: number } | { entry: SessionHistory; row: TurnIndexRow };

/**
 * Overlays accepted-but-not-yet-authoritative history entries on a view, with
 * the placement rules of `projectAcceptedSessionHistory`: an entry the base
 * already holds is dropped, `afterHistoryId: null` goes to the head (in
 * order), a string anchors after that entry (tail when the anchor is missing),
 * and `undefined` appends. Indexes shift accordingly; the wrapper never owns
 * the base view.
 */
export function createProjectedConversationView(
  base: ConversationView,
  projections: readonly AcceptedSessionHistoryProjection[]
): ConversationView {
  if (projections.length === 0) return base;

  let slotsVersion = -1;
  let slots: Slot[] = [];
  let baseToSlot: number[] = [];
  let slotById = new Map<string, number>();

  const rebuild = () => {
    if (slotsVersion === base.version) return;
    slotsVersion = base.version;
    const list: Slot[] = Array.from({ length: base.turnCount }, (_, i) => ({ base: i }));
    const idOfSlot = (slot: Slot) => ('base' in slot ? base.index(slot.base)?.id : slot.entry.id);
    const seen = new Set<string>();
    let headInsertAt = 0;
    for (const projection of projections) {
      const id = projection.entry.id;
      if (seen.has(id) || base.indexOf(id) >= 0) continue;
      seen.add(id);
      const slot: Slot = { entry: projection.entry, row: indexRowFromEntry(projection.entry) };
      if (projection.afterHistoryId === null) {
        list.splice(headInsertAt, 0, slot);
        headInsertAt += 1;
        continue;
      }
      if (projection.afterHistoryId === undefined) {
        list.push(slot);
        continue;
      }
      const anchor = list.findIndex(
        (candidate) => idOfSlot(candidate) === projection.afterHistoryId
      );
      if (anchor < 0) list.push(slot);
      else list.splice(anchor + 1, 0, slot);
    }
    slots = list;
    baseToSlot = [];
    slotById = new Map();
    list.forEach((slot, slotIndex) => {
      if ('base' in slot) baseToSlot[slot.base] = slotIndex;
      const id = idOfSlot(slot);
      if (id !== undefined && !slotById.has(id)) slotById.set(id, slotIndex);
    });
  };

  const baseRangeOf = (from: number, to: number): [number, number] | null => {
    rebuild();
    let lo = Number.POSITIVE_INFINITY;
    let hi = -1;
    for (let i = Math.max(0, from); i < Math.min(to, slots.length); i += 1) {
      const slot = slots[i];
      if (!slot || !('base' in slot)) continue;
      lo = Math.min(lo, slot.base);
      hi = Math.max(hi, slot.base);
    }
    return hi < 0 ? null : [lo, hi + 1];
  };

  const translate = (change: ConversationViewChange): ConversationViewChange => {
    rebuild();
    if (change.from === undefined || change.to === undefined) return change;
    const from = baseToSlot[change.from] ?? change.from;
    const last = baseToSlot[Math.max(change.from, change.to - 1)];
    return { kind: change.kind, from, to: last === undefined ? change.to : last + 1 };
  };

  return {
    sessionId: base.sessionId,
    get turnCount() {
      rebuild();
      return slots.length;
    },
    get version() {
      return base.version;
    },
    ready: base.ready,
    index: (i) => {
      rebuild();
      const slot = slots[i];
      if (!slot) return undefined;
      return 'base' in slot ? base.index(slot.base) : slot.row;
    },
    indexOf: (turnId) => {
      rebuild();
      return slotById.get(turnId) ?? -1;
    },
    turn: (i) => {
      rebuild();
      const slot = slots[i];
      if (!slot) return undefined;
      return 'base' in slot ? base.turn(slot.base) : slot.entry;
    },
    isHydrated: (i) => {
      rebuild();
      const slot = slots[i];
      if (!slot) return false;
      return 'base' in slot ? base.isHydrated(slot.base) : true;
    },
    ensureRange: (from, to) => {
      const range = baseRangeOf(from, to);
      return range ? base.ensureRange(range[0], range[1]) : Promise.resolve();
    },
    release: (from, to) => {
      const range = baseRangeOf(from, to);
      if (range) base.release(range[0], range[1]);
    },
    subscribe: (listener) => base.subscribe((change) => listener(translate(change))),
    dispose: () => {},
  };
}
