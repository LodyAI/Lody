/**
 * Build a desensitized benchmark fixture from a real local Lody session doc.
 *
 *   pnpm --filter @lody/history-import bench:capture -- \
 *     --repo=~/.lody/loro-repo/<workspaceId>/repo.sqlite3 \
 *     --session=<sessionId> --out=/tmp/lody-conversation-fixture.json
 *
 * Without `--session` it picks the doc with the most message items, which is
 * the doc the "opening a long conversation freezes" reports are about.
 *
 * The output is derived from real conversation data even after desensitizing:
 * write it outside the repository and do not commit it.
 */

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { sessionDocSchema, type SessionHistoryInput, type SessionId } from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';

import { desensitizeHistory } from './desensitize';

function expandHome(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function readFlag(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function historyOf(snapshot: Uint8Array): SessionHistoryInput[] {
  const doc = new LoroDoc();
  doc.import(snapshot);
  const mirror = new Mirror({
    doc,
    schema: sessionDocSchema,
    ignoreUnknownProperties: true,
    initialState: { session: { id: 'fixture' as SessionId }, history: [] },
  });
  return (mirror.getState().history ?? []) as unknown as SessionHistoryInput[];
}

function countItems(history: readonly { items?: unknown }[]): number {
  let total = 0;
  for (const entry of history) if (Array.isArray(entry.items)) total += entry.items.length;
  return total;
}

function main(): void {
  const repoPath = readFlag('repo');
  const outPath = readFlag('out') ?? path.join(os.tmpdir(), 'lody-conversation-fixture.json');
  if (!repoPath) {
    console.error(
      'Usage: bench:capture -- --repo=~/.lody/loro-repo/<workspaceId>/repo.sqlite3 ' +
        '[--session=<sessionId>] [--out=<file.json>]'
    );
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseSync(expandHome(repoPath), { readOnly: true });
  try {
    const requested = readFlag('session');
    const docIds = requested
      ? [requested.startsWith('session-') ? requested : `session-${requested}`]
      : (
          db
            .prepare(
              "select doc_id from docs where doc_id like 'session-%' " +
                'order by length(snapshot) desc limit 40'
            )
            .all() as { doc_id: string }[]
        ).map((row) => row.doc_id);

    let best: { docId: string; history: SessionHistoryInput[]; items: number } | null = null;
    for (const docId of docIds) {
      const row = db.prepare('select snapshot from docs where doc_id = ?').get(docId) as
        | { snapshot: Uint8Array }
        | undefined;
      if (!row?.snapshot) continue;
      const history = historyOf(new Uint8Array(row.snapshot));
      const items = countItems(history);
      if (!best || items > best.items) best = { docId, history, items };
    }
    if (!best) {
      throw new Error(`No session doc found in ${repoPath}`);
    }

    const desensitized = desensitizeHistory(best.history);
    writeFileSync(expandHome(outPath), JSON.stringify(desensitized), 'utf8');
    console.log(
      JSON.stringify(
        {
          sourceDocId: best.docId,
          turns: desensitized.length,
          messageItems: best.items,
          out: expandHome(outPath),
        },
        null,
        2
      )
    );
  } finally {
    db.close();
  }
}

main();
