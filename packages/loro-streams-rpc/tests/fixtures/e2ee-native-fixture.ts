import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Result } from 'effect';
import { Bytes } from '@lody/e2ee-core/protocol';
import { makeRealtimeContentBinding } from '@lody/e2ee-core/adapters/loro-streams';
import { copyEpochKeyBytes } from '../../../e2ee-core/src/internal/foundation/epoch-key';
import { envelopeFixture } from '../../../e2ee-core/test/keys/fixture';
import { encodeCbor } from '../../../e2ee-core/src/internal/foundation/cbor';
import { makeE2eeRpcNative, E2eeRpcOriginals } from '../../src/e2ee-native';

/** Fixed synthetic ledger/signers and real host SQLite, never a keychain or network. */
export function encryptedRpcFixture(options: { guest?: boolean; teammate?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lody-rpc-'));
  const ledger = envelopeFixture(1);
  // Another member's personal device: its dispatch depends on the machine sharing policy.
  const teammate = ledger.ed(13);
  if (options.teammate) {
    const membership = new Uint8Array(16).fill(13);
    const request = [
      membership,
      new Uint8Array(32).fill(13),
      teammate.raw,
      new Uint8Array(32).fill(13),
      null,
    ] as const;
    const body = Result.getOrThrow(encodeCbor([ledger.context.genesis.toBytes(), ...request]));
    const proof = teammate.signBytes(Buffer.concat([Buffer.from('lody-e2ee/join/v1\0'), body]));
    ledger.append([1, membership, [...request, proof]]);
  }
  if (options.guest) {
    // Retain an independent admin before demoting the original member and its
    // already-admitted machine. These are real signed and verified ledger rows.
    const admin = ledger.ed(12);
    const membership = new Uint8Array(16).fill(12);
    const request = [
      membership,
      new Uint8Array(32).fill(12),
      admin.raw,
      new Uint8Array(32).fill(12),
      null,
    ] as const;
    const body = Result.getOrThrow(encodeCbor([ledger.context.genesis.toBytes(), ...request]));
    const proof = admin.signBytes(Buffer.concat([Buffer.from('lody-e2ee/join/v1\0'), body]));
    ledger.append([1, membership, [...request, proof]]);
    ledger.append([3, membership, 1]);
    ledger.append([6, membership]);
    ledger.append([3, new Uint8Array(16).fill(10), 3], admin);
  }
  const machineId = 'fixture-machine';
  const workspaceId = 'synthetic-workspace';
  const native = (
    who: 'owner' | 'phone' | 'teammate',
    filename: string = who,
    authorizeTarget?: (machineId: string) => Effect.Effect<boolean, unknown>
  ) =>
    makeE2eeRpcNative({
      workspaceId,
      requesterDevice: Buffer.from(
        (who === 'teammate' ? teammate : ledger[who]).publicKey.toBytes()
      ).toString('hex'),
      originals: new E2eeRpcOriginals(join(directory, `${filename}.sqlite`)),
      ...(authorizeTarget ? { authorizeTarget } : {}),
      ledger: ledger.ledger,
      binding: (resource) =>
        makeRealtimeContentBinding({
          genesis: ledger.context.genesis,
          resource,
          signer: (who === 'teammate' ? teammate : ledger[who]).signer,
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
