import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Exit, Result } from 'effect';
import { InstalledKeyError } from '@lody/e2ee-core';
import { Bytes, ContentError, sealRpcRequestContent } from '@lody/e2ee-core/protocol';
import { e2eeRpcResource } from '@lody/loro-streams-rpc/e2ee-resource';
import { copyEpochKeyBytes } from '../../../../../packages/e2ee-core/src/internal/foundation/epoch-key';
import { encryptedRpcFixture } from '../../../../../packages/loro-streams-rpc/tests/fixtures/e2ee-native-fixture';
import { makeLedgerCatchUp, type LedgerCatchUpEvent } from './rpc-ledger-catch-up';

const fixtures: ReturnType<typeof encryptedRpcFixture>[] = [];
afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function machine(options: { error?: ContentError | InstalledKeyError } = {}) {
  const f = encryptedRpcFixture();
  fixtures.push(f);
  let catchUps = 0;
  const events: LedgerCatchUpEvent[] = [];
  const wrap = makeLedgerCatchUp({
    genesis: hex(f.ledger.context.genesis.toBytes()),
    resource: e2eeRpcResource,
    ledger: f.ledger.ledger,
    catchUp: async () => {
      catchUps++;
    },
    observe: (event) => events.push(event),
  });
  const open = wrap((_machineId: string, _frameHex: string) =>
    Effect.suspend(() => Effect.fail(options.error ?? new ContentError({ code: 'unauthorized' })))
  );
  const seal = (
    epoch: number,
    signer = f.ledger.owner.signer,
    scope: { genesis?: string; resource?: string } = {}
  ) =>
    Effect.runPromise(
      sealRpcRequestContent({
        scope: {
          genesis: scope.genesis ?? hex(f.ledger.context.genesis.toBytes()),
          resource: scope.resource ?? e2eeRpcResource(f.machineId),
          epoch,
        },
        epochKey: Result.getOrThrow(Bytes.epochKey(copyEpochKeyBytes(f.ledger.secret))),
        signer,
        plaintext: new Uint8Array([1, 2, 3]),
      })
    ).then(hex);
  return {
    f,
    open: (frameHex: string) => Effect.runPromiseExit(open(f.machineId, frameHex)),
    seal,
    events,
    catchUps: () => catchUps,
  };
}

describe('dispatch open after an epoch rotation', () => {
  it('does not refresh current-epoch missing-key requests with unauthenticated signatures', async () => {
    const m = machine({ error: new InstalledKeyError({ reason: 'missing-key' }) });
    const valid = Buffer.from(await m.seal(0), 'hex');
    const zero = hex(Buffer.concat([valid.subarray(0, -64), Buffer.alloc(64)]));
    const outsider = await m.seal(0, m.f.ledger.ed(50).signer);
    const wrongGenesis = await m.seal(0, undefined, { genesis: 'ff'.repeat(32) });
    const wrongResource = await m.seal(0, undefined, {
      resource: e2eeRpcResource('other-machine'),
    });
    for (let i = 0; i < 16; i++) {
      for (const frame of [zero, outsider, wrongGenesis, wrongResource])
        expect(Exit.isFailure(await m.open(frame))).toBe(true);
    }
    expect(m.catchUps()).toBe(0);
  });

  it('does not turn other installed-key failures into network recovery', async () => {
    const m = machine({ error: new InstalledKeyError({ reason: 'corrupt' }) });
    expect(Exit.isFailure(await m.open(await m.seal(1)))).toBe(true);
    expect(m.catchUps()).toBe(0);
  });

  it('never refreshes for unauthenticated high-epoch frames, however often replayed', async () => {
    const m = machine();
    const valid = Buffer.from(await m.seal(0xffffffff), 'hex');
    const zeroSignature = hex(Buffer.concat([valid.subarray(0, -64), Buffer.alloc(64)]));
    const outsider = await m.seal(0xffffffff, m.f.ledger.ed(50).signer);
    for (let replay = 0; replay < 16; replay++) {
      expect(Exit.isFailure(await m.open(zeroSignature))).toBe(true);
      expect(Exit.isFailure(await m.open(outsider))).toBe(true);
    }
    expect(m.catchUps()).toBe(0);
    expect(new Set(m.events.map((event) => event.outcome))).toEqual(new Set(['unauthenticated']));
  });
});
