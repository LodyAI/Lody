import { Effect } from 'effect';
import { DeviceSigner, JournalStore, LedgerTransport } from '../ports/ledger';
import type { GenesisHash } from '../pure/bytes';
import type { LedgerCommand } from '../pure/commands';
import type { ClientError } from '../pure/errors';
import { LedgerEngine, type SnapshotBootstrap } from './ledger-engine';

export type { CommandOutcome, ResumeOutcome, SnapshotBootstrap } from './ledger-engine';
type Dependencies = JournalStore | LedgerTransport | DeviceSigner;

/** Safe intent API. The single engine also serves the temporary Promise adapter. */
export class LedgerClient {
  private constructor(
    private readonly engine: LedgerEngine,
    private readonly signer: DeviceSigner['Type']
  ) {}

  private static bind(
    engine: Effect.Effect<LedgerEngine, ClientError, JournalStore | LedgerTransport>
  ): Effect.Effect<LedgerClient, ClientError, Dependencies> {
    return Effect.gen(function* () {
      const signer = yield* DeviceSigner;
      return new LedgerClient(yield* engine, signer);
    });
  }

  static create(input: { readonly anchor: GenesisHash; readonly genesisRecord: Uint8Array }) {
    return LedgerClient.bind(LedgerEngine.create(input));
  }

  static restore(anchor: GenesisHash) {
    return LedgerClient.bind(LedgerEngine.restore(anchor));
  }

  static createFromSnapshot(input: SnapshotBootstrap) {
    return LedgerClient.bind(LedgerEngine.createFromSnapshot(input));
  }

  execute(command: LedgerCommand) {
    return this.engine.execute(command, this.signer);
  }
  refresh() {
    return this.engine.refresh();
  }
  resume() {
    return this.engine.resume(this.signer.publicKey);
  }
}
