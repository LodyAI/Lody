import { join } from 'node:path';
import { Effect } from 'effect';
import { Bytes } from '@lody/e2ee-core';
import type { LedgerView } from '@lody/e2ee-core';
import { makeLabCredentials } from '../src/platform/credentials';
import { makeLabHttpHost } from '../src/platform/host';
import { makeLabHttpIdentity } from '../src/platform/http-identity';
export { makeLabHttpIdentity } from '../src/platform/http-identity';
import type { LabMailboxHost } from '../src/platform/mailbox-http';
import type { makeLabJoinMailbox } from '../src/platform/join-mailbox';
import type { makeLabWorkspaceRegistry } from '../src/platform/workspace-registry';
import type { makeLabStreamReader } from '../src/platform/stream-read';
/** Real challenge/bearer HTTP, native Ed proofs and SQLite credentials. Account is
 * a synthetic label, global fetch is an explicit local transport capability, not
 * a product identity system or key custody. A private harness owns the workspace.
 * Raw credential fetch AND response body are retained by a scoped native owner. */
export function makeAuthenticatedLabMailbox(input: {
  readonly directory: string;
  readonly streams?: Effect.Success<ReturnType<typeof makeLabStreamReader>>;
  readonly workspaces?: Effect.Success<ReturnType<typeof makeLabWorkspaceRegistry>>;
  readonly mode: 'create' | 'open';
  readonly genesis: Bytes.GenesisHash;
  readonly ledger: () => Effect.Effect<LedgerView, never>;
  readonly mailbox?: LabMailboxHost;
  readonly joins?: Effect.Success<ReturnType<typeof makeLabJoinMailbox>>;
}) {
  return Effect.gen(function* () {
    const { directory, mode, genesis, ledger, mailbox, joins } = input;
    const credentials = yield* makeLabCredentials({
      path: join(directory, 'http-credentials.sqlite'),
      mode,
      now: () => 0,
      ledger: (anchor) => (anchor.equals(genesis) ? ledger() : Effect.fail('unknown Org')),
    });
    const host = yield* makeLabHttpHost({
      credentials,
      streams: (anchor) => (anchor.equals(genesis) ? input.streams : undefined),
      workspaces: input.workspaces,
      control: () => undefined,
      mailbox: (anchor) => (anchor.equals(genesis) ? mailbox : undefined),
      joins: (anchor) => (anchor.equals(genesis) ? joins : undefined),
    });
    return yield* makeLabHttpIdentity({ baseUrl: host.baseUrl, genesis });
  });
}
