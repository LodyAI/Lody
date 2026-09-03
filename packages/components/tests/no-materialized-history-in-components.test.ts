import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Components read session history only through `ConversationView`
 * (`useSessionDoc().history`, `useConversationView`, `useConversationTail`,
 * `useSessionTurnFacts`). A component holding the materialized array would
 * silently reintroduce the O(n) open cost this package removed, so any
 * spelling of "the whole history off the doc" fails this test. See
 * `components/ai-gui/AGENTS.md`.
 */
const FORBIDDEN = [
  /sessionDoc\??\.history\b/,
  /\bdoc\??\.history\b/,
  /getState\(\)\??\.history\b/,
  /draft\.history\b/,
];

const ROOT = path.resolve(__dirname, '../src/components');

const listSources = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSources(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|stories)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

describe('components never hold the materialized session history', () => {
  it('has no sessionDoc.history / getState().history reads under src/components', () => {
    const offenders: string[] = [];
    for (const file of listSources(ROOT)) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (FORBIDDEN.some((pattern) => pattern.test(line))) {
          offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
