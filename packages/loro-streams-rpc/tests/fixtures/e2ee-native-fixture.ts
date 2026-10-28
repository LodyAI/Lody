import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core/protocol';
import { makeRealtimeContentBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { copyEpochKeyBytes } from '../../../e2ee-core/src/internal/foundation/epoch-key';
import { envelopeFixture } from '../../../e2ee-core/test/keys/fixture';
import { makeE2eeRpcNative, E2eeRpcOriginals } from '../../src/e2ee-native';

/** Fixed synthetic ledger/signers and real host SQLite, never a keychain or network. */
export function encryptedRpcFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lody-rpc-'));
  const ledger = envelopeFixture(1);
  const machineId = 'fixture-machine';
  const workspaceId = 'synthetic-workspace';
  const native = (who: 'owner' | 'phone', filename = who) =>
    makeE2eeRpcNative({
      workspaceId,
      requesterDevice: Buffer.from(ledger[who].publicKey.toBytes()).toString('hex'),
      originals: new E2eeRpcOriginals(join(directory, `${filename}.sqlite`)),
      ledger: ledger.ledger,
      binding: (resource) =>
        makeRealtimeContentBinding({
          genesis: ledger.context.genesis,
          resource,
          signer: ledger[who].signer,
          ledger: ledger.ledger,
          readEpochKey: () =>
            Effect.sync(() => Result.getOrThrow(Bytes.epochKey(copyEpochKeyBytes(ledger.secret)))),
        }),
    });
  const input = {
    sessionId: 'synthetic-session',
    userTurnId: 'synthetic-turn',
    userId: 'display-account',
    timestamp: new Date(1000).toISOString(),
    inputConfig: { prompt: 'SYNTHETIC_PRIVATE_CANARY', cliType: 'codex' },
  };
  const ack = {
    type: 'session/dispatch-turn_response',
    sessionId: input.sessionId,
    userTurnId: input.userTurnId,
    accepted: true,
    disposition: 'accepted',
  } as const;
  return {
    directory,
    ledger,
    machineId,
    workspaceId,
    input,
    ack,
    native,
    sender: native('owner'),
    receiver: native('phone'),
    close: () => rmSync(directory, { force: true, recursive: true }),
  };
}
