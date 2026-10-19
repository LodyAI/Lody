import { Effect, Layer } from 'effect';
import { ExecutionJournal } from '../inbox/execution-owner';
import { INBOX_INLINE_MEMBERS } from '../inbox/model';
import type { InboxSqlite } from '../inbox/sqlite';

export const executionJournalLayer = (sql: InboxSqlite) => {
  const io = <A>(f: () => A) => Effect.try({ try: f, catch: (cause) => cause });
  return Layer.succeed(ExecutionJournal, {
    record: (i, id, identity) => io(() => sql.registerResources(i, id, identity)),
    confirm: (i, id) => io(() => sql.confirmReleased(i, id)),
    members: (batch) => io(() => sql.members(batch, 0, INBOX_INLINE_MEMBERS)),
    identity: (roots, complete) => ({
      platform: process.platform,
      roots: [...new Set([process.pid, ...roots])],
      complete,
    }),
  });
};
