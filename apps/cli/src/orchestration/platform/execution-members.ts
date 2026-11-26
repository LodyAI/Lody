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
    sources: (batch) =>
      Effect.try({ try: () => sql.memberSources(batch), catch: (cause) => cause }),
    narrow: (batch, executionId, drop) =>
      Effect.try({ try: () => sql.narrow(batch, executionId, drop), catch: (cause) => cause }),
  });
