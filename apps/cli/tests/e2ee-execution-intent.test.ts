import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Effect, Result } from 'effect';
import { LoroDoc, LoroMap } from 'loro-crdt';
import { Bytes, signExecutionIntent } from '@lody/e2ee-core/protocol';
import { E2EE_INTENT_KIND, encodeE2eeIntentRecord, turnExecutionDigest } from '@lody/shared';
import { makeVerifiedExecutionIntent } from '../src/lib/e2ee/execution-intent-verification';

const genesis = Result.getOrThrow(Bytes.genesisHash(new Uint8Array(32).fill(0x11)));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
/** A real Ed25519 device, as custody would provide it. */
const device = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const key = Result.getOrThrow(Bytes.signingPublicKey(new Uint8Array(raw)));
  return {
    publicKey: key,
    sign: (message: Uint8Array) =>
      Effect.succeed(Result.getOrThrow(Bytes.signature(sign(null, message, privateKey)))),
  };
};
const machine = device();
const member = device();
const outsider = device();
const config = { prompt: 'Synthetic member input', cliType: 'builtin', agentType: 'codex' };
const intent = {
  workspaceId: 'workspace',
  sessionId: 'session',
  userTurnId: 'turn',
  inputConfig: config,
};

const signRow = async (
  signer: ReturnType<typeof device>,
  overrides: { targetMachineId?: string; inputConfig?: unknown } = {}
) =>
  encodeE2eeIntentRecord({
    kind: E2EE_INTENT_KIND.memberInput,
    signer: signer.publicKey.toBytes(),
    signature: (
      await Effect.runPromise(
        signExecutionIntent({
          kind: E2EE_INTENT_KIND.memberInput,
          genesis,
          workspaceId: 'workspace',
          targetMachineId: overrides.targetMachineId ?? 'machine',
          scope: 'session',
          messageId: 'turn',
          contentDigest: Buffer.from(
            turnExecutionDigest({ inputConfig: overrides.inputConfig ?? config })!,
            'hex'
          ),
          signer,
        })
      )
    ).toBytes(),
  });

const documentWith = (row: Record<string, unknown>) => {
  const doc = new LoroDoc();
  const map = doc.getList('history').insertContainer(0, new LoroMap());
  for (const [key, value] of Object.entries({
    id: 'turn',
    role: 'user',
    inputConfig: config,
    ...row,
  }))
    map.set(key, value);
  doc.commit();
  return doc;
};

const verifier = (options: { members?: boolean; refresh?: 'ok' | 'down' } = {}) => {
  let refreshed = 0;
  const devices = new Map([
    [
      hex(machine.publicKey.toBytes()),
      { machineId: 'machine', membershipId: { toBytes: () => Uint8Array.of(1) } },
    ],
    [hex(member.publicKey.toBytes()), { membershipId: { toBytes: () => Uint8Array.of(2) } }],
  ]);
  const members = new Map([
    ...[['01', { userId: { toBytes: () => new Uint8Array(32).fill(0xaa) } }] as const],
    ...(options.members === false
      ? []
      : [['02', { userId: { toBytes: () => new Uint8Array(32).fill(0xcc) } }] as const]),
  ]);
  const resolve = makeVerifiedExecutionIntent({
    workspaceId: 'workspace',
    genesis,
    selfDevice: hex(machine.publicKey.toBytes()),
    isClosed: () => false,
    readIncoming: () => Effect.succeed(undefined),
    openDispatch: () => Effect.die('no realtime request'),
    ledger: () =>
      Effect.succeed({
        inspectState: () => ({
          devices,
          members,
        }),
      }),
    refreshLedger: Effect.suspend(() => {
      refreshed += 1;
      return options.refresh === 'down' ? Effect.fail(new Error('unavailable')) : Effect.void;
    }),
  });
  return { resolve, refreshed: () => refreshed };
};

describe('encrypted execution intent verification', () => {
  it('runs a turn as the device that signed it, even from a snapshot', async () => {
    const doc = documentWith({ e2eeIntent: await signRow(member), userId: 'display-only' });
    const snapshot = new LoroDoc();
    snapshot.import(doc.export({ mode: 'snapshot' }));
    for (const source of [doc, snapshot])
      expect(await Effect.runPromise(verifier().resolve(intent, source))).toEqual({
        requesterDevice: hex(member.publicKey.toBytes()),
        requesterCryptoUserId: 'cc'.repeat(32),
      });
  });

  it('refuses a missing, altered or misdirected signature with its own reason', async () => {
    const { resolve } = verifier();
    expect(await Effect.runPromise(resolve(intent, documentWith({})))).toEqual({
      state: 'refused',
      reason: 'e2ee_signature_missing',
    });
    const signed = documentWith({ e2eeIntent: await signRow(member) });
    expect(
      await Effect.runPromise(
        resolve({ ...intent, inputConfig: { ...config, modelId: 'other' } }, signed)
      )
    ).toEqual({ state: 'refused', reason: 'e2ee_signature_invalid' });
    const elsewhere = documentWith({
      e2eeIntent: await signRow(member, { targetMachineId: 'other' }),
    });
    expect(await Effect.runPromise(resolve(intent, elsewhere))).toEqual({
      state: 'refused',
      reason: 'e2ee_signature_invalid',
    });
  });

  it('refuses a signer outside the ledger only after a confirmed read, and waits otherwise', async () => {
    const doc = documentWith({ e2eeIntent: await signRow(outsider) });
    const confirmed = verifier();
    expect(await Effect.runPromise(confirmed.resolve(intent, doc))).toEqual({
      state: 'refused',
      reason: 'e2ee_sender_not_authorized',
    });
    expect(confirmed.refreshed()).toBe(1);
    const down = verifier({ refresh: 'down' });
    expect(await Effect.runPromise(down.resolve(intent, doc))).toEqual({
      state: 'pending-evidence',
    });
    const removed = verifier({ members: false });
    expect(
      await Effect.runPromise(
        removed.resolve(intent, documentWith({ e2eeIntent: await signRow(member) }))
      )
    ).toEqual({ state: 'refused', reason: 'e2ee_sender_not_authorized' });
  });

  it('refuses a derived input that this machine did not sign', async () => {
    const doc = documentWith({
      e2eeIntent: await signRow(member),
      derivedFrom: { sessionId: 'origin', userTurnId: 'origin-turn' },
    });
    expect(await Effect.runPromise(verifier().resolve(intent, doc))).toEqual({
      state: 'refused',
      reason: 'e2ee_signature_invalid',
    });
  });
});
