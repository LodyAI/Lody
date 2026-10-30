import { Effect } from 'effect';
import type { InboxQueries } from '../inbox/queries';
import type { InboxSqlite } from '../inbox/sqlite';

export const makeInboxQueries = (sql: InboxSqlite): InboxQueries => {
  const io = <A>(f: () => A) => Effect.try({ try: f, catch: (cause) => cause });
  return {
    preferredHumanInput: (w, s) => io(() => sql.preferredHumanInput(w, s)),
    inputCancellationReason: (w, s, id) => io(() => sql.inputCancellationReason(w, s, id)),
    inputEnded: (w, s, id) => io(() => sql.inputEnded(w, s, id)),
    inputCanceled: (w, s, id) => io(() => sql.inputCanceled(w, s, id)),
    inputKind: (s, id) => io(() => sql.inputKind(s, id)),
    acceptedAutomationInput: (s, id) => io(() => sql.acceptedAutomationInput(s, id)),
    pauseTarget: (w, s, id) => io(() => sql.pauseTarget(w, s, id)),
  };
};
