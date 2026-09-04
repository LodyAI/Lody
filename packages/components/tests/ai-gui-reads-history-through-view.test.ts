import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The conversation renderer reads history only through `ConversationView`
 * (or the explicit `fallbackHistory` array its owner hands it on the
 * rollback path). A `sessionDoc.history` / `doc.history` read anywhere under
 * `components/ai-gui` would go through the store bridge, whose first access
 * materializes the whole transcript — exactly the O(n) open this renderer
 * exists to avoid. If this fails on a file you just added, take the value
 * from the view (index rows, `turn(i)`, the built items) instead.
 */

const AI_GUI = join(__dirname, '..', 'src', 'components', 'ai-gui');
const FORBIDDEN = [/\bsessionDoc\.history\b/, /\bdoc\.history\b/, /\bsessionDoc\?\.history\b/];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('components/ai-gui reads history only through ConversationView', () => {
  it('never spells sessionDoc.history or doc.history', () => {
    const offenders: string[] = [];
    for (const file of walk(AI_GUI)) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${relative(AI_GUI, file)}: ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
