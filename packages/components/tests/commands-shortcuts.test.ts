import { describe, expect, it } from 'vitest';
import { COMMAND_SHORTCUTS, canonicalizeBinding } from '../src/lib/commands';
import type { KeyBinding, Platform, Runtime } from '../src/lib/commands/types';

const ALL_RUNTIMES: Runtime[] = ['web', 'electron', 'mobile'];
const ALL_PLATFORMS: Platform[] = ['mac', 'win', 'linux', 'ios', 'android', 'unknown'];
const ALL_SURFACES = ['composer', 'other'];

type ExpandedRow = {
  id: string;
  canonical: string;
  runtimes: ReadonlySet<string>;
  platforms: ReadonlySet<string>;
  surfaces: ReadonlySet<string>;
};

function expand(id: string, binding: string | KeyBinding): ExpandedRow {
  const spec: KeyBinding = typeof binding === 'string' ? { key: binding } : binding;
  const canonical = canonicalizeBinding(spec.key);
  if (!canonical) throw new Error(`${id}: binding ${spec.key} does not parse`);
  return {
    id,
    canonical,
    runtimes: new Set(spec.runtimes ?? ALL_RUNTIMES),
    platforms: new Set(spec.platforms ?? ALL_PLATFORMS),
    surfaces: new Set(spec.surface ? [spec.surface] : ALL_SURFACES),
  };
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  [...a].some((value) => b.has(value));

/**
 * The compile-time check in `shortcuts.ts` compares bindings by literal spelling;
 * this is the canonicalization backstop that catches the same chord written two
 * ways (`Shift+Mod+d` vs `Mod+Shift+d`) plus any runtime/platform/surface axes
 * the literals can't express.
 */
describe('COMMAND_SHORTCUTS', () => {
  it('assigns no canonical chord to two commands whose scopes overlap', () => {
    const rows = Object.entries(COMMAND_SHORTCUTS).flatMap(([id, list]) =>
      list.map((binding) => expand(id, binding))
    );

    const conflicts: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i]!;
        const b = rows[j]!;
        if (a.id === b.id || a.canonical !== b.canonical) continue;
        if (
          intersects(a.runtimes, b.runtimes) &&
          intersects(a.platforms, b.platforms) &&
          intersects(a.surfaces, b.surfaces)
        ) {
          conflicts.push(`${a.id} and ${b.id} both bind ${a.canonical}`);
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('pairs every declared surface scope with an executable focus guard', () => {
    for (const [id, list] of Object.entries(COMMAND_SHORTCUTS)) {
      for (const binding of list) {
        if (typeof binding === 'string' || binding.surface === undefined) continue;
        expect(typeof binding.when, `${id} binds ${binding.key}`).toBe('function');
      }
    }
  });

  it('keeps the composer punctuation row bound', () => {
    const bound = new Map<string, string>();
    for (const [id, list] of Object.entries(COMMAND_SHORTCUTS)) {
      for (const binding of list) {
        const row = expand(id, binding);
        if (row.surfaces.has('composer')) bound.set(`${id}:${row.canonical}`, id);
      }
    }
    for (const id of [
      'session.openRunConfig',
      'session.cycleThinkEffort',
      'session.openAddMenu',
      'session.cycleMode',
    ]) {
      expect(
        [...bound.keys()].some((key) => key.startsWith(`${id}:`)),
        `${id} keeps a composer-scoped default`
      ).toBe(true);
    }
  });
});
