import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Two suppression slots — `lastMissingHistoryUserMsgId` and
 * `settledActivationUserMsgId` — retire an activation WITHOUT rewriting the
 * producer-owned pointers, because there is no CAS against the LWW map. A
 * consumer that compares the pointers directly therefore sees pending work
 * forever: auto review waits on a session that will never finish, idle GC
 * refuses to reclaim it, and MCP reports a queued turn that does not exist.
 * A behavioural test over today's consumers cannot prove the invariant holds —
 * a new one that forgets still passes — so this guards the shape.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const searchRoots = ['apps/cli/src', 'packages/components/src'];

function productionSources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /(?<!\.test)\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Prose may name the comparison; only executable code is in scope. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** A direct comparison of the two dispatch pointers, in either order. */
const RAW_POINTER_COMPARISON =
  /(latestUserMsgId|lastHandledUserMsgId)\s*!==\s*[\w.?]*\.?(lastHandledUserMsgId|latestUserMsgId)/;

describe('dispatch activation predicate', () => {
  it('is the only thing that compares the dispatch pointers', () => {
    const offenders: string[] = [];

    for (const root of searchRoots) {
      for (const file of productionSources(join(repoRoot, root))) {
        const source = readFileSync(file, 'utf8');
        // Only ~9 files mention the pointer at all; skip the regex for the rest.
        if (!source.includes('lastHandledUserMsgId')) {
          continue;
        }
        if (RAW_POINTER_COMPARISON.test(stripComments(source))) {
          offenders.push(file.slice(repoRoot.length));
        }
      }
    }

    expect(
      offenders,
      'derive pending work through `hasPendingUserTurnActivation` from @lody/shared'
    ).toEqual([]);
  });
});
