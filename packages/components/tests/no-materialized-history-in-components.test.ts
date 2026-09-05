import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The session document has exactly ONE read path and ONE write path for turns:
 * `SessionDocStore.history` (a `ConversationView`) and
 * `SessionDocStore.historyWriter`. See `components/src/AGENTS.md`.
 *
 * The honest spellings of a second path are already compile errors —
 * `SessionDocState` omits `history`, and `SessionDocUpdater` only accepts a
 * draft that omits it — so what is left for this test are the DELIBERATE
 * escapes types cannot close: a cast that puts the key back, and reaching past
 * the store into the raw `LoroDoc`. Either one silently reintroduces the O(n)
 * open cost, or writes a second copy of the conversation that no reader sees.
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /sessionDoc\??\.history\b/, why: 'read turns through the ConversationView' },
  { pattern: /\bdoc\??\.history\b/, why: 'read turns through the ConversationView' },
  { pattern: /getState\(\)[^.\n]*\.history\b/, why: 'getState() has no history key' },
  {
    // `(draft as any).history.push(...)` and every array-shaped use of it. A
    // `ConversationView` has none of these members, so this cannot fire on the
    // supported path.
    pattern:
      /\.history\s*\??\.\s*(push|pop|shift|unshift|splice|find|findIndex|filter|map|slice|some|every|reduce|forEach|concat|at|length|reverse|sort|join)\b/,
    why: 'mutate turns through SessionDocStore.historyWriter',
  },
  { pattern: /\.history\s*\??\.\s*\[/, why: 'index turns through ConversationView.index()' },
  { pattern: /\.history\s*=[^=]/, why: 'assigning the whole list bypasses the writer' },
  {
    pattern: /as\s+SessionDocMeta\b/,
    why: 'SessionDocMeta still carries history; use SessionDocDraft',
  },
  {
    pattern: /get(?:List|Map)\(\s*['"]history['"]\s*\)/,
    why: 'raw history container access belongs to lib/conversation-view',
  },
];

/**
 * The modules that own this access, and why. Asserted to be exactly the set
 * that trips the patterns, so an entry that stops being needed fails here
 * instead of quietly widening the exemption.
 */
const OWNERS = [
  // The view, the writer, and the rollback adapter over the full Mirror.
  'lib/conversation-view',
  // Builds the rollback store: reads the old Mirror's array into the adapter.
  'providers/create-workspace-runtime.ts',
];

const ROOT = path.resolve(__dirname, '../src');

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

/**
 * Other `history` fields exist and are unrelated: the browser's, and a local
 * project's per-provider import catalog. Blank the receiver rather than the
 * whole line, so a real violation on the same line still trips.
 */
const UNRELATED_RECEIVERS =
  /\b(?:window|globalThis|location|router|project|projects|resumeState|options|state)\s*\??\.\s*history\b/g;

/**
 * Prose describes the forbidden shape constantly (this file included), so only
 * code is scanned. Block comments are tracked across lines because a wrapped
 * continuation line carries no marker of its own.
 */
const stripComments = (source: string): string[] => {
  let inBlock = false;
  return source.split('\n').map((line) => {
    let out = '';
    let index = 0;
    while (index < line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', index);
        if (close === -1) return out;
        inBlock = false;
        index = close + 2;
        continue;
      }
      const lineComment = line.indexOf('//', index);
      const blockComment = line.indexOf('/*', index);
      if (blockComment !== -1 && (lineComment === -1 || blockComment < lineComment)) {
        out += line.slice(index, blockComment);
        inBlock = true;
        index = blockComment + 2;
        continue;
      }
      if (lineComment !== -1) return out + line.slice(index, lineComment);
      return out + line.slice(index);
    }
    return out;
  });
};

const isOwner = (relative: string): boolean =>
  OWNERS.some((owner) => relative === owner || relative.startsWith(`${owner}/`));

const scan = (): { offenders: string[]; owners: Set<string> } => {
  const offenders: string[] = [];
  const owners = new Set<string>();
  for (const file of listSources(ROOT)) {
    const relative = path.relative(ROOT, file);
    stripComments(readFileSync(file, 'utf8')).forEach((rawLine, index) => {
      const line = rawLine.replace(UNRELATED_RECEIVERS, 'unrelated');
      const hit = FORBIDDEN.find(({ pattern }) => pattern.test(line));
      if (!hit) return;
      if (isOwner(relative)) {
        owners.add(OWNERS.find((owner) => isOwner(relative) && relative.startsWith(owner))!);
        return;
      }
      offenders.push(`${relative}:${index + 1}: ${rawLine.trim()}  — ${hit.why}`);
    });
  }
  return { offenders, owners };
};

describe('session turns have one read path and one write path', () => {
  it('has no materialized-history access outside lib/conversation-view', () => {
    expect(scan().offenders).toEqual([]);
  });

  it('keeps the owner list exact, so a stale exemption cannot widen', () => {
    expect([...scan().owners].sort()).toEqual([...OWNERS].sort());
  });
});
