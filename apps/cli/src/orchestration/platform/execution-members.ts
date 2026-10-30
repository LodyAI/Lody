import { Effect, Layer } from 'effect';
import { ExecutionMembers } from '../inbox/execution-owner';
import { INBOX_INLINE_MEMBERS } from '../inbox/model';
import type { InboxSqlite } from '../inbox/sqlite';

export const executionMembersLayer = (sql: InboxSqlite) =>
  Layer.succeed(ExecutionMembers, {
    members: (batch) =>
      Effect.try({
        try: () => sql.members(batch, 0, INBOX_INLINE_MEMBERS),
        catch: (cause) => cause,
      }),
  });
