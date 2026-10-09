import { Context, Effect } from 'effect';
import type { ClientError } from '@lody/e2ee-core/effect';
import type { LedgerClient, Operation } from '@lody/e2ee-core/ledger';
import { ledgerCommand } from '../pure/ledger-command';

/** Platform owns the SDK client and its per-session verification cache. */
export class SessionLedger extends Context.Service<
  SessionLedger,
  {
    readonly open: Effect.Effect<LedgerClient, ClientError | Error>;
  }
>()('lody/e2ee-lab/SessionLedger') {}

export const readSessionLedger = Effect.gen(function* () {
  const service = yield* SessionLedger;
  const client = yield* service.open;
  return yield* client.readEffect();
});

export const resumeSessionLedger = Effect.gen(function* () {
  const service = yield* SessionLedger;
  const client = yield* service.open;
  return yield* client.resumeEffect();
});

export function executeSessionOperation(operation: Operation) {
  const command = ledgerCommand(operation);
  return Effect.gen(function* () {
    const intent = yield* Effect.fromResult(command);
    const service = yield* SessionLedger;
    const client = yield* service.open;
    return yield* client.executeEffect(intent);
  });
}
